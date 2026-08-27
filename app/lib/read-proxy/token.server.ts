import crypto from 'crypto';
import { prisma } from '~/db.server';
import { encrypt, decrypt } from '~/utils/crypto.server';

const TOKEN_PREFIX = 'spx_';

// Token di lettura per-shop: prefisso identificativo + 32 byte casuali base64url.
export function generateReadProxyToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

// Solo l'hash viene persistito e indicizzato: il lookup dal token è O(1) e il
// token in chiaro non è mai salvato nel DB.
export function hashReadProxyToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// I container server-side inviano lo stesso valore sia in Authorization: Bearer
// sia nell'header
// apikey: leggiamo il primo, con ripiego sul secondo.
export function extractReadProxyToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) {
    const t = auth.replace(/^Bearer\s+/i, '').trim();
    if (t) return t;
  }
  const apikey = request.headers.get('apikey');
  return apikey && apikey.trim() ? apikey.trim() : null;
}

// Genera un nuovo token, salva hash + cifrato e ritorna il token in chiaro
// (mostrabile una volta / rileggibile dal cifrato). Invalida il precedente.
export async function issueReadProxyToken(shopId: string): Promise<string> {
  const token = generateReadProxyToken();
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      readProxyTokenHash: hashReadProxyToken(token),
      readProxyTokenEnc: encrypt(token),
    },
  });
  return token;
}

export function getReadProxyTokenForDisplay(
  shop: { readProxyTokenEnc: string | null },
): string | null {
  if (!shop.readProxyTokenEnc) return null;
  try {
    return decrypt(shop.readProxyTokenEnc);
  } catch {
    return null;
  }
}
