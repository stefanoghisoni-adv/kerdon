import { prisma } from '~/db.server';
import { decrypt, encrypt } from '~/utils/crypto.server';

/**
 * L'autorizzazione a Meta.
 *
 * Stessa forma di quella a Supabase — finestra, `state` firmato, scambio del
 * codice — con una differenza che cambia le regole del gioco: **Meta non da' un
 * refresh token**. Da' un token a lunga durata, circa sessanta giorni, che si
 * rinnova scambiandolo con se stesso finche' e' ancora valido. Se scade prima
 * che qualcuno lo rinnovi, non c'e' modo di recuperarlo da soli: il merchant
 * deve riautorizzare. Per questo la scadenza si guarda prima di ogni invio e
 * non solo il giorno del collegamento.
 */

/**
 * La versione delle API di Meta.
 *
 * In una variabile d'ambiente perche' Meta le manda in pensione a scadenza:
 * quando succede si cambia una riga di configurazione, non si rilascia l'app.
 */
function apiVersion(): string {
  return process.env.META_API_VERSION || 'v23.0';
}

/**
 * I permessi che chiediamo.
 *
 * `ads_management` per leggere gli account pubblicitari e mandare eventi al
 * pixel, `business_management` per vedere a quale portfolio appartengono. Non
 * chiediamo altro: ogni permesso in piu' e' una domanda in piu' nella
 * schermata di autorizzazione, e una cosa in piu' da giustificare alla revisione
 * di Meta.
 */
const SCOPES = ['ads_management', 'business_management'];

export interface MetaCredentials {
  appId: string;
  appSecret: string;
}

/** Le credenziali dell'app Meta, se ci sono. */
export function metaCredentials(): MetaCredentials | null {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

/** L'indirizzo a cui Meta rimanda dopo l'autorizzazione. */
export function metaRedirectUri(): string {
  return `${process.env.SHOPIFY_APP_URL ?? ''}/auth/meta/callback`;
}

export function buildMetaAuthorizeUrl(params: {
  appId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(`https://www.facebook.com/${apiVersion()}/dialog/oauth`);
  url.searchParams.set('client_id', params.appId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(','));
  return url.toString();
}

interface MetaTokenResponse {
  access_token: string;
  /** Meta lo omette per i token che non scadono mai: sono l'eccezione. */
  expires_in?: number;
}

async function tokenRequest(url: URL): Promise<MetaTokenResponse> {
  const res = await fetch(url.toString());
  if (!res.ok) {
    // Il corpo dice il motivo vero: senza, un 400 di Meta e' indistinguibile da
    // un altro, e la diagnosi finisce a indovinare.
    const detail = await res.text().catch(() => '');
    throw new Error(`Meta token error: ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  const body = (await res.json()) as MetaTokenResponse;
  if (!body.access_token) throw new Error('Meta token error: risposta senza access_token');
  return body;
}

/** Il codice che torna dalla finestra diventa un token di breve durata. */
export function exchangeMetaCode(params: {
  code: string;
  redirectUri: string;
  credentials: MetaCredentials;
}): Promise<MetaTokenResponse> {
  const url = new URL(`https://graph.facebook.com/${apiVersion()}/oauth/access_token`);
  url.searchParams.set('client_id', params.credentials.appId);
  url.searchParams.set('client_secret', params.credentials.appSecret);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('code', params.code);
  return tokenRequest(url);
}

/**
 * Da token di breve durata a token di lunga durata.
 *
 * Lo stesso scambio serve anche a rinnovare: un token lungo ancora valido,
 * riscambiato, torna con una scadenza nuova. E' l'unico modo che Meta offre per
 * restare collegati senza far riautorizzare il merchant.
 */
export function exchangeForLongLivedToken(params: {
  token: string;
  credentials: MetaCredentials;
}): Promise<MetaTokenResponse> {
  const url = new URL(`https://graph.facebook.com/${apiVersion()}/oauth/access_token`);
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', params.credentials.appId);
  url.searchParams.set('client_secret', params.credentials.appSecret);
  url.searchParams.set('fb_exchange_token', params.token);
  return tokenRequest(url);
}

/**
 * Quanto dura un token quando Meta non lo dice.
 *
 * Succede per i token che Meta considera senza scadenza. Segnarli come eterni
 * sarebbe comodo e sbagliato — un permesso revocato li spegne comunque — quindi
 * si segnano a sessanta giorni: si rinnoveranno come gli altri.
 */
const DEFAULT_TTL_SECONDS = 60 * 24 * 60 * 60;

export async function saveMetaToken(
  shopId: string,
  token: MetaTokenResponse,
): Promise<void> {
  const expiresAt = new Date(Date.now() + (token.expires_in ?? DEFAULT_TTL_SECONDS) * 1000);
  const accessToken = encrypt(token.access_token);

  await prisma.metaConnection.upsert({
    where: { shopId },
    create: { shopId, accessToken, expiresAt },
    // Riautorizzando si sostituisce il token e si tiene la scelta di account e
    // pixel: rifarla ogni volta che il token scade sarebbe una punizione per
    // qualcosa che non dipende dal merchant.
    update: { accessToken, expiresAt },
  });
}

/**
 * Il token da usare adesso, rinnovato se sta per scadere.
 *
 * Il margine e' di sette giorni e non di un minuto come per Supabase: qui il
 * rinnovo non e' una formalita' ma una chiamata che puo' fallire, e restare
 * senza token significa far riautorizzare il merchant. Sette giorni danno molte
 * occasioni di riprovare prima che sia troppo tardi.
 */
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

export async function getValidMetaToken(shopId: string): Promise<string> {
  const row = await prisma.metaConnection.findUnique({ where: { shopId } });
  if (!row) throw new Error('Meta non collegato per questo negozio');

  if (row.expiresAt.getTime() - RENEW_BEFORE_MS > Date.now()) {
    return decrypt(row.accessToken);
  }

  const credentials = metaCredentials();
  if (!credentials) throw new Error('Integrazione Meta non configurata');

  const renewed = await exchangeForLongLivedToken({
    token: decrypt(row.accessToken),
    credentials,
  });
  await saveMetaToken(shopId, renewed);
  return renewed.access_token;
}
