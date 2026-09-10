// app/lib/webhooks/inbox.server.ts
//
// Dove vive un webhook amministrativo fra la ricevuta e l'effetto.
//
// LA REGOLA CHE QUESTO FILE ESISTE PER FAR RISPETTARE. La riga si scrive PRIMA
// che qualcuno risponda 200, e se non si riesce a scriverla nessuno risponde
// 200. Il caso che questo esclude e' preciso e prima era possibile: il database
// owner non rispondeva, il try/catch scriveva una riga di log, la rotta
// rispondeva 200 lo stesso, e Shopify segnava l'evento come consegnato per
// sempre. Da quel momento un negozio disinstallato restava attivo nei registri
// e un abbonamento finito continuava a sostenere un piano che nessuno pagava —
// senza che da nessuna parte risultasse qualcosa da fare.
//
// RICEVUTO NON E' ELABORATO. Il 200 risponde a una domanda sola: l'evento e'
// nostro e non si perde piu'. Cosa succede dopo ha i suoi tentativi, il suo
// distanziamento e la sua lettera morta, e puo' andare male quante volte serve
// senza che Shopify lo scambi per un rifiuto. E' la stessa forma dei tre
// webhook di conformita', che questa strada l'hanno gia' fatta.
//
// PERCHE' NON E' UN TIPO NUOVO DELLA CODA. La coda lavora ogni item dentro il
// lucchetto del suo negozio: una disinstallazione accodata li' aspetterebbe la
// fine della sincronizzazione in corso — quella che sta scrivendo per conto del
// negozio che ha appena chiuso. In piu' `sync_requests.shop_id` punta a
// `shops`, mentre questi due topic arrivano anche per installazioni mai
// completate, e la coda porta di proposito il minimo per ritrovare un lavoro,
// mai il corpo dell'evento — che qui e' l'unica cosa da cui lo si puo' rifare.
// Stesso ragionamento di `sync_repairs`: non un'infrastruttura in piu', la
// terza applicazione di quella che c'e'.
//
// COME SI EVITANO I DOPPIONI. Su due livelli. L'indice unico su `webhook_id`
// fa si' che due consegne dello stesso evento siano una riga sola; la presa —
// un `updateMany` da 'queued' a 'processing' con la condizione sullo stato —
// fa si' che due lavorazioni simultanee di quella riga diventino una sola, e
// chi arriva secondo aggiorna zero righe e se ne va.

import { prisma } from '~/db.server';
import { redactError } from '~/lib/queue/queue-model';
import {
  WEBHOOK_STALE_MS,
  isWebhookTopic,
  nextWebhookAttemptAt,
  statusAfterAttempt,
  type SettledWebhookStatus,
  type WebhookOutcome,
  type WebhookTopic,
} from './inbox-model';

/** Una consegna verificata, pronta a diventare una ricevuta. */
export interface WebhookDelivery {
  topic: WebhookTopic;
  shopDomain: string;
  /** L'id della consegna, gia' risolto da `deliveryId`. */
  webhookId: string;
  /** Il corpo cosi' com'e' arrivato, gia' verificato. */
  payload: unknown;
}

export interface ReceiptResult {
  id: string;
  /** Vero se questa consegna era gia' stata presa in carico. */
  duplicate: boolean;
}

/**
 * Scrive che l'evento e' arrivato.
 *
 * Solleva se la scrittura non riesce: chi chiama traduce quel lancio in un 5xx,
 * e Shopify ritenta. E' l'unico caso in cui il ritentativo cambia qualcosa —
 * la riga non c'e', quindi nessuno lavorera' mai quell'evento.
 */
