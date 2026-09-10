import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveShopifyWebhook } from '~/lib/webhooks/receive.server';

/**
 * customers/delete — il cliente non esiste piu' su Shopify.
 *
 * Come per i prodotti: della busta resta l'identificativo, perche' dopo non
 * sarebbe piu' ricavabile da nessuna parte, e con quello si tolgono i dati di
 * quella persona dal database del merchant.
 *
 * Cosa succede davvero sta in lib/webhooks/handle-customer.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, 'customers/delete');
}
