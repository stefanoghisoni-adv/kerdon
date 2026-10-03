import { prisma } from '~/db.server';
import { encrypt, decrypt } from '~/utils/crypto.server';
import { refreshTokens, revokeToken, type TokenSet } from './klaviyo/oauth.server';
import { KlaviyoAuthError, KlaviyoUnavailableError } from './klaviyo/api.server';

/**
 * L'archivio delle connessioni alle integrazioni, oggi solo Klaviyo.
 *
 * Il rinnovo del token segue lo schema di `supabase-oauth.server.ts`
 * (`getValidAccessToken`), dove il perche' e' spiegato per esteso: tre difese
 * per tre tratti diversi della stessa corsa.
 *
 *   1. `refreshInFlight` — le richieste nello stesso processo si attaccano
 *      alla stessa promessa.
 *   2. `takeTurn` — fra istanze diverse il turno si prende sul database con
 *      `updatedAt` come guardia: una sola vince, le altre aspettano il token
 *      che quella pubblica.
 *   3. la rilettura dopo un errore — se il rinnovo fallisce ma nel frattempo
 *      qualcuno ha salvato un token buono, l'errore era una corsa persa.
 *
 * Klaviyo oggi non ruota il refresh token a ogni uso, ma limita il rinnovo a
 * 10 chiamate al minuto: anche senza rotazione, rinnovare una volta sola e'
 * quel che serve.
 */
const PROVIDER = 'klaviyo';

/** Il margine con cui un token si considera gia' scaduto. */
const SKEW_MS = 60_000;
/** Per quanto la riga appena toccata vale come turno di qualcun altro. */
const TURN_TTL_MS = 10_000;
const WAIT_STEP_MS = 100;
const WAIT_MAX_MS = 3_000;

const refreshInFlight = new Map<string, Promise<string>>();

function key(shopId: string) {
  return { shopId_provider: { shopId, provider: PROVIDER } };
}

function stillGood(expiresAt: Date | null, now = Date.now()): boolean {
  return !!expiresAt && expiresAt.getTime() - SKEW_MS > now;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function saveConnection(
  shopId: string,
  tokens: TokenSet,
  accountName: string | null,
): Promise<void> {
  const data = {
    accessToken: encrypt(tokens.accessToken),
    refreshToken: encrypt(tokens.refreshToken),
    expiresAt: tokens.expiresAt,
    accountName,
    status: 'connected',
  };
  await prisma.integrationConnection.upsert({
    where: key(shopId),
    create: { shopId, provider: PROVIDER, ...data },
    update: data,
  });
}

interface TokenRow {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  updatedAt: Date;
}

export async function getAccessToken(shopId: string): Promise<string> {
  const row = await prisma.integrationConnection.findUnique({ where: key(shopId) });
  if (!row || row.status !== 'connected' || !row.accessToken || !row.refreshToken) {
    throw new KlaviyoAuthError('Klaviyo non collegato per questo negozio');
  }
  if (stillGood(row.expiresAt)) return decrypt(row.accessToken);

  const inFlight = refreshInFlight.get(shopId);
  if (inFlight) return inFlight;

  const run = refresh(shopId, {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
  });
  refreshInFlight.set(shopId, run);
  try {
    return await run;
  } finally {
    // Sempre, anche dopo un errore: una promessa fallita lasciata qui terrebbe
    // fermo il negozio fino al riavvio dell'istanza.
    refreshInFlight.delete(shopId);
  }
}

async function refresh(shopId: string, row: TokenRow): Promise<string> {
  if (!(await takeTurn(shopId, row.updatedAt, Date.now()))) {
    // Il turno e' di un altro: si aspetta il suo token invece di spendere il
    // refresh token una seconda volta.
    const theirs = await waitForNewToken(shopId);
    if (theirs) return theirs;
    // Nessun token entro l'attesa: passeggero, la richiesta dopo riprende il
    // turno sulla riga cambiata. Non e' un motivo per chiedere di ricollegare.
    throw new KlaviyoUnavailableError('Rinnovo del token Klaviyo gia in corso');
  }

  let tokens: TokenSet;
  try {
    tokens = await refreshTokens(decrypt(row.refreshToken));
  } catch (e) {
    const saved = await validSavedToken(shopId);
    if (saved) return saved;
    // Solo un no di Klaviyo sulla credenziale chiede di ricollegare: un 5xx o
    // la rete giu' restano un guasto passeggero.
    if (e instanceof KlaviyoAuthError) {
      await markNeedsReconnect(shopId);
    }
    throw e;
  }

  await prisma.integrationConnection.updateMany({
    where: { shopId, provider: PROVIDER },
    data: {
      accessToken: encrypt(tokens.accessToken),
      refreshToken: encrypt(tokens.refreshToken),
      expiresAt: tokens.expiresAt,
    },
  });
  return tokens.accessToken;
}

/**
 * Il turno per rinnovare, con `updatedAt` come guardia e come scadenza: si
 * scrive solo se la riga e' quella letta, e una riga toccata da meno di
 * `TURN_TTL_MS` vale come turno di qualcun altro. Nessun turno resta bloccato:
 * dieci secondi dopo la presa la riga torna prendibile.
 */
async function takeTurn(shopId: string, updatedAt: Date, now: number): Promise<boolean> {
  if (now - updatedAt.getTime() < TURN_TTL_MS) return false;
  const res = await prisma.integrationConnection.updateMany({
    where: { shopId, provider: PROVIDER, updatedAt },
    data: { updatedAt: new Date(now) },
  });
  return res.count === 1;
}

async function validSavedToken(shopId: string): Promise<string | null> {
  const row = await prisma.integrationConnection.findUnique({ where: key(shopId) });
  if (!row || row.status !== 'connected' || !row.accessToken || !stillGood(row.expiresAt)) {
    return null;
  }
  return decrypt(row.accessToken);
}

async function waitForNewToken(shopId: string): Promise<string | null> {
  const deadline = Date.now() + WAIT_MAX_MS;
  while (Date.now() < deadline) {
    await wait(WAIT_STEP_MS);
    const token = await validSavedToken(shopId);
    if (token) return token;
  }
  return null;
}

export async function markNeedsReconnect(shopId: string): Promise<void> {
  await prisma.integrationConnection.updateMany({
    where: { shopId, provider: PROVIDER },
    data: { status: 'needs_reconnect' },
  });
}

/** La riga resta: tiene il nome dell'account e la storia del collegamento. */
export async function disconnect(shopId: string): Promise<void> {
  const row = await prisma.integrationConnection.findUnique({ where: key(shopId) });
  if (!row) return;
  if (row.refreshToken) {
    try {
      await revokeToken(decrypt(row.refreshToken));
    } catch {
      // Best effort: un token illeggibile non deve impedire di scollegare.
    }
  }
  await prisma.integrationConnection.updateMany({
    where: { shopId, provider: PROVIDER },
    data: { accessToken: null, refreshToken: null, expiresAt: null, status: 'disconnected' },
  });
}

export async function connectionStatus(shopId: string): Promise<{
  status: 'connected' | 'needs_reconnect' | 'disconnected' | 'none';
  accountName: string | null;
}> {
  const row = await prisma.integrationConnection.findUnique({ where: key(shopId) });
  if (!row) return { status: 'none', accountName: null };
  const status =
    row.status === 'connected' || row.status === 'needs_reconnect' ? row.status : 'disconnected';
  return { status, accountName: row.accountName };
}
