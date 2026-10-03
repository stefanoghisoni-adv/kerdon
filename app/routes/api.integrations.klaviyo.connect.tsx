import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { requireCustomersSyncShop } from '~/lib/integrations/route-guard.server';
import { readState, exchangeCode } from '~/lib/integrations/klaviyo/oauth.server';
import { accountName } from '~/lib/integrations/klaviyo/api.server';
import { saveConnection, markNeedsReconnect } from '~/lib/integrations/connections.server';
import { KlaviyoAuthError, KlaviyoUnavailableError } from '~/lib/integrations/klaviyo/api.server';

export async function action({ request }: ActionFunctionArgs) {
  const shop = await requireCustomersSyncShop(request);
  if (shop instanceof Response) return shop;

  let body: { code?: string; state?: string };
  try {
    body = (await request.json()) as { code?: string; state?: string };
  } catch {
    return json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

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
    return json({ ok: false, error: 'shop_mismatch' }, { status: 403 });
  }

  try {
    const tokens = await exchangeCode(code, verified.verifier);
    const name = await accountName(tokens.accessToken);
    await saveConnection(shop.id, tokens, name);
    return json({ ok: true, accountName: name });
  } catch (e) {
    if (e instanceof KlaviyoUnavailableError) {
      // Klaviyo non raggiungibile: 503 senza toccare lo stato della connessione
      return json({ ok: false, error: 'unavailable' }, { status: 503 });
    }
    if (e instanceof KlaviyoAuthError) {
      // Klaviyo ha rifiutato il token: marca come needs_reconnect
      await markNeedsReconnect(shop.id);
      return json({ ok: false, error: 'denied' }, { status: 409 });
    }
    throw e;
  }
}
