import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '~/db.server';
import { encrypt, decrypt } from '~/utils/crypto.server';
import { refreshAccessToken } from './supabase-management.server';

/**
 * Il `state` di un giro OAuth: chi ha cominciato, e quando scade.
 *
 * Non c'e' nessuna tabella e nessun cookie. Il valore si porta dentro il
 * negozio che ha avviato l'autorizzazione, firmato con il segreto dell'app: la
 * pagina di ritorno vive fuori dall'admin di Shopify e non ha una sessione, ma
 * sa comunque di chi si tratta, e chi torna non puo' cambiarlo senza
 * invalidare la firma.
 *
 * Vale dieci minuti: e' il tempo di un'autorizzazione, non di una sessione.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error('ENCRYPTION_SECRET non configurato');
  return secret;
}

export function signState(shopId: string, now: number = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ shopId, exp: now + STATE_TTL_MS }),
  ).toString('base64url');
  const sig = createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyState(
  state: string,
  now: number = Date.now(),
): { shopId: string } | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = createHmac('sha256', stateSecret()).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  // Il confronto a tempo costante non basta se le lunghezze differiscono:
  // timingSafeEqual lancerebbe, e un'eccezione qui sarebbe gia' una risposta.
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      shopId?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.shopId !== 'string' || typeof parsed.exp !== 'number') return null;
    if (now > parsed.exp) return null;
    return { shopId: parsed.shopId };
  } catch {
    return null;
  }
}

export async function saveTokens(
  shopId: string,
  t: { access_token: string; refresh_token: string; expires_in: number },
): Promise<void> {
  const expiresAt = new Date(Date.now() + t.expires_in * 1000);
  const data = {
    accessToken: encrypt(t.access_token),
    refreshToken: encrypt(t.refresh_token),
    expiresAt,
  };
  await prisma.supabaseOAuthToken.upsert({
    where: { shopId },
    create: { shopId, ...data },
    update: data,
  });
}

export async function getValidAccessToken(shopId: string): Promise<string> {
  const row = await prisma.supabaseOAuthToken.findUnique({ where: { shopId } });
  if (!row) throw new Error('Supabase non collegato per questo shop');

  const skewMs = 60_000;
  if (row.expiresAt.getTime() - skewMs > Date.now()) {
    return decrypt(row.accessToken);
  }

  const clientId = process.env.SUPABASE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.SUPABASE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Integrazione Supabase non configurata');
  }

  const refreshed = await refreshAccessToken({
    refreshToken: decrypt(row.refreshToken),
    clientId,
    clientSecret,
  });
  await saveTokens(shopId, refreshed);
  return refreshed.access_token;
}