export async function recordWebhookReceipt(
  delivery: WebhookDelivery,
): Promise<ReceiptResult> {
  if (!isWebhookTopic(delivery.topic)) {
    // Un topic che nessuno sa lavorare non deve diventare una riga: resterebbe
    // in attesa per sempre senza che nessuno se ne accorga. E' il difetto che
    // la coda ha gia' pagato una volta.
    throw new Error(`topic non gestito: ${delivery.topic}`);
  }

  try {
    const creata = await prisma.webhookEvent.create({
      data: {
        webhookId: delivery.webhookId,
        topic: delivery.topic,
        shopDomain: delivery.shopDomain,
        payload: (delivery.payload ?? {}) as never,
        status: 'queued',
      },
      select: { id: true },
    });
    return { id: creata.id, duplicate: false };
  } catch (error) {
    // Due consegne arrivate insieme: una delle due ha perso la corsa sull'indice
    // unico. Non e' un guasto, e' la deduplica che ha funzionato — si rilegge la
    // riga dell'altra e si risponde ricevuto. Il corpo NON si riscrive: la prima
    // consegna e' quella in lavorazione, e cambiarle il payload sotto i piedi
    // mentre lo sta leggendo e' proprio il conflitto che la deduplica evita.
    if (isUniqueViolation(error)) {
      const vincitrice = await prisma.webhookEvent.findUnique({
        where: { webhookId: delivery.webhookId },
        select: { id: true },
      });
      if (vincitrice) return { id: vincitrice.id, duplicate: true };
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

/** L'evento come lo vede chi lo elabora. */
export interface ClaimedWebhookEvent {
  id: string;
  topic: WebhookTopic;
  shopDomain: string;
  payload: unknown;
  attempts: number;
}

/** Chi sa lavorare un topic. */
export type WebhookProcessor = (
  event: ClaimedWebhookEvent,
  now: Date,
) => Promise<WebhookOutcome>;

/**
 * Lavora un evento preso in carico.
 *
 * Non solleva: un fallimento diventa uno stato sulla riga, perche' e' li' che
 * devono poterlo leggere sia il ritentativo sia chi va a guardare dopo. Chi la
 * chiama — il drenaggio, o la rotta subito dopo la ricevuta — non ha niente da
 * decidere.
 */
export async function processWebhookEvent(
  eventId: string,
  processors: Record<WebhookTopic, WebhookProcessor>,
  now: Date = new Date(),
): Promise<'done' | 'retried' | 'dead_letter' | 'skipped'> {
  // La presa. La condizione sullo stato e' cio' che rende innocua la lavorazione
  // doppia: chi arriva secondo aggiorna zero righe e se ne va senza fare niente.
  const presa = await prisma.webhookEvent.updateMany({
    where: { id: eventId, status: 'queued' },
    data: { status: 'processing', startedAt: now, attempts: { increment: 1 } },
  });
  if (presa.count === 0) return 'skipped';

  const riga = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
  if (!riga) return 'skipped';

  const topic = riga.topic;
  if (!isWebhookTopic(topic)) {
    // Non puo' succedere passando dalla ricevuta, che i topic li controlla.
    // Puo' succedere dopo una modifica dell'elenco con righe gia' scritte: in
    // lettera morta, non in attesa per sempre.
    await concludi(eventId, 'dead_letter', riga.attempts, `topic non gestito: ${topic}`, now);
    segnala(riga.shopDomain, topic, eventId, riga.attempts, `topic non gestito: ${topic}`);
    return 'dead_letter';
  }

  const evento: ClaimedWebhookEvent = {
    id: riga.id,
    topic,
    shopDomain: riga.shopDomain,
    payload: riga.payload,
    attempts: riga.attempts,
  };

  let esito: WebhookOutcome;
  let motivo: string | null = null;

  try {
    esito = await processors[topic](evento, now);
  } catch (error) {
    // Un lancio e' sempre un "riprova": chi vuole fermarsi lo dice restituendo
    // `dead_letter`, non sollevando. Cosi' un guasto di rete non consuma la
    // stessa strada di un errore di configurazione.
    esito = 'retry';
    motivo = redactError(error);
  }

  const stato = statusAfterAttempt(esito, riga.attempts);
  await concludi(eventId, stato, riga.attempts, motivo, now);

  if (stato === 'dead_letter') {
    segnala(riga.shopDomain, topic, eventId, riga.attempts, motivo ?? 'nessun dettaglio');
    return 'dead_letter';
  }

  return stato === 'completed' ? 'done' : 'retried';
}

async function concludi(
  eventId: string,
  stato: SettledWebhookStatus,
  attempts: number,
  motivo: string | null,
  now: Date,
): Promise<void> {
  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      status: stato,
      completedAt: stato === 'completed' ? now : null,
      // Il distanziamento si scrive anche sulle concluse: costa niente, e
      // lascia la colonna coerente per chi la legge in un elenco.
      nextAttemptAt: stato === 'queued' ? nextWebhookAttemptAt(attempts, now) : now,
      lastError: motivo ? motivo.slice(0, 500) : null,
    },
  });
}

