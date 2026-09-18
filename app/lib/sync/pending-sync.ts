// app/lib/sync/pending-sync.ts
//
// "C'e' del lavoro di sincronizzazione ancora non concluso per questo negozio?"
//
// PERCHE' ESISTE. La dashboard rispondeva a questa domanda con tre spie, e
// nessuna delle tre guardava dove il lavoro vive davvero:
//
//   1. lo stato del fetcher della POST, che dura l'istante della messa in coda;
//   2. un `useState` con l'ora del clic, che muore cambiando scheda;
//   3. l'ultima corsa completa in `sync_job`, che fra il clic e l'effettiva
//      partenza del lavoro non esiste ancora.
//
// Il risultato erano due difetti gemelli, segnalati insieme: cambiando scheda e
// tornando indietro l'avviso spariva e il pulsante si riaccendeva su una
// sincronizzazione ancora in corso; e nell'attesa fra il clic e la partenza la
// card delle corse mostrava in cima quella PRECEDENTE, gia' chiusa, con il
// badge "Completato", mentre l'avviso diceva che si stava lavorando.
//
// La verita' sta nella coda su Postgres (`sync_requests`), che sopravvive alla
// navigazione, alla chiusura del browser e alla morte dell'invocazione. Qui c'e'
// la regola che la legge; chi la interroga sta in `pending-sync.server.ts`, e
// chi la mostra — avviso, pulsante e card — parte tutto da questo unico valore.
//
// Nessun import di Prisma: la regola si prova senza un database acceso, ed e'
// l'unico modo perche' i casi che contano (backoff, lettera morta, lease
// scaduto, coda che non parte) siano provati davvero invece che affermati.

import { LEASE_TTL_MS, MAX_RUN_MS } from '~/lib/queue/queue-model';

/**
 * I tipi di richiesta che producono la corsa di cui parla l'avviso.
 *
 * 'periodic-sync-check' non c'e', e l'assenza e' voluta: e' lavoro automatico
 * che il merchant non ha chiesto, e l'avviso dice "stiamo eseguendo la
 * sincronizzazione manuale". Spegnere il pulsante e mostrare quella frase per
 * un controllo di cadenza vorrebbe dire attribuire al merchant un gesto che non
 * ha fatto.
 *
 * 'compliance-request' nemmeno: non e' una sincronizzazione, e nella card delle
 * corse e' gia' nascosta per lo stesso motivo.
 */
export const PENDING_SYNC_REQUEST_TYPES = ['manual-sync', 'initial-bulk-sync'] as const;

/**
 * Gli stati della coda in cui il lavoro NON e' concluso.
 *
 * 'completed' e 'dead_letter' sono i due modi di essere finiti — riuscito il
 * primo, arreso il secondo — e nessuno dei due deve tenere spento il pulsante.
 * Sulla lettera morta in particolare: e' lo stato in cui la coda smette di
 * riprovare da sola, quindi aspettarla sarebbe aspettare per sempre.
 */
export const PENDING_SYNC_REQUEST_STATUSES = ['queued', 'processing'] as const;

/**
 * Lo stesso filtro in forma di `where` Prisma, accanto alla regola che lo
 * spiega: se un giorno gli stati o i tipi cambiano, devono cambiare in un posto
 * solo. E' la stessa scelta gia' fatta per `SYNC_ACTIVE_CONFIG_FILTER`.
 */
export const PENDING_SYNC_REQUEST_FILTER: {
  type: { in: string[] };
  status: { in: string[] };
} = {
  type: { in: [...PENDING_SYNC_REQUEST_TYPES] },
  status: { in: [...PENDING_SYNC_REQUEST_STATUSES] },
};

/**
 * Quanto lontano si guarda, in avanti e indietro, per dire "qualcuno la sta per
 * prendere".
 *
 * E' la scadenza che prima stava nel browser (`MANUAL_SYNC_TIMEOUT_MS`, tre
 * minuti dal clic), spostata dove lo stato e' durevole e misurata sulla riga
 * invece che sull'orologio di chi guarda. Serve a due casi opposti:
 *
 * - INDIETRO: una richiesta pronta da piu' di tre minuti che nessuno ha ancora
 *   preso vuol dire che il drenaggio non sta arrivando (innesco fallito, cron
 *   fermo). Continuare a dire "sta lavorando" sarebbe una bugia, e il pulsante
 *   resterebbe spento per sempre — che e' esattamente lo stato che non deve
 *   esistere.
 * - IN AVANTI: una richiesta fallita e rimessa in coda torna prendibile fra
 *   trenta secondi e due minuti (il backoff parte da un minuto, con jitter).
 *   Quella e' ancora la stessa sincronizzazione che sta provando, e spegnere
 *   l'avviso per poi riaccenderlo un minuto dopo racconterebbe due corse dove
 *   ce n'e' una. Oltre i tre minuti il backoff e' cresciuto tanto da voler dire
 *   "si sta insistendo da un pezzo": li' il pulsante torna al merchant, che
 *   della sua attesa deve poter riprendere il controllo.
 */
