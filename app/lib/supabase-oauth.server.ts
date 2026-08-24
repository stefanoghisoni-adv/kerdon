import { prisma } from '~/db.server';
import { encrypt, decrypt } from '~/utils/crypto.server';
import { refreshAccessToken } from './supabase-management.server';

// La firma del `state` non ha niente di Supabase: la usa anche Meta, e ogni
// piattaforma che arrivera'. Vive in un file suo; qui resta il ri-esporto,
// perche' e' da qui che se lo aspettano le rotte e i test di allora.
export { signState, verifyState } from './oauth-state.server';

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
