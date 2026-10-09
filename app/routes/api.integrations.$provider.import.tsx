import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { requireCustomersSyncShop } from '~/lib/integrations/route-guard.server';
import { requestImport } from '~/lib/integrations/import.server';

/**
 * POST /api/integrations/:provider/import — chiede un giro di import.
 *
 * Non lo esegue: lo mette in coda e risponde subito. `queued: false` con un
 * `reason` non e' un errore della richiesta, e' quello che la card mostra al
 * merchant (gia' in corso, da collegare, campo da scegliere...).
 */
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
  }

  // Oggi si importa solo da Klaviyo.
  if (params.provider !== 'klaviyo') {
    return json({ ok: false, error: 'invalid_provider' }, { status: 404 });
  }

  const shop = await requireCustomersSyncShop(request);
  if (shop instanceof Response) return shop;

  const { queued, reason } = await requestImport(shop.id, 'klaviyo');
  return json(reason ? { queued, reason } : { queued });
}
