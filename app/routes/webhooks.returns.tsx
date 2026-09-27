import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveShopifyWebhook, topicFromHeader } from '~/lib/webhooks/receive.server';
import type { WebhookTopic } from '~/lib/webhooks/inbox-model';

/**
 * I resi: approve, decline, cancel, close e reopen, tutti qui.
 *
 * Fanno la stessa cosa dei webhook degli ordini — dicono QUALE ordine
 * rileggere — perche' il costo del rientro dipende dallo stato dei resi
 * dell'ordine (solo OPEN o CLOSED lo fanno pagare), e Shopify non promette di
 * toccare l'ordine quando un reso cambia stato. Stessa ricevuta, stessa firma
 * HMAC, stessa posta in arrivo; il lavoro sta in lib/webhooks/handle-order
 * (handleReturnEvent).
 *
 * `returns/request` non c'e' di proposito: un reso richiesto non cambia il
 * costo, e il cambio che conta (approvato, cioe' OPEN) ha il suo topic.
 */
const TOPIC_AMMESSI = [
  'returns/approve',
  'returns/decline',
  'returns/cancel',
  'returns/close',
  'returns/reopen',
] as const satisfies readonly WebhookTopic[];

export async function action({ request }: ActionFunctionArgs) {
  // Il topic si legge dall'header ma si accetta solo fra questi: serve a
  // distinguere nella posta in arrivo cos'era arrivato, il processore e' lo
  // stesso per tutti.
  return receiveShopifyWebhook(request, topicFromHeader(request, TOPIC_AMMESSI, 'returns/cancel'));
}
