import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveShopifyWebhook } from '~/lib/webhooks/receive.server';

/**
 * products/create — un prodotto e' comparso su Shopify.
 *
 * Qui dentro non c'e' piu' niente perche' non deve esserci. Prima la rotta
 * rileggeva il prodotto da Shopify, arricchiva i costi dagli InventoryItem,
 * scriveva nel database del merchant, riconciliava le varianti sparite e solo
 * allora rispondeva: il tempo di risposta era il tempo di due sistemi remoti in
 * fila, e un timeout diventava un ritentativo che rifaceva tutto daccapo.
 *
 * Adesso si verifica la firma, si scrive la ricevuta e si risponde; se la
 * ricevuta non si riesce a scrivere si risponde 5xx e Shopify ritenta, che e'
 * l'unico caso in cui ritentare cambia qualcosa.
 *
 * Cosa succede davvero al prodotto sta in lib/webhooks/handle-product.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, 'products/create');
}