/**
 * L'allarme.
 *
 * Nessun dato personale e nessun segreto: l'id della consegna, il negozio e lo
 * stato. Il dominio del negozio e' l'unico modo di sapere di chi si tratta, ed
 * e' gia' quello che Shopify scrive negli header di ogni consegna — non e' un
 * dato che questa riga aggiunge.
 */
function segnala(
  shopDomain: string,
  topic: string,
  eventId: string,
  attempts: number,
  motivo: string,
): void {
  console.error(
    `[webhook-inbox] ALLARME evento ${topic} del negozio ${shopDomain} fermo dopo ` +
      `${attempts} tentativi (id ${eventId}): ${motivo}. ` +
      `npm run webhooks:replay -- ${eventId}`,
  );
}

/**
 * Quanti eventi si lavorano al massimo in un solo giro.
 *
 * Era venticinque, e bastava: qui dentro passavano due soli topic
 * amministrativi, che arrivano una manciata di volte al giorno. Con prodotti,
 * clienti e ordini il conto cambia — un negozio in una giornata di saldi manda
 * raffiche di consegne — e dopo un'interruzione il drenaggio puo' trovarsi
 * davanti un arretrato vero. A venticinque per giro, mezz'ora l'uno, un
 * arretrato di mille eventi ci metterebbe venti ore.
 */
const DRAIN_BATCH = 200;

/**
 * Per quanto il drenaggio puo' tenere occupato il giro del cron.
 *
 * E' il compagno obbligatorio del tetto alzato: ogni evento operativo parla
 * con Shopify e con il database del merchant, quindi duecento eventi possono
 * costare piu' di quanto il cron abbia. Il drenaggio sta PRIMA delle
 * sincronizzazioni di proposito — qui dentro ci sono le disinstallazioni, cioe'
 * i fatti che decidono quali negozi vadano sincronizzati — e senza un tetto al
 * tempo un arretrato di ordini terrebbe fermo tutto il resto del giro.
 *
 * Fermarsi non perde niente: quel che resta e' ancora 'queued', e ci ripassa
 * il giro dopo. E' la stessa scelta della coda, per la stessa ragione.
 */
export const WEBHOOK_DRAIN_BUDGET_MS = 20_000;

export interface WebhookDrainResult {
  processed: number;
  retried: number;
  deadLettered: number;
  /** Vero se il budget e' finito prima degli eventi pronti. */
  budgetExhausted: boolean;
}

/**
 * Il drenaggio: quel che era stato ricevuto e non e' ancora andato a buon fine.
 *
 * Legge le righe, non la coda, ed e' questo a renderlo l'unica strada che
 * funziona anche quando l'elaborazione immediata non e' mai avvenuta — la
 * funzione morta un istante dopo la ricevuta, il deploy a meta'. Con
 * l'elaborazione immediata non si pestano i piedi perche' la presa e' la
 * stessa.
 */
