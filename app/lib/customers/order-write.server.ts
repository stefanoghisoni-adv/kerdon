import type { SupabaseClient } from '@supabase/supabase-js';
import { orderToRows, type ShopifyOrder } from './order-rows';

/**
 * L'ordine, le sue righe e la riconciliazione: una strada sola.
 *
 * Prima erano due: la corsa periodica scriveva ordine e righe in blocco, il
 * webhook li scriveva uno per uno, e nessuna delle due toglieva mai una riga.
 * Le due copie erano libere di divergere, e divergevano — il webhook scriveva
 * un prezzo ricostruito dal payload REST, la corsa quello di GraphQL, sulla
 * stessa colonna.
 *
 * COSA VUOL DIRE RICONCILIARE, E QUANDO E' VIETATO. Una riga puo' sparire da un
 * ordine: il merchant la toglie modificandolo, oppure il rimborso la annulla del
 * tutto. Se resta nel database del merchant, continua a portare margine per
 * merce che non c'e'. Toglierla pero' e' consentito SOLO con l'elenco completo
 * in mano (`lines_complete === true`): su un elenco troncato, "questa riga non
 * l'ho vista" non vuol dire "questa riga non c'e' piu'" — vuol dire che si e'
 * letto fino a cento. Cancellare li' significa cancellare righe che esistono, e
 * proprio negli ordini piu' grandi. Con l'elenco incompleto si aggiornano le
 * righe viste, si dichiara una riparazione in sospeso, e non si cancella
 * niente.
 *
 * PERCHE' NON E' UNA TRANSAZIONE SOLA, e cosa si e' fatto al suo posto. Le
 * scritture sul database del merchant passano da PostgREST, che una transazione
 * fra piu' chiamate non la sa aprire; l'unica via transazionale sarebbe la
 * Management API, cioe' far passare OGNI ordine di OGNI negozio da un endpoint
 * pensato per la DDL e a rate limit stretto. Il rimedio non e' fingere
 * l'atomicita' ma renderla non necessaria: i tre passi sono nell'ordine per cui
 * un'interruzione lascia sempre uno stato che il tentativo dopo ripara —
 * l'ordine prima delle righe (mai righe orfane), le righe prima della
 * cancellazione (mai un ordine svuotato e non riscritto), e ogni passo e' un
 * upsert su chiave univoca, quindi la stessa consegna ripetuta due volte o due
 * consegne in parallelo arrivano allo stesso risultato senza duplicare niente.
 */

export interface ApplyOrderResult {
  /** Quante righe si sono scritte. */
  lines: number;
  /** Quante righe obsolete si sono tolte. Zero se non si e' potuto riconciliare. */
  deleted: number;
  /**
   * L'elenco delle righe era troncato: si e' scritto quel che c'era, non si e'
   * cancellato niente, e qualcuno deve tornarci sopra.
   */
  repairPending: boolean;
}

export type OrderWriteStep = 'order' | 'lines';

export class OrderWriteError extends Error {
  /** Quale passo e' fallito: e' cio' che poi finisce nel registro. */
  readonly step: OrderWriteStep;

  constructor(step: OrderWriteStep, message: string) {
    super(message);
    this.name = 'OrderWriteError';
    this.step = step;
  }
}

/** PostgREST ha un tetto a quante righe accetta in una volta. */
const CHUNK = 1000;

/**
 * Scrive un ordine canonico nel database del merchant.
 *
 * L'ordine dev'essere quello letto da GraphQL, non quello del payload del
 * webhook: il payload non porta ne' `currentQuantity` ne' il netto di riga, che
 * sono i due valori su cui si fa il margine.
 */
export async function applyOrderToMerchant(opts: {
  supabase: SupabaseClient;
  order: ShopifyOrder;
  syncedAt?: Date;
}): Promise<ApplyOrderResult | null> {
  const rows = orderToRows(opts.order, opts.syncedAt ?? new Date());
  if (!rows) return null;

  // Prima l'ordine, poi le righe: al contrario, se l'ordine fallisse,
  // resterebbero righe che nessuna query saprebbe raggruppare.
  const { error: orderError } = await opts.supabase
    .from('orders')
    .upsert([rows.order], { onConflict: 'shopify_order_id', ignoreDuplicates: false });

  if (orderError) {
    throw new OrderWriteError('order', orderError.message);
  }

  for (let i = 0; i < rows.lines.length; i += CHUNK) {
    const { error: linesError } = await opts.supabase
      .from('order_lines')
      .upsert(rows.lines.slice(i, i + CHUNK), {
        onConflict: 'shopify_line_id',
        ignoreDuplicates: false,
      });

    if (linesError) {
      throw new OrderWriteError('lines', linesError.message);
    }
  }

  const complete = opts.order.lines_complete === true;
  if (!complete) {
    return { lines: rows.lines.length, deleted: 0, repairPending: true };
  }

  const deleted = await deleteStaleLines(
    opts.supabase,
    [rows.order.shopify_order_id],
    rows.lines.map((line) => line.shopify_line_id),
  );

  return { lines: rows.lines.length, deleted, repairPending: false };
}

/**
 * Le righe che quegli ordini non hanno piu'.
 *
 * Prende PIU' ordini insieme perche' la corsa periodica ne legge cinquanta per
 * pagina, e una cancellazione a testa sarebbe cinquanta chiamate in piu' per
 * pagina — su un negozio con anni di storico, decine di migliaia. Un solo giro
 * non e' meno preciso: l'identificativo di una riga e' unico su tutto il
 * negozio, quindi una riga che compare fra quelle da tenere e' corrente per il
 * suo ordine e per nessun altro.
 *
 * Chi chiama deve aver gia' verificato che di OGNI ordine passato si conosca
 * l'elenco completo delle righe. Qui non c'e' modo di controllarlo, e un ordine
 * incompleto infilato in questo elenco si vedrebbe cancellare le righe che non
 * abbiamo letto.
 *
 * Un ordine rimasto senza nessuna riga cancella tutto cio' che aveva, e va
 * distinto dal caso in cui non si e' letto niente: qui l'elenco vuoto e'
 * l'elenco vero, perche' ci si arriva solo con l'elenco completo in mano.
 *
 * L'errore non si propaga come gli altri due: ordini e righe correnti sono gia'
 * scritti e sono la parte che conta, mentre una riga obsoleta rimasta indietro
 * la toglie il tentativo dopo. Farlo fallire qui vorrebbe dire far ripetere a
 * Shopify una consegna gia' andata a buon fine per il 90%.
 */
export async function deleteStaleLines(
  supabase: SupabaseClient,
  orderIds: number[],
  keep: number[],
): Promise<number> {
  if (orderIds.length === 0) return 0;

  const query = supabase.from('order_lines').delete().in('shopify_order_id', orderIds);

  const { data, error } =
    keep.length > 0
      ? await query.not('shopify_line_id', 'in', `(${keep.join(',')})`).select('shopify_line_id')
      : await query.select('shopify_line_id');

  if (error) {
    console.warn(
      `[order-write] righe obsolete non rimosse (${orderIds.length} ordini): ${error.message}`,
    );
    return 0;
  }

  return Array.isArray(data) ? data.length : 0;
}
