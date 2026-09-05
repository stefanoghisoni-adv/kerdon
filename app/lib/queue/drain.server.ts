// app/lib/queue/drain.server.ts
//
// Il consumatore della coda: prende un lotto, lo lavora, e chiude ogni item
// dicendo com'e' andata.
//
// E' l'unico consumatore. Il vincolo e' esplicito e sta nell'ADR
// (docs/architecture/queue-adr.md): due consumatori sulla stessa coda sono
// esattamente il guasto da cui e' partito tutto, e la coda vecchia ne aveva due
// per costruzione — il cron che chiamava i processor e un Worker BullMQ che in
// produzione non e' mai esistito ma che in locale girava insieme a lui.
//
// LE TRE COSE CHE QUI NON DEVONO POTER SUCCEDERE.
//
// 1. Che due giri lavorino lo stesso item. Ci pensa la presa atomica dello
//    store, non un controllo qui.
// 2. Che un fallimento cancelli il lavoro. Un item fallito non si tocca mai:
//    torna in coda distanziato, e solo dopo l'ultimo tentativo va in lettera
//    morta — con un allarme, perche' altrimenti resterebbe li' senza che
//    nessuno lo sappia.
// 3. Che si dichiari completato un lavoro dopo aver perso il possesso. La
//    chiusura porta il gettone: se non e' piu' il nostro tocca zero righe, e
//    quella e' una riga di log che comincia per ALLARME.

import {
  MAX_RUN_MS,
  isExhausted,
  isSyncRequestType,
  nextAttemptAfterFailure,
  redactError,
  type SyncRequestLease,
  type SyncRequestRow,
  type SyncRequestType,
} from './queue-model';
import {
  CLAIM_BATCH,
  postgresQueueStore,
  type QueueStore,
} from './queue-store.server';
import { runWithShopLease, type ShopLease } from './shop-lock.server';
import {
  processInitialBulkSync,
  processManualSync,
  processPeriodicSyncCheck,
} from '~/lib/workers/processors.server';
import { processComplianceRequest } from '~/lib/gdpr/process-compliance.server';
import { randomUUID } from 'node:crypto';

/** Quanto si aspetta prima di riprovare un negozio che era occupato. */
export const BUSY_RETRY_MS = 30_000;

/** Quanto si aspetta quando il lucchetto stesso non e' raggiungibile. */
export const LOCK_UNAVAILABLE_RETRY_MS = 60_000;

/** Ogni quanto si rinnova la presa sull'item mentre lo si lavora. */
const ITEM_HEARTBEAT_MS = 20_000;

export interface DrainResult {
  claimed: number;
  completed: number;
  /** Falliti e rimessi in coda: il lavoro non e' perso, e' rimandato. */
  retried: number;
  /** Falliti troppe volte: fermi, e segnalati. */
  deadLettered: number;
  /** Restituiti senza tentativo: negozio occupato. */
  skippedLocked: number;
  /** Restituiti senza tentativo: lucchetto irraggiungibile. */
  lockUnavailable: number;
  /** Item con un tipo che nessuno sa lavorare: in lettera morta, non in attesa. */
  unknownType: number;
  errors: string[];
}

/**
 * Cosa fa concretamente ciascun tipo.
 *
 * Iniettabile perche' e' l'unico modo di provare il drenaggio senza mettere in
 * piedi Shopify e Supabase: le prove su presa, backoff e lettera morta parlano
 * del protocollo, non di cosa sincronizza.
 */
export type Handler = (
  row: SyncRequestRow,
  ctx: { lease?: ShopLease; signal: AbortSignal },
) => Promise<void>;

export const defaultHandlers: Record<SyncRequestType, Handler> = {
  'manual-sync': (row, ctx) => processManualSync(row.shopId!, undefined, ctx.lease),
  'initial-bulk-sync': (row, ctx) => processInitialBulkSync(row.shopId!, undefined, ctx.lease),
  'periodic-sync-check': (row, ctx) => processPeriodicSyncCheck(row.shopId!, ctx.lease),
  'compliance-request': async (row) => {
    const requestId = (row.payload as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== 'string') {
      // Un item scritto male non si aggiusta ritentandolo: si dichiara subito
      // per quello che e'.
      throw new Error('richiesta di conformita\' senza requestId');
    }
    await processComplianceRequest(requestId);
  },
};

/**
 * I tipi che vogliono il lucchetto del negozio.
 *
 * 'compliance-request' non c'e': il lucchetto se lo prende dove serve
 * `process-compliance` stesso, e `shop/redact` non ha nemmeno un negozio a cui
 * legarlo, visto che sta per toglierlo.
 */
