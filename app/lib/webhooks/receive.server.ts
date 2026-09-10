// app/lib/webhooks/receive.server.ts
//
// La meta' di un webhook che risponde a Shopify. Tutti i webhook, adesso.
//
// L'ORDINE E' TUTTO, ed e' l'unica cosa che questo file impone: dimensione,
// firma, intestazioni, ricevuta, risposta. L'elaborazione viene dopo la
// ricevuta e non prima, e il suo esito non entra nel codice di risposta. Prima
// era il contrario — si faceva il lavoro, si catturava l'errore, si rispondeva
// 200 comunque — e quel 200 diceva a Shopify "consegnato" per un evento che non
// era stato applicato da nessuno e che nessuna riga ricordava.
//
// COSA E' CAMBIATO PER I WEBHOOK OPERATIVI. Prodotti, clienti e ordini
// rileggevano da Shopify, interrogavano il database owner e quello del merchant,
// scrivevano, ripulivano e registravano, e SOLO ALLA FINE rispondevano. Cioe':
// il tempo di risposta era il tempo di due sistemi remoti messi in fila. Un
// timeout li' non era un guasto isolato — Shopify ritentava, e il ritentativo
// rifaceva daccapo tutto quello che era gia' riuscito. Adesso la richiesta fa
// due scritture sul database owner e risponde; il lavoro parte subito dopo, e
// se non arriva in fondo resta una riga da lavorare.
//
// LE RISPOSTE, E IL PERCHE' DI OGNUNA:
//
//   413  corpo oltre il tetto — non viene nemmeno letto per intero
//   401  firma non valida — non e' Shopify che parla
//   400  corpo illeggibile o header del negozio assente. Non e' un 5xx:
//        ritentare lo stesso corpo darebbe lo stesso esito per giorni
//   500  la ricevuta non e' stata scritta. E' l'unico caso in cui serve che
//        Shopify ritenti, ed e' anche l'unico in cui il ritentativo cambia
//        qualcosa: la riga non c'e', quindi nessuno lavorera' mai quell'evento
//   200  ricevuto. Non "fatto": ricevuto
//
// L'ELABORAZIONE NON E' PIU' ATTESA, ED E' LA DIFFERENZA CHE CONTA. Si avvia e
// non si aspetta: cosi' il budget di risposta e' quello della sola ricevuta,
// qualunque cosa stiano facendo Shopify e il database del merchant. Se
// l'invocazione muore prima che finisca non si perde niente — la riga e'
// scritta, e il drenaggio del cron ci ripassa. Fallire e far ritentare Shopify
// vorrebbe dire rifiutare un evento gia' accettato.

import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { deliveryId } from './delivery-id.server';
import { processWebhookEvent, recordWebhookReceipt } from './inbox.server';
import { WEBHOOK_PROCESSORS } from './processors.server';
import { MAX_WEBHOOK_BODY_BYTES, type WebhookTopic } from './inbox-model';
import { distillTrigger } from './trigger';

/**
 * Il corpo, letto con un tetto.
 *
 * `null` vuol dire "oltre il tetto": chi chiama risponde 413 e non prosegue. Si
 * guarda prima la lunghezza dichiarata — costa niente e ferma il caso piu'
 * comune senza leggere un byte — e poi si conta davvero mentre si legge,
 * perche' l'intestazione la scrive il mittente e non e' una promessa.
 *
 * Il corpo GREZZO e' anche cio' su cui si verifica la firma: ricomporlo da un
 * JSON riserializzato darebbe un'impronta diversa e ogni consegna risulterebbe
 * falsa. Per questo si accumulano i byte e si decodificano una volta sola.
 */
export async function readWebhookBody(
  request: Request,
  limit: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<string | null> {
  const dichiarata = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(dichiarata) && dichiarata > limit) return null;

  const flusso = request.body;
  if (!flusso) {
    // Nessun flusso da percorrere (una Request costruita in memoria, o un corpo
    // gia' consumato): si legge e si misura, che e' comunque prima del parse.
    const testo = await request.text();
    return Buffer.byteLength(testo, 'utf8') > limit ? null : testo;
  }

  const lettore = flusso.getReader();
  const pezzi: Buffer[] = [];
  let letti = 0;

  try {
    for (;;) {
      const { done, value } = await lettore.read();
      if (done) break;
      if (!value) continue;
      letti += value.byteLength;
      if (letti > limit) {
        // Si smette di leggere davvero: il resto del corpo non entra mai in
        // memoria, che e' il punto del tetto.
        await lettore.cancel().catch(() => {});
        return null;
      }
      pezzi.push(Buffer.from(value));
    }
  } finally {
    try {
      lettore.releaseLock();
    } catch {
      // Un lettore gia' rilasciato dopo `cancel()` non e' un guasto.
    }
  }

  return Buffer.concat(pezzi).toString('utf8');
}

