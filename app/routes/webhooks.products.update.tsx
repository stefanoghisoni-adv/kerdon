import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveShopifyWebhook } from '~/lib/webhooks/receive.server';

/**
 * products/update — stesso lavoro di `products/create`, topic diverso.
 *
 * La rotta non riesporta piu' l'action dell'altra: il topic deve finire sulla
 * riga cosi' com'e' arrivato, o guardando la posta in arrivo un aggiornamento
 * risulterebbe una creazione. A fare la stessa cosa e' il processore, che e'
 * il posto giusto dove condividerla.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, 'products/update');
}
