import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { dictionaryForShop } from '~/lib/i18n/server';
import { verifyState, saveTokens } from '~/lib/supabase-oauth.server';
import { exchangeCode } from '~/lib/supabase-management.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';

/**
 * Il completamento del collegamento a Supabase, dalla finestra dell'app.
 *
 * La pagina di ritorno (`auth.supabase.callback`) consegna codice e stato con
 * `postMessage`; qui arrivano con la sessione dell'admin. Lo `state` dice quale
 * negozio ha avviato il giro, la sessione dice quale negozio lo sta
 * completando: se non coincidono ci si ferma PRIMA di scambiare il codice. E'
 * questo controllo che impedisce a un link di autorizzazione girato da un
 * negozio a un altro di collegare l'account Supabase sbagliato.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    return json({ ok: false, error: 'Shop non trovato' }, { status: 404 });
  }
  if (!can(await shopCapabilities(shop), 'use_app')) {
    return json(
      {
        ok: false,
        error: (await dictionaryForShop(session.shop)).errors.suspended,
        code: 'not_authorized',
      },
      { status: 403 },
    );
  }

  let body: { code?: unknown; state?: unknown };
  try {
    body = (await request.json()) as { code?: unknown; state?: unknown };
  } catch {
    return json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const { code, state } = body ?? {};
  if (typeof code !== 'string' || !code || typeof state !== 'string' || !state) {
    return json({ ok: false, error: 'missing_params' }, { status: 400 });
  }

  // Firma e scadenza: uno stato manomesso o vecchio non vale niente.
  const verified = verifyState(state);
  if (!verified) {
    return json({ ok: false, error: 'expired' }, { status: 400 });
  }

  // Il giro deve essere del negozio di questa sessione. Altrimenti si rifiuta
  // SENZA scambiare il codice: nessun token di un altro account entra qui.
  if (verified.shopId !== shop.id) {
    return json({ ok: false, error: 'shop_mismatch' }, { status: 403 });
  }

  const clientId = process.env.SUPABASE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.SUPABASE_OAUTH_CLIENT_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!clientId || !clientSecret || !appUrl) {
    console.error('[supabase connect] integrazione non configurata');
    return json({ ok: false, error: 'not_configured' }, { status: 500 });
  }

  try {
    const tokens = await exchangeCode({
      code,
      clientId,
      clientSecret,
      // Identico a quello dell'autorizzazione (`api.supabase.oauth-url`):
      // Supabase rifiuta lo scambio se differisce anche di un carattere.
      redirectUri: `${appUrl}/auth/supabase/callback`,
    });
    await saveTokens(shop.id, tokens);
    return json({ ok: true });
  } catch (e) {
    console.error(
      '[supabase connect] exchange fallito:',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return json({ ok: false, error: 'exchange_failed' }, { status: 502 });
  }
}
