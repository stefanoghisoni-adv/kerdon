import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Il `state` di un giro OAuth: chi ha cominciato, e quando scade.
 *
 * Non c'e' nessuna tabella e nessun cookie. Il valore si porta dentro il
 * negozio che ha avviato l'autorizzazione, firmato con il segreto dell'app:
 * chi torna dalla piattaforma non puo' cambiarlo senza invalidare la firma, e
 * la pagina di ritorno — che vive fuori dall'admin di Shopify e quindi non ha
 * una sessione — sa comunque di chi si tratta.
 *
 * Vale dieci minuti: e' il tempo di un'autorizzazione, non di una sessione.
 * Serve a un giro solo, e uno vecchio ritrovato in cronologia non deve poter
 * collegare niente.
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
