/**
 * La revisione delle API Klaviyo su cui e' scritto il connettore.
 *
 * Klaviyo versiona per data e manda la revisione in un header: fissarla qui
 * vuol dire che un cambio di Klaviyo non ci arriva addosso finche' non la
 * spostiamo noi. 2026-07-15 e' l'ultima stabile (non `.pre`) al 2026-10-03.
 */
export const KLAVIYO_REVISION = '2026-07-15';

/** Solo lettura: il connettore legge profili e nome dell'account, nient'altro. */
export const KLAVIYO_SCOPES = 'profiles:read accounts:read';

export function klaviyoCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.KLAVIYO_CLIENT_ID;
  const clientSecret = process.env.KLAVIYO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Integrazione Klaviyo non configurata: mancano KLAVIYO_CLIENT_ID o KLAVIYO_CLIENT_SECRET');
  }
  return { clientId, clientSecret };
}

export function klaviyoRedirectUri(): string {
  const base = process.env.SHOPIFY_APP_URL;
  if (!base) throw new Error('SHOPIFY_APP_URL non configurato');
  return `${base.replace(/\/+$/, '')}/auth/klaviyo/callback`;
}
