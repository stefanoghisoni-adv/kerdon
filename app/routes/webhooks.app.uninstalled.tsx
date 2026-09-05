import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveAdminWebhook } from '~/lib/webhooks/receive.server';

/**
 * app/uninstalled — il merchant ha disinstallato l'app.
 *
 * Qui dentro non c'e' piu' niente perche' non deve esserci: la rotta verifica
 * la firma, scrive la ricevuta e risponde. Se la ricevuta non si riesce a
 * scrivere risponde 5xx e Shopify ritenta — prima rispondeva 200 lo stesso, e
 * un negozio disinstallato mentre il database non rispondeva restava attivo nei
 * registri per sempre.
 *
 * Cosa succede davvero alla disinstallazione — e cosa non succede, cioe' i dati
 * del merchant, che restano dove sono — sta in lib/webhooks/handle-uninstall.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveAdminWebhook(request, 'app/uninstalled');
}
