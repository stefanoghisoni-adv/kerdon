// app/lib/shipping/recompute-inline.server.ts
//
// Il ricalcolo dei costi logistici DENTRO il salvataggio di un prezzo.
//
// PERCHE'. Prima ogni salvataggio accodava il ricalcolo e rispondeva subito: il
// merchant apriva la Dashboard o la tab Clienti e vedeva i profitti di prima
// finche' la coda non passava. La sua richiesta e' stata esplicita: salvato un
// prezzo, i numeri devono essere gia' quelli nuovi. Il profitto per prodotto
// il costo logistico non lo contiene di proposito, quindi cambiano solo
// Dashboard e Clienti.
//
// COME. La stessa funzione a pagine del job (processLogisticsRecompute), con un
// budget corto: niente seconda copia del giro sulle pagine, che resterebbe
// indietro alla prima correzione dell'altra. Se il budget basta, la risposta
// puo' dire "numeri aggiornati"; se non basta, la funzione accoda da sola la
// continuazione dal suo cursore (il meccanismo delle tappe gia' esistente) e la
// risposta dice "a breve".
//
// IL LUCCHETTO. Si lavora sotto lo stesso lucchetto del negozio che usano il
// job e le sincronizzazioni. Senza, un ricalcolo della coda partito un attimo
// prima con le tariffe vecchie potrebbe finire DOPO di noi e riscrivere i costi
// di ieri. Negozio occupato = si accoda, e la catena di accodamento
// (recompute-enqueue.server) mette il ricalcolo dopo quello in corso.
//
// MAI SOLLEVARE. La configurazione e' gia' salva quando si arriva qui: un
// guasto del ricalcolo non deve trasformare in errore un salvataggio riuscito.
// Qualunque cosa vada storta ripiega sulla coda.

import { randomUUID } from 'node:crypto';
import { runWithShopLease } from '~/lib/queue/shop-lock.server';
import { redactError } from '~/lib/queue/queue-model';
import { enqueueLogisticsRecompute } from './recompute-enqueue.server';
import { processLogisticsRecompute, type RecomputeOutcome } from './recompute.server';

/**
 * Quanto la richiesta lavora sugli ordini prima di passare il resto alla coda.
 *
 * IL TETTO DELLA FUNZIONE. Nessuna rotta puo' dichiarare il suo `maxDuration`
 * in questo progetto (vedi il commento in testa ad `action` in
 * routes/spedizioni.tsx): l'app gira come una funzione sola con il tetto di
 * default del progetto Vercel, lo stesso su cui contano i job della coda
 * (MAX_RUN_MS, 270 s). Quindici secondi ci stanno dentro con ampio margine.
 *
 * IL LIMITE VERO e' un altro: il merchant sta guardando un pulsante che gira.
 * Una pagina da 500 ordini e' una SELECT e un UPDATE sulla Management API,
 * circa 1-1,5 s: quindici secondi coprono 5-7 mila ordini, cioe' i negozi
 * piccoli e medi. Oltre, meglio rispondere e lasciare il resto alla coda,
 * che prosegue dal cursore.
 */
export const INLINE_RECOMPUTE_BUDGET_MS = 15_000;

/**
 * Il tetto duro, oltre il budget: il budget si controlla fra una pagina e
 * l'altra, e una pagina lenta puo' sforarlo. A questo punto il lucchetto
 * interrompe la corsa, e l'interruzione ripiega sulla coda come un guasto.
 */
export const INLINE_RECOMPUTE_MAX_RUN_MS = 45_000;

/**
 * Cosa puo' dire la risposta sui numeri.
 * - 'updated': Dashboard e Clienti mostrano gia' i costi nuovi.
 * - 'pending': il resto e' in coda, si aggiornano a breve.
 * - null: adesso non c'era niente da ricalcolare (database fermo, ordini non
 *   sincronizzati, tabelle non pronte) oppure il database owner non risponde:
 *   nessuna promessa sui numeri.
 */
export type NumbersRefresh = 'updated' | 'pending' | null;

export interface InlineRecomputeOptions {
  /** Iniettabili per le prove. */
  budgetMs?: number;
  clock?: () => number;
}

/**
 * Ricalcola i costi logistici del negozio adesso, entro il budget.
 * Da chiamare DOPO aver salvato. Non solleva mai.
 */
export async function recomputeLogisticsAfterSave(
  shopId: string,
  opts: InlineRecomputeOptions = {},
): Promise<NumbersRefresh> {
  let esito: RecomputeOutcome | null = null;

  try {
    const lucchetto = await runWithShopLease(
      shopId,
      async (lease) => {
        esito = await processLogisticsRecompute(shopId, {
          lease,
          signal: lease.signal,
          // Lega la chiave dell'eventuale continuazione a questa corsa, come
          // l'id dell'item lega quella del job.
          jobId: `in-linea:${randomUUID()}`,
          budgetMs: opts.budgetMs ?? INLINE_RECOMPUTE_BUDGET_MS,
          clock: opts.clock,
        });
      },
      { maxRunMs: INLINE_RECOMPUTE_MAX_RUN_MS },
    );

    if (lucchetto === 'occupato') {
      // Qualcuno sta gia' lavorando il negozio: aspettarlo qui vorrebbe dire
      // tenere fermo il merchant. La catena di accodamento mette il ricalcolo
      // dopo quello in corso.
      await enqueueLogisticsRecompute(shopId);
      return 'pending';
    }
    if (lucchetto === 'non-disponibile') {
      // Il lucchetto vive sul database owner, e se non risponde lui con ogni
      // probabilita' non risponde nemmeno la coda, che sta nello stesso
      // posto. Si tenta comunque (non solleva mai: se era un singhiozzo il job
      // entra), ma senza promettere "a breve" un ricalcolo che forse non c'e'.
      await enqueueLogisticsRecompute(shopId);
      return null;
    }
  } catch (error) {
    console.warn(
      `[logistics-recompute] ricalcolo nel salvataggio non riuscito per il negozio ${shopId}, si ripiega sulla coda: ${redactError(error)}`,
    );
    await enqueueLogisticsRecompute(shopId);
    return 'pending';
  }

  // Letto in una variabile a parte: TypeScript non vede l'assegnazione fatta
  // dentro la callback e restringerebbe `esito` a null.
  const finale = esito as RecomputeOutcome | null;
  if (finale === 'completed') return 'updated';
  if (finale === 'continued') return 'pending';

  // 'skipped' (o nessun esito): adesso non si poteva. Si accoda comunque, come
  // prima di questo cambio: il job ricontrolla quando parte, e nel frattempo lo
  // schema puo' essersi allineato o il database riacceso.
  await enqueueLogisticsRecompute(shopId);
  return null;
}