/**
 * Le lavorazioni avviate dopo la risposta e non ancora finite.
 *
 * Esiste perche' "non aspettare" e "dimenticarsene" sono due cose diverse: chi
 * deve osservare l'effetto — i test, e un arresto ordinato del processo — deve
 * avere un modo di sapere quando quel lavoro e' concluso. Senza, l'unica
 * alternativa sarebbe aspettarlo dentro la richiesta, cioe' rimettere il
 * lavoro remoto davanti alla risposta.
 */
const inVolo = new Set<Promise<unknown>>();

function avvia(lavoro: Promise<unknown>): void {
  inVolo.add(lavoro);
  void lavoro.finally(() => inVolo.delete(lavoro));
}

/** Aspetta che le lavorazioni gia' avviate siano finite. Non ne avvia nessuna. */
export async function settleWebhookWork(): Promise<void> {
  while (inVolo.size > 0) {
    await Promise.allSettled([...inVolo]);
  }
}

/**
 * Il topic di una rotta che ne serve piu' di uno.
 *
 * `/webhooks/orders` riceve `orders/create`, `orders/updated` e
 * `refunds/create`: sono lo stesso lavoro, e distinguerli serve solo a capire
 * dopo cosa era arrivato. L'header lo dice, ma NON lo si prende per buono:
 * si accetta solo se e' uno dei topic che quella rotta e' iscritta a ricevere,
 * altrimenti si usa il ripiego. Cosi' il mittente non puo' scegliere quale
 * processore far girare — quella scelta resta della rotta.
 */
export function topicFromHeader<T extends WebhookTopic>(
  request: Request,
  ammessi: readonly T[],
  ripiego: T,
): T {
  const dichiarato = request.headers.get('X-Shopify-Topic')?.trim();
  const trovato = ammessi.find((t) => t === dichiarato);
  return trovato ?? ripiego;
}

/**
 * Riceve una consegna: la scrive, risponde, e poi si mette al lavoro.
 *
 * Il topic e' un parametro e non si legge dall'header, ed e' voluto: lo dichiara
 * la rotta, che e' l'unica a saperlo per certo. Fidarsi di `X-Shopify-Topic`
 * vorrebbe dire lasciar scegliere al mittente quale processore far girare.
 */
export async function receiveShopifyWebhook(request: Request, topic: WebhookTopic) {
  const body = await readWebhookBody(request);
  if (body === null) {
    // Prima del parse e prima della firma: non si spende un HMAC su un corpo
    // che comunque non si accetta.
    console.error(`[webhook-inbox] ${topic}: corpo oltre il limite, consegna rifiutata`);
    return json({ error: 'Payload too large' }, { status: 413 });
  }

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
      // Si conserva l'innesco, non la busta: il perche' sta per esteso in
      // `trigger.ts`, e in breve e' che questa riga vive una settimana in un
      // database che non e' del merchant.
      payload: distillTrigger(topic, payload),
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
  avvia(
    processWebhookEvent(eventId, WEBHOOK_PROCESSORS).catch((error) => {
      console.error(
        `[webhook-inbox] ${topic}: evento ${eventId} ricevuto ma non lavorato subito: ` +
          `${error instanceof Error ? error.message : 'errore sconosciuto'}`,
      );
    }),
  );

  return json({ ok: true, duplicate }, { status: 200 });
}

/**
 * Il nome con cui i due webhook amministrativi la chiamavano.
 *
 * Resta perche' e' la stessa funzione: la posta in arrivo si e' allargata, non
 * sdoppiata, e cambiare il nome nei due punti che lo usano non aggiungerebbe
 * niente a chi legge.
 */
export const receiveAdminWebhook = receiveShopifyWebhook;
