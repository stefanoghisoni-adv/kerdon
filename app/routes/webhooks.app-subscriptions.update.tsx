import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveAdminWebhook } from '~/lib/webhooks/receive.server';

/**
 * app_subscriptions/update — Shopify ha cambiato lo stato di un abbonamento
 * senza che il merchant apra l'app: disdetta dal pannello del negozio, carta
 * rifiutata, scadenza, congelamento.
 *
 * Come per la disinstallazione, la rotta si limita alla ricevuta. La macchina a
 * stati — e il caso del listino senza piano gratuito, che prima si dichiarava
 * riuscito e lasciava il negozio su un piano che nessuno pagava — sta in
 * lib/webhooks/handle-subscription-update.
 */
export async function action({ request }: ActionFunctionArgs) {
  return receiveAdminWebhook(request, 'app_subscriptions/update');
}