export const PENDING_SYNC_HORIZON_MS = 3 * 60_000;

/**
 * Oltre quanto una riga `sync_job` ferma su 'running' smette di significare
 * "sta girando".
 *
 * Non e' un numero scelto a occhio: e' il tetto di durata che il drenaggio
 * applica da se' a una corsa, piu' la durata di una presa. Oltre quell'istante
 * il drenaggio avrebbe gia' interrotto il lavoro e riscritto la riga; se la
 * riga dice ancora 'running' vuol dire che l'invocazione e' stata stroncata
 * prima di poterlo fare, e nessuno la sta piu' eseguendo.
 *
 * Senza questo limite esisterebbe uno stato senza uscita: un'invocazione uccisa
 * dalla piattaforma a meta' corsa lascia 'running' per sempre, e il pulsante
 * resterebbe spento per sempre con lei.
 */
export const STALE_RUNNING_JOB_MS = MAX_RUN_MS['manual-sync'] + LEASE_TTL_MS;

/** Quel poco di una riga della coda che serve a deciderne la sorte. */
export interface PendingSyncRequest {
  status: string;
  /** Prima di questo istante l'item non si prende: e' il backoff. */
  nextAttemptAt: Date | string;
  /** Fin quando la presa e' di qualcuno. Nullo se non e' di nessuno. */
  leaseExpiresAt: Date | string | null;
  /** Quando il lavoro e' stato chiesto: e' la data che la card mostra. */
  createdAt: Date | string;
}

function ms(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Se questa richiesta e' in volo adesso.
 *
 * Due modi di esserlo, e il secondo e' quello che copre il buco da cui passava
 * il difetto:
 *
 * - qualcuno la sta lavorando: 'processing' con la presa ancora viva. Il
 *   battito la rinnova per tutta la durata della corsa, quindi questo ramo
 *   copre l'intera sincronizzazione — e smette da solo entro un minuto se
 *   l'invocazione muore, senza bisogno di nessuna scadenza inventata qui.
 * - nessuno l'ha ancora presa ma e' pronta: 'queued' con `nextAttemptAt` dentro
 *   l'orizzonte. E' il tratto fra il clic e la partenza del lavoro, quello in
 *   cui in `sync_job` non esiste ancora nessuna riga da guardare.
 */
export function syncRequestIsInFlight(request: PendingSyncRequest, now: Date): boolean {
  const adesso = now.getTime();

  if (request.status === 'processing') {
    // Una presa scaduta non e' nessuno che lavora: e' un'invocazione morta a
    // meta'. La coda la riprendera', e quando lo fara' questa stessa riga
    // tornera' in volo — ma fino ad allora non c'e' niente in corso da
    // annunciare.
    return request.leaseExpiresAt !== null && ms(request.leaseExpiresAt) > adesso;
  }

  if (request.status === 'queued') {
    const quando = ms(request.nextAttemptAt);
    return quando > adesso - PENDING_SYNC_HORIZON_MS && quando <= adesso + PENDING_SYNC_HORIZON_MS;
  }

  // 'completed' e 'dead_letter': finito, in un modo o nell'altro.
  return false;
}

export interface PendingSyncInput {
  /** Le righe della coda per questo negozio, gia' filtrate per tipo e stato. */
  requests: PendingSyncRequest[];
  /**
   * L'inizio della corsa che in `sync_job` risulta ancora 'running', se ce n'e'
   * una. Nullo se non c'e', o se e' di una connessione precedente.
   */
  runningJobStartedAt?: Date | string | null;
  now: Date;
}

/**
 * Da quando c'e' del lavoro di sincronizzazione in volo, o `null` se non ce
 * n'e'.
 *
 * Una data e non un booleano perche' serve anche alla card delle corse: nel
 * tratto in cui la riga di `sync_job` non esiste ancora, e' questa data a
 * diventare la riga "in corso" che il merchant vede. Card e avviso nascono
 * cosi' dallo stesso valore, e non possono raccontare due cose diverse.
 *
 * La piu' antica fra quelle in volo: se il lavoro e' stato chiesto tre minuti
 * fa ed e' partito un minuto fa, l'attesa del merchant e' cominciata tre minuti
 * fa.
 */
export function pendingSyncSince(opts: PendingSyncInput): Date | null {
  const candidati: number[] = [];

  for (const request of opts.requests) {
    if (syncRequestIsInFlight(request, opts.now)) candidati.push(ms(request.createdAt));
  }

  // La corsa gia' partita, per sicurezza: la coda la copre gia' (l'item resta
  // 'processing' per tutta la sua durata), ma le due letture avvengono in
  // istanti diversi e una riga chiusa un attimo prima non deve poter spegnere
  // l'avviso sopra una corsa che sta ancora scrivendo.
  if (opts.runningJobStartedAt) {
    const inizio = ms(opts.runningJobStartedAt);
    if (inizio > opts.now.getTime() - STALE_RUNNING_JOB_MS) candidati.push(inizio);
  }

  if (candidati.length === 0) return null;
  return new Date(Math.min(...candidati));
}