const RICHIEDE_LUCCHETTO: ReadonlySet<string> = new Set([
  'manual-sync',
  'initial-bulk-sync',
  'periodic-sync-check',
]);

export interface DrainOptions {
  /** La corsia veloce: si drena la coda di questo negozio e basta. */
  shopId?: string | null;
  limit?: number;
  /**
   * L'orologio, uno solo per tutto il drenaggio.
   *
   * Iniettabile perche' senza non si prova niente di quel che conta: che il
   * backoff sposti davvero il prossimo tentativo in avanti, e che prima di
   * quell'istante nessuno riprenda l'item. Con `new Date()` sparso nel codice
   * quelle due cose si potevano solo affermare.
   */
  clock?: () => Date;
  store?: QueueStore;
  handlers?: Partial<Record<SyncRequestType, Handler>>;
  /** Un segnale esterno che interrompe il drenaggio (SIGTERM). */
  signal?: AbortSignal;
  random?: () => number;
}

/**
 * Prende un lotto e lo lavora.
 *
 * Non solleva mai per un item: un guasto su un negozio non deve fermare gli
 * altri. Quello che va storto finisce in `errors` e sulla riga dell'item.
 */
export async function drainSyncRequests(opts: DrainOptions = {}): Promise<DrainResult> {
  const store = opts.store ?? postgresQueueStore;
  const handlers = { ...defaultHandlers, ...opts.handlers };
  const orologio = opts.clock ?? (() => new Date());
  const owner = `${process.env.VERCEL_DEPLOYMENT_ID ?? 'locale'}:${randomUUID()}`;

  const result: DrainResult = {
    claimed: 0,
    completed: 0,
    retried: 0,
    deadLettered: 0,
    skippedLocked: 0,
    lockUnavailable: 0,
    unknownType: 0,
    errors: [],
  };

  const spegnimento = ascoltaSpegnimento(opts.signal);

  const tetto = opts.limit ?? CLAIM_BATCH;

  try {
    // Un item per volta, non un lotto intero in anticipo.
    //
    // Prendere dieci item e poi lavorarli in fila vorrebbe dire tenerne nove
    // fermi con addosso una presa che nessuno rinnova — il battito segue solo
    // quello in lavorazione — e quelle nove prese scadrebbero mentre aspettano
    // il loro turno. Il risultato sarebbe una coda che si riprende da sola gli
    // item che ha appena preso: niente di rotto, ma lavoro contato due volte e
    // tentativi bruciati per nulla.
    for (let fatti = 0; fatti < tetto; fatti++) {
      // Prima di prendere, non dopo: quel che non si prende non va nemmeno
      // restituito.
      if (spegnimento.signal.aborted) break;

      const presi = await store.claim({
        owner,
        now: orologio(),
        limit: 1,
        shopId: opts.shopId ?? null,
      });
      if (presi.length === 0) break;

      const { row, lease } = presi[0];
      result.claimed++;

      // L'interruzione arrivata fra la presa e l'inizio del lavoro: si
      // restituisce subito, perche' lasciarlo 'processing' vorrebbe dire
      // aspettare la scadenza della presa per riprenderlo.
      if (spegnimento.signal.aborted) {
        await store.release(lease, orologio(), 'drenaggio interrotto prima di cominciare');
        break;
      }

      await lavora(row, lease, {
        store,
        handlers,
        result,
        signal: spegnimento.signal,
        random: opts.random,
        orologio,
      });
    }
  } catch (error) {
    // La presa stessa e' fallita: nessun item e' stato toccato, quindi non c'e'
    // niente da rimettere a posto.
    result.errors.push(`presa: ${redactError(error)}`);
  } finally {
    spegnimento.dismetti();
  }

  return result;
}

