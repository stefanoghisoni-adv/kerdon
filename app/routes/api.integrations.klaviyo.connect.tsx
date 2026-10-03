import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import { dictionaryForShop } from '~/lib/i18n/server';
import { readState, exchangeCode } from '~/lib/integrations/klaviyo/oauth.server';
import { accountName } from '~/lib/integrations/klaviyo/api.server';
import { saveConnection, markNeedsReconnect } from '~/lib/integrations/connections.server';
import { KlaviyoAuthError, KlaviyoUnavailableError } from '~/lib/integrations/klaviyo/api.server';

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    return json({ error: 'Shop non trovato' }, { status: 404 });
  }
  if (!can(await shopCapabilities(shop), 'use_app')) {
    return json(
      {
        error: (await dictionaryForShop(session.shop)).errors.suspended,
        code: 'not_authorized',
      },
      { status: 403 },
    );
  }

  const body = (await request.json()) as { code?: string; state?: string };
  const { code, state } = body;

  if (!code || !state) {
    return json({ ok: false, error: 'missing_params' }, { status: 400 });
  }

  // SICUREZZA (anti-CSRF): readState restituisce null se lo state è scaduto
  // o manomesso. Questo previene replay attack e stati forgiati.
  const verified = readState(state);
  if (!verified) {
    return json({ ok: false, error: 'expired' }, { status: 400 });
  }

  // SICUREZZA (anti-CSRF): verifica che lo state appartenga allo shop della
  // sessione autenticata. Se non corrisponde, rifiuta SENZA scambiare il code.
  // Questo previene che un attaccante usi il code di un'autorizzazione fatta
  // da un altro merchant.
  if (verified.shopId !== shop.id) {
    return json(
      { error: 'Lo state non appartiene a questo negozio' },
      { status: 403 },
    );
  }

  try {
    const tokens = await exchangeCode(code, verified.verifier);
    const name = await accountName(tokens.accessToken);
    await saveConnection(shop.id, tokens, name);
    return json({ ok: true, accountName: name });
  } catch (e) {
    if (e instanceof KlaviyoUnavailableError) {
      // Klaviyo non raggiungibile: 503 senza toccare lo stato della connessione
      return json({ error: 'unavailable' }, { status: 503 });
    }
    if (e instanceof KlaviyoAuthError) {
      // Klaviyo ha rifiutato il token: marca come needs_reconnect
      await markNeedsReconnect(shop.id);
      return json({ ok: false, error: 'denied' }, { status: 409 });
    }
    throw e;
  }
}
