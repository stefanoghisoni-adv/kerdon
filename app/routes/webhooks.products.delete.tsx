import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveShopifyWebhook } from '~/lib/webhooks/receive.server';

/**
 * products/delete — il merchant ha cancellato un prodotto.
 *
 * Della busta si conserva il solo identificativo, e non e' una scelta di
 * risparmio: il prodotto su Shopify non esiste piu', quindi non c'e' niente da
 * rileggere. Se quell'id non lo si scrive adesso, le righe di quel prodotto
 * restano nel database del merchant per sempre — nessuna corsa periodica le
 * toglierebbe, perche' la corsa legge cio' che c'e' e non sa cosa e' sparito.
 *
 * Cosa succede davvero sta in lib/webhooks/handle-product.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, 'products/delete');
}
