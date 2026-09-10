import type { ActionFunctionArgs } from '@remix-run/node';
import { receiveShopifyWebhook, topicFromHeader } from '~/lib/webhooks/receive.server';
import type { WebhookTopic } from '~/lib/webhooks/inbox-model';

/**
 * Gli ordini: create, updated e refund, tutti e tre qui.
 *
 * Fanno la stessa cosa — dicono QUALE ordine e' cambiato — e l'ordine si
 * rilegge. Il rimborso e' il caso che rende evidente perche': e' l'evento in
 * cui l'ordine cambia senza che nessuna riga nuova compaia.
 *
 * ERA IL WEBHOOK PIU' LENTO E IL PIU' FREQUENTE INSIEME. Scatta a ogni vendita,
 * e faceva rilettura GraphQL, scrittura dell'ordine, scrittura delle righe,
 * cancellazione per differenza e legame browser-cliente PRIMA di rispondere.
 * Nelle ore di punta un negozio manda raffiche di consegne, e ogni timeout
 * diventava un ritentativo che rifaceva daccapo cio' che era gia' riuscito.
 * Adesso la risposta e' la sola ricevuta.
 *
 * Cosa succede davvero sta in lib/webhooks/handle-order.
 */
const TOPIC_AMMESSI = ['orders/create', 'orders/updated', 'refunds/create'] as const satisfies
  readonly WebhookTopic[];

export async function action({ request }: ActionFunctionArgs) {
  // Il topic si legge dall'header ma si accetta solo se e' uno di questi tre:
  // serve a distinguere nella posta in arrivo cos'era arrivato, non a scegliere
  // il processore — quello e' lo stesso per tutti e tre.
  return receiveShopifyWebhook(request, topicFromHeader(request, TOPIC_AMMESSI, 'orders/updated'));
}
