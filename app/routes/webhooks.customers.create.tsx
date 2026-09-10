import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveShopifyWebhook } from '~/lib/webhooks/receive.server';

/**
 * customers/create — un cliente e' comparso su Shopify.
 *
 * Della busta si conserva il solo identificativo: nome, email, telefono e
 * indirizzo si rileggono da Shopify quando si lavora. La riga della posta in
 * arrivo vive una settimana in un database che non e' del merchant, e
 * conservarci dentro l'anagrafica di una persona vorrebbe dire tenerla in un
 * posto che nessuna cancellazione attraversa.
 *
 * Cosa succede davvero — la regola sul consenso compresa — sta in
 * lib/webhooks/handle-customer.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveShopifyWebhook(request, 'customers/create');
}