export async function drainWebhookEvents(
  processors: Record<WebhookTopic, WebhookProcessor>,
  now: Date = new Date(),
  limit: number = DRAIN_BATCH,
  budgetMs: number = WEBHOOK_DRAIN_BUDGET_MS,
): Promise<WebhookDrainResult> {
  const scaduti = new Date(now.getTime() - WEBHOOK_STALE_MS);

  const pronti = await prisma.webhookEvent.findMany({
    where: {
      OR: [
        { status: 'queued', nextAttemptAt: { lte: now } },
        // Una 'processing' ferma da un pezzo e' un'invocazione morta a meta':
        // su una funzione serverless succede, e senza questo ramo l'evento
        // resterebbe in quello stato per sempre — cioe' un negozio
        // disinstallato resterebbe attivo, che e' il guasto di partenza.
        { status: 'processing', startedAt: { lt: scaduti } },
      ],
    },
    orderBy: { receivedAt: 'asc' },
    take: limit,
    select: { id: true, status: true },
  });

  const esito: WebhookDrainResult = {
    processed: 0,
    retried: 0,
    deadLettered: 0,
    budgetExhausted: false,
  };

  // L'orologio vero, non `now`: `now` e' l'istante logico del giro — quello con
  // cui si decide cosa e' scaduto — e usarlo anche per misurare quanto si e'
  // lavorato vorrebbe dire un budget che non scorre mai.
  const inizio = Date.now();

  for (const riga of pronti) {
    if (Date.now() - inizio >= budgetMs) {
      // Non si e' perso niente: le righe rimaste sono ancora 'queued' con il
      // loro `nextAttemptAt` gia' passato, quindi il giro dopo le ritrova in
      // cima — l'ordine e' per data di ricevuta.
      esito.budgetExhausted = true;
      break;
    }

    // Una 'processing' abbandonata va prima riportata a 'queued', altrimenti la
    // presa non la prende: e' la stessa condizione sullo stato che protegge dai
    // doppioni, e qui deve valere identica.
    if (riga.status === 'processing') {
      await prisma.webhookEvent.updateMany({
        where: { id: riga.id, status: 'processing' },
        data: { status: 'queued', lastError: 'lavorazione interrotta: ripresa dal cron' },
      });
    }

    const risultato = await processWebhookEvent(riga.id, processors, now);
    if (risultato === 'done') esito.processed++;
    else if (risultato === 'retried') esito.retried++;
    else if (risultato === 'dead_letter') esito.deadLettered++;
  }

  return esito;
}

/** Per quanto si tengono gli eventi conclusi prima di toglierli di mezzo. */
export const WEBHOOK_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Toglie di mezzo gli eventi conclusi da un pezzo.
 *
 * I soli conclusi. Quelli in lettera morta restano: sono l'unica traccia di un
 * evento che non e' stato applicato, e cancellarli dopo una settimana vorrebbe
 * dire far sparire il problema invece di risolverlo.
 */
export async function pruneWebhookEvents(now: Date = new Date()): Promise<number> {
  const esito = await prisma.webhookEvent.deleteMany({
    where: {
      status: 'completed',
      completedAt: { lt: new Date(now.getTime() - WEBHOOK_COMPLETED_TTL_MS) },
    },
  });
  return esito.count;
}

/**
 * Gli eventi fermi in lettera morta.
 *
 * Serve al comando di replay e a chi va a guardare dopo un allarme: e' l'elenco
 * di cosa Shopify ci ha detto e noi non abbiamo applicato.
 */
export async function listDeadWebhookEvents(limit = 50) {
  return prisma.webhookEvent.findMany({
    where: { status: 'dead_letter' },
    orderBy: { receivedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      topic: true,
      shopDomain: true,
      attempts: true,
      lastError: true,
      receivedAt: true,
    },
  });
}

/**
 * Rimette in lavorazione quel che era stato abbandonato.
 *
 * Azzera i tentativi di proposito: la lettera morta si ripiglia dopo aver
 * aggiustato la causa, e ripartire con il contatore gia' pieno vorrebbe dire un
 * solo tentativo prima di tornare dov'era. Senza `ids` li riprende tutti.
 */
export async function replayDeadWebhookEvents(
  ids?: string[],
  now: Date = new Date(),
): Promise<number> {
  const esito = await prisma.webhookEvent.updateMany({
    where: { status: 'dead_letter', ...(ids && ids.length > 0 ? { id: { in: ids } } : {}) },
    data: { status: 'queued', attempts: 0, nextAttemptAt: now, lastError: null },
  });
  return esito.count;
}
