import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveShopifyWebhook } from '~/lib/webhooks/receive.server';

/**
 * orders/delete — l'ordine su Shopify non esiste piu'.
 *
 * E' l'unico dei topic sugli ordini che non ha niente da rileggere, ed e'
 * anche quello per cui conservare l'identificativo conta di piu': un ordine
 * cancellato che restasse nel database del merchant continuerebbe a portare un
 * profitto che lui non ritrova da nessuna parte, e nessuna corsa periodica
 * verrebbe a toglierlo.
 *
 * Cosa succede davvero sta in lib/webhooks/handle-order.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, 'orders/delete');
}