async function lavora(
  row: SyncRequestRow,
  lease: SyncRequestLease,
  ctx: {
    store: QueueStore;
    handlers: Record<SyncRequestType, Handler>;
    result: DrainResult;
    signal: AbortSignal;
    random?: () => number;
    orologio: () => Date;
  },
): Promise<void> {
  const { store, handlers, result, orologio } = ctx;

  // Tipo sconosciuto: lettera morta subito, non attesa eterna.
  //
  // All'accodamento c'e' gia' un controllo, quindi qui non ci si arriva in
  // condizioni normali: ci si arriva con una riga scritta da una versione
  // dell'app che conosceva un tipo in piu', o in meno. Ritentarla non la
  // aggiusterebbe, e lasciarla in coda la renderebbe invisibile — che e'
  // esattamente com'era prima, quando il drenaggio faceva `continue`.
  if (!isSyncRequestType(row.type)) {
    console.error(
      `[coda] ALLARME tipo sconosciuto "${row.type}" sull'item ${row.id}: messo in lettera morta`,
    );
    await store.deadLetter(lease, new Error(`tipo sconosciuto: ${row.type}`), orologio());
    result.unknownType++;
    result.errors.push(`item ${row.id}: tipo sconosciuto ${row.type}`);
    return;
  }

  const tipo: SyncRequestType = row.type;

  if (RICHIEDE_LUCCHETTO.has(tipo) && !row.shopId) {
    console.error(`[coda] ALLARME item ${row.id} di tipo ${tipo} senza negozio: lettera morta`);
    await store.deadLetter(lease, new Error('item senza negozio'), orologio());
    result.unknownType++;
    return;
  }

  // Il battito sull'item, distinto da quello del lucchetto: sono due prese
  // diverse e possono perdersi separatamente. Se questa si perde vuol dire che
  // qualcun altro ha ripreso l'item, e allora quel che stiamo facendo non ha
  // piu' titolo per concludersi.
  const interrotto = new AbortController();
  const propaga = () => interrotto.abort(ctx.signal.reason);
  if (ctx.signal.aborted) propaga();
  else ctx.signal.addEventListener('abort', propaga, { once: true });

  let leasePerso = false;
  const battito = setInterval(() => {
    void (async () => {
      try {
        if (!(await store.heartbeat(lease, orologio()))) {
          leasePerso = true;
          interrotto.abort(new Error('presa sull\'item perduta'));
        }
      } catch {
        // Un battito perso puo' essere un singhiozzo: ci pensa la scadenza.
      }
    })();
  }, ITEM_HEARTBEAT_MS);
  battito.unref?.();

  // Il tetto di durata, per tipo. Il lucchetto ne ha uno suo, ma non tutti i
  // tipi passano dal lucchetto — 'compliance-request' no — e un lavoro senza
  // tetto su una funzione serverless non finisce: lo stronca la piattaforma, a
  // meta' di una scrittura e senza che niente resti scritto da nessuna parte.
  const scaduto = setTimeout(
    () => interrotto.abort(new Error(`lavoro interrotto dopo ${MAX_RUN_MS[tipo]} ms`)),
    MAX_RUN_MS[tipo],
  );
  scaduto.unref?.();

  try {
    const handler = handlers[tipo];
    let esito: 'eseguito' | 'occupato' | 'non-disponibile' = 'eseguito';

    if (RICHIEDE_LUCCHETTO.has(tipo)) {
      esito = await runWithShopLease(
        row.shopId as string,
        (shopLease) => handler(row, { lease: shopLease, signal: interrotto.signal }),
        { maxRunMs: MAX_RUN_MS[tipo], signal: interrotto.signal },
      );
    } else {
      await handler(row, { signal: interrotto.signal });
    }

    if (esito === 'occupato') {
      await store.release(
        lease,
        new Date(orologio().getTime() + BUSY_RETRY_MS),
        'negozio gia\' in lavorazione: si riprova',
      );
      result.skippedLocked++;
      return;
    }

    if (esito === 'non-disponibile') {
      await store.release(
        lease,
        new Date(orologio().getTime() + LOCK_UNAVAILABLE_RETRY_MS),
        'lucchetto non disponibile: si riprova',
      );
      result.lockUnavailable++;
      return;
    }

    // Il lavoro e' finito, ma nel frattempo potremmo non essere piu' noi a
    // farlo. Dichiararlo completato qui sarebbe la bugia peggiore della coda:
    // l'item sparirebbe mentre un altro processo lo sta ancora eseguendo.
    //
    // I tre modi di non essere piu' noi non si trattano allo stesso modo, e la
    // differenza non e' cosmetica: sbagliandola, l'item torna prendibile
    // nell'istante stesso in cui lo si restituisce, e questo stesso giro lo
    // ripesca e lo rifa'.
    if (leasePerso) {
      // L'item e' gia' di qualcun altro: qualunque scrittura nostra verrebbe
      // rifiutata dalla guardia, ed e' giusto cosi'. Non si tocca niente.
      result.errors.push(`item ${row.id}: possesso perduto durante il lavoro`);
      return;
    }

    if (ctx.signal.aborted) {
      // Spegnimento: non e' colpa del lavoro, e il tentativo non si consuma.
      // Il giro si ferma comunque subito dopo, quindi non lo ripesca lui.
      await store.release(lease, orologio(), 'drenaggio interrotto: si riprende al giro dopo');
      result.errors.push(`item ${row.id}: drenaggio interrotto`);
      return;
    }

    if (interrotto.signal.aborted) {
      // Tetto di durata superato. Questo invece E' un tentativo andato a vuoto:
      // conta, e riparte distanziato. Restituirlo senza contarlo vorrebbe dire
      // riprovarlo all'infinito senza mai avvicinarsi alla lettera morta — e,
      // peggio, riprovarlo subito, in questo stesso giro.
      await dopoIlFallimento(
        row,
        lease,
        interrotto.signal.reason ?? new Error('lavoro interrotto'),
        ctx,
      );
      return;
    }

    if (await store.complete(lease, orologio())) {
      result.completed++;
    } else {
      // La guardia sul gettone ha detto di no: qualcun altro ha ripreso l'item
      // mentre lo finivamo. Non e' un errore da ritentare — il lavoro e' stato
      // fatto — ma va detto forte, perche' significa che due processi si sono
      // sovrapposti e la ragione va capita.
      console.error(
        `[coda] ALLARME item ${row.id} concluso senza possesso: chiusura rifiutata dal gettone`,
      );
      result.errors.push(`item ${row.id}: concluso senza possesso`);
    }
  } catch (error) {
    await dopoIlFallimento(row, lease, error, ctx);
  } finally {
    clearInterval(battito);
    clearTimeout(scaduto);
    ctx.signal.removeEventListener('abort', propaga);
  }
}

