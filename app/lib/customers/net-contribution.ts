/**
 * Il contributo netto di una riga d'ordine, scritto in un posto solo.
 *
 * Il conto vero e' `line_net_total - cost_per_item * current_quantity`, e la
 * ragione per cui vive qui e non dentro ciascuna query e' che finora viveva
 * dentro ciascuna query: la stessa moltiplicazione era copiata in quattro
 * interrogazioni della tab Clienti, in quella dei top prodotti e in una funzione
 * TypeScript, e ogni copia era libera di restare indietro. Ne bastava una per
 * mostrare al merchant due profitti diversi nella stessa schermata.
 *
 * PERCHE' NON PIU' `unit_price * quantity`. Sono i due valori che un rimborso
 * rende falsi insieme. `quantity` e' quanto e' stato ordinato e non cambia mai
 * piu': dopo un reso resta li', identica, e moltiplicata per un prezzo qualsiasi
 * racconta merce che il cliente non ha. `unit_price` a sua volta e' un prezzo
 * unitario in cui sono spalmate anche allocazioni di sconto riferite a unita'
 * rimborsate o rimosse. Il totale dell'ordine intanto seguiva
 * `currentTotalPriceSet`, che i rimborsi li riflette: le righe e il loro ordine
 * raccontavano due realta' diverse, e quella sbagliata era sempre la piu'
 * generosa — ricavi e margini piu' alti del vero, in modo credibile e quindi
 * invisibile.
 *
 * `line_net_total` NON si ricava moltiplicando: e' il netto che Shopify
 * dichiara per quella riga. Ricostruirlo da un prezzo unitario significherebbe
 * reintrodurre l'approssimazione da cui si sta scappando — un prezzo unitario
 * con dentro sconti d'ordine spalmati non torna mai esattamente al totale.
 *
 * IL COSTO invece resta una moltiplicazione, e deve esserlo: il costo e'
 * unitario per natura, e la merce di cui il merchant ha sostenuto il costo e'
 * quella rimasta al cliente — `current_quantity`, non `quantity`.
 */

/** Il netto incassato dalla riga, come lo dichiara Shopify. */
export const LINE_NET_TOTAL = 'l.line_net_total';

/**
 * Il costo della merce rimasta al cliente.
 *
 * `current_quantity` e non `quantity`: su una riga rimborsata a meta' il costo
 * sostenuto e' quello delle unita' che non sono tornate indietro.
 */
export const LINE_COST_BASIS = 'p.cost_per_item * l.current_quantity';

/**
 * Le due condizioni senza le quali la riga non ha un contributo CALCOLABILE.
 *
 * Costo mancante e netto mancante non sono profitto zero: sono profitto ignoto,
 * e vanno tenuti fuori dalla somma e contati a parte. `line_net_total` puo'
 * mancare sulle righe scritte prima che questa colonna esistesse, finche' la
 * corsa periodica non le rilegge.
 */
export const LINE_MEASURABLE = 'p.cost_per_item IS NOT NULL AND l.line_net_total IS NOT NULL';

/** Il contributo netto di UNA riga, senza aggregazione. */
export const LINE_NET_CONTRIBUTION = `(${LINE_NET_TOTAL} - ${LINE_COST_BASIS})`;

/**
 * Il contributo netto di una riga quando si conosce, NULL quando no.
 *
 * Serve a chi aggrega dopo (i top prodotti lo fanno in due passaggi): un CASE
 * che lascia NULL e' l'unico modo di far sparire la riga dalle medie invece di
 * abbassarle con uno zero che nessuno ha misurato.
 */
export const LINE_NET_CONTRIBUTION_OR_NULL =
  `CASE WHEN ${LINE_MEASURABLE} THEN ${LINE_NET_CONTRIBUTION} END`;

/** La somma dei contributi, sulle sole righe misurabili. */
export const NET_CONTRIBUTION_SUM =
  `COALESCE(SUM(${LINE_NET_CONTRIBUTION}) FILTER (WHERE ${LINE_MEASURABLE}), 0)`;

/**
 * Il ricavo netto: quanto e' entrato in cassa, rimborsi gia' tolti.
 *
 * Non filtra sul costo — un ricavo si conosce anche senza sapere quanto e'
 * costato — ma usa lo stesso `line_net_total` del contributo, cosi' ricavo e
 * margine parlano della stessa cifra.
 */
export const NET_REVENUE_SUM = `COALESCE(SUM(${LINE_NET_TOTAL}), 0)`;

/** Quante righe hanno concorso davvero al totale, e quante ce n'erano. */
export const COVERED_LINES = `COUNT(l.shopify_line_id) FILTER (WHERE ${LINE_MEASURABLE})`;
export const TOTAL_LINES = 'COUNT(l.shopify_line_id)';

/**
 * L'ordine parla una valuta sola?
 *
 * Sommare importi di valute diverse produce un numero che non esiste in nessuna
 * moneta, e lo produce in silenzio: nessun errore, nessuna riga storta, solo un
 * profitto sbagliato. `shopMoney` dovrebbe rendere il caso impossibile — e'
 * sempre la valuta del negozio — ma "dovrebbe" non basta per un numero che il
 * merchant usa per decidere, e le righe scritte prima che `line_currency`
 * esistesse non lo dichiarano affatto.
 *
 * Si esclude l'ORDINE intero e non la singola riga discorde: un ordine con
 * dentro due valute e' un ordine di cui non si sa dire il totale, e tenerne
 * meta' sarebbe peggio che lasciarlo fuori. Le righe che la valuta non la
 * dichiarano (le vecchie) non escludono niente: assenza non e' discordanza.
 */
export const ORDER_CURRENCY_CONSISTENT = `NOT EXISTS (
    SELECT 1 FROM order_lines xl
    WHERE xl.shopify_order_id = o.shopify_order_id
      AND xl.line_currency IS NOT NULL
      AND o.currency IS NOT NULL
      AND xl.line_currency <> o.currency
  )`;

/**
 * Le condizioni che un ordine deve soddisfare per entrare in un conto: non
 * annullato, e in una valuta sola.
 *
 * Insieme perche' non si dimentichi la seconda scrivendo la prima, che e'
 * esattamente com'e' andata finora.
 */
export const ORDER_COUNTS_AS_SALE = `o.cancelled_at IS NULL\n  AND ${ORDER_CURRENCY_CONSISTENT}`;

/** Il contributo netto di una riga, fuori dall'SQL: stessa formula, stesso ordine. */
export function netContribution(input: {
  lineNetTotal: number | null;
  unitCost: number | null;
  currentQuantity: number;
}): number | null {
  if (input.lineNetTotal == null || input.unitCost == null) return null;
  return input.lineNetTotal - input.unitCost * input.currentQuantity;
}
