import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveShopifyWebhook } from '~/lib/webhooks/receive.server';

/**
 * customers/update — stesso lavoro di `customers/create`, topic diverso.
 *
 * Non si riesporta l'action dell'altra: il topic finisce sulla riga, e serve a
 * capire dopo cos'era arrivato.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, 'customers/update');
}