/**
 * Cosa si fa di un item che ha fallito.
 *
 * Mai cancellarlo, ed e' il cambiamento che conta piu' di tutti: la coda
 * vecchia, su eccezione, chiamava `job.remove()`. I tentativi e il backoff
 * erano configurati con cura su BullMQ e non li applicava nessuno, quindi un
 * errore di rete di due secondi perdeva una sincronizzazione per sempre.
 */
async function dopoIlFallimento(
  row: SyncRequestRow,
  lease: SyncRequestLease,
  error: unknown,
  ctx: { store: QueueStore; result: DrainResult; random?: () => number; orologio: () => Date },
): Promise<void> {
  const { store, result } = ctx;
  const messaggio = redactError(error);
  const adesso = ctx.orologio();

  // `row.attempts` e' gia' quello dopo la presa: la presa incrementa, cosi' un
  // item che fa morire il processo prima di poter riferire qualunque cosa conta
  // comunque il suo tentativo e non gira in tondo per sempre.
  if (isExhausted(row.attempts)) {
    const fatto = await store.deadLetter(lease, error, adesso);
    result.deadLettered++;
    result.errors.push(`item ${row.id}: ${messaggio}`);
    console.error(
      `[coda] ALLARME item ${row.id} (${row.type}${row.shopId ? `, negozio ${row.shopId}` : ''}) ` +
        `fermo dopo ${row.attempts} tentativi: ${messaggio}. ` +
        `Si riparte con: npm run queue:replay -- ${row.id}` +
        (fatto ? '' : ' — NOTA: la riga non era piu\' nostra, stato non aggiornato'),
    );
    return;
  }

  const prossimo = nextAttemptAfterFailure(row.attempts, adesso, ctx.random);
  await store.reschedule(lease, prossimo, error, adesso);
  result.retried++;
  result.errors.push(`item ${row.id}: ${messaggio}`);
  console.warn(
    `[coda] item ${row.id} (${row.type}) fallito al tentativo ${row.attempts}, ` +
      `si riprova alle ${prossimo.toISOString()}: ${messaggio}`,
  );
}

/**
 * L'interruzione ordinata.
 *
 * Un SIGTERM arriva a un deploy, a un riavvio, allo spegnimento del worker
 * locale. Senza ascoltarlo, il processo verrebbe stroncato a meta' di una
 * scrittura e l'item resterebbe 'processing' fino alla scadenza del lease.
 * Ascoltandolo, lo si restituisce subito.
 */
function ascoltaSpegnimento(esterno?: AbortSignal): { signal: AbortSignal; dismetti(): void } {
  const controller = new AbortController();
  const fermati = () => controller.abort(new Error('spegnimento richiesto'));

  if (esterno?.aborted) fermati();
  else esterno?.addEventListener('abort', fermati, { once: true });

  process.on('SIGTERM', fermati);
  process.on('SIGINT', fermati);

  return {
    signal: controller.signal,
    dismetti() {
      // Vanno tolti: questa funzione la si chiama a ogni invocazione, e i
      // listener di `process` non se ne vanno da soli — dopo qualche giro Node
      // comincia a stampare avvisi di perdita e il messaggio vero si perde
      // in mezzo.
      process.off('SIGTERM', fermati);
      process.off('SIGINT', fermati);
      esterno?.removeEventListener('abort', fermati);
    },
  };
}
