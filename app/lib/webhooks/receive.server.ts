// app/lib/webhooks/receive.server.ts
//
// La meta' di un webhook amministrativo che risponde a Shopify.
//
// L'ORDINE E' TUTTO, ed e' l'unica cosa che questo file impone: firma,
// ricevuta, risposta. L'elaborazione viene dopo la ricevuta e non prima, e il
// suo esito non entra nel codice di risposta. Prima era il contrario — si
// faceva il lavoro, si catturava l'errore, si rispondeva 200 comunque — e
// quel 200 diceva a Shopify "consegnato" per un evento che non era stato
// applicato da nessuno e che nessuna riga ricordava.
//
// LE RISPOSTE, E IL PERCHE' DI OGNUNA:
//
//   401  firma non valida — non e' Shopify che parla
//   400  corpo illeggibile o header del negozio assente. Non e' un 5xx:
//        ritentare lo stesso corpo darebbe lo stesso esito per giorni
//   500  la ricevuta non e' stata scritta. E' l'unico caso in cui serve che
//        Shopify ritenti, ed e' anche l'unico in cui il ritentativo cambia
//        qualcosa: la riga non c'e', quindi nessuno lavorera' mai quell'evento
//   200  ricevuto. Non "fatto": ricevuto
//
// L'ELABORAZIONE IMMEDIATA NON E' LA PRESA IN CARICO. E' solo il modo di non
// far aspettare al merchant il giro del cron per una cosa che dura
// millisecondi. Se va male non cambia niente di quel che si risponde: la riga
// resta da lavorare, e il drenaggio ci ripassa. Fallire li' e far ritentare
// Shopify vorrebbe dire rifiutare un evento gia' accettato.

import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { deliveryId } from './delivery-id.server';
import { processWebhookEvent, recordWebhookReceipt } from './inbox.server';
import { WEBHOOK_PROCESSORS } from './processors.server';
import type { WebhookTopic } from './inbox-model';

export async function receiveAdminWebhook(request: Request, topic: WebhookTopic) {
  const body = await request.text();
  const hmac = request.headers.get('X-Shopify-Hmac-Sha256');

  if (!hmac || !verifyWebhook(body, hmac)) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }

  const shopDomain = request.headers.get('X-Shopify-Shop-Domain');
  if (!shopDomain) {
    return json({ error: 'Missing shop domain' }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    console.error(`[webhook-inbox] ${topic}: corpo non leggibile come JSON`);
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  let eventId: string;
  let duplicate: boolean;

  try {
    const ricevuta = await recordWebhookReceipt({
      topic,
      shopDomain,
      webhookId: deliveryId(request.headers.get('X-Shopify-Webhook-Id'), topic, shopDomain, body),
      payload,
    });
    eventId = ricevuta.id;
    duplicate = ricevuta.duplicate;
  } catch (error) {
    // Nessun successo falso. Il messaggio non porta ne' il corpo ne' gli header:
    // il topic, il negozio e il motivo, che e' tutto quel che serve a capire.
    console.error(
      `[webhook-inbox] ${topic}: ricevuta non scritta per ${shopDomain}: ` +
        `${error instanceof Error ? error.message : 'errore sconosciuto'}`,
    );
    return json({ error: 'Could not accept webhook' }, { status: 500 });
  }

  // Da qui in giu' il 200 e' dovuto, qualunque cosa succeda.
  //
  // Si prova a lavorare anche una consegna ripetuta, e non e' uno spreco: la
  // prima puo' aver scritto la ricevuta e poi essere morta: la presa dentro
  // `processWebhookEvent` rende innocuo il caso in cui invece stia ancora
  // lavorando, o abbia gia' finito.
  try {
    await processWebhookEvent(eventId, WEBHOOK_PROCESSORS);
  } catch (error) {
    console.error(
      `[webhook-inbox] ${topic}: evento ${eventId} ricevuto ma non lavorato subito: ` +
        `${error instanceof Error ? error.message : 'errore sconosciuto'}`,
    );
  }

  return json({ ok: true, duplicate }, { status: 200 });
}
