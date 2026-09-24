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
 * Il costo unitario da usare per questa riga.
 *
 * Il costo fissato vince sul corrente, e il motivo e' che il costo corrente e'
 * l'unico che Shopify conserva: cambiarlo riscriveva all'indietro il margine di
 * ogni ordine gia' passato, anche di un anno prima. Quando il merchant cambia un
 * costo e sceglie di non toccare il passato, le righe gia' vendute vengono
 * chiuse con il valore che stavano usando fino a quel momento — e da li' in poi
 * quel valore e' loro, qualunque cosa faccia il costo di listino.
 *
 * `COALESCE` e non un CASE: una riga senza valore fissato non e' un caso
 * particolare, e' la normalita' — finche' nessuno cambia un costo, il corrente
 * E' quello con cui la riga e' stata calcolata, e le due strade coincidono.
 */
export const LINE_UNIT_COST = 'COALESCE(l.unit_cost_at_sale, p.cost_per_item)';

/**
 * Il costo della merce rimasta al cliente.
 *
 * `current_quantity` e non `quantity`: su una riga rimborsata a meta' il costo
 * sostenuto e' quello delle unita' che non sono tornate indietro.
 */
export const LINE_COST_BASIS = `${LINE_UNIT_COST} * l.current_quantity`;

/**
 * Le due condizioni senza le quali la riga non ha un contributo CALCOLABILE.
 *
 * Costo mancante e netto mancante non sono profitto zero: sono profitto ignoto,
 * e vanno tenuti fuori dalla somma e contati a parte. `line_net_total` puo'
 * mancare sulle righe scritte prima che questa colonna esistesse, finche' la
 * corsa periodica non le rilegge.
 *
 * Il costo si guarda dopo il COALESCE, quindi una riga con il conto chiuso
 * risponde col valore fissato e non col costo di listino: e' tutto il senso del
 * congelamento.
 *
 * Attenzione a cosa vuol dire per una riga senza valore fissato ma con la data
 * del congelamento sopra: sparisce dal conto e non ci rientra piu', qualunque
 * costo il merchant inserisca. Quella combinazione oggi non si crea — si
 * congela solo un costo precedente vero (`lib/products/cost-scope`) — e le
 * righe che se l'erano presa le sblocca il passo 11 di `merchant-migrations`.
 * Va ricordato qui perche' e' qui che il danno si vedeva: profitto zero su una
 * vendita vera, senza niente da premere per uscirne.
 */
export const LINE_MEASURABLE = `${LINE_UNIT_COST} IS NOT NULL AND l.line_net_total IS NOT NULL`;

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

/**
 * Il costo logistico degli ordini (spedizione, imballo, rientro), contato UNA
 * volta per ordine.
 *
 * PERCHE' NON BASTA UN SUM. Il costo sta sull'ordine (`o.logistics_cost`), ma
 * le query del profitto uniscono `orders` a `order_lines`: ogni ordine compare
 * tante volte quante sono le sue righe. `SUM(o.logistics_cost)` toglierebbe 40
 * a un ordine di quattro righe con 10 di spedizione. E `SUM(DISTINCT ...)` non
 * e' la cura: due ordini diversi con lo stesso costo varrebbero uno.
 *
 * COME. Si somma il costo solo sulla PRIMA riga dell'ordine — quella con lo
 * `shopify_line_id` piu' basso, che e' UNIQUE NOT NULL, quindi c'e' sempre ed
 * e' una sola. La sottoquery e' correlata come quella della valuta qui sopra, e
 * cammina sull'indice `idx_order_lines_order`. Scelta per leggibilita': dice
 * esattamente "una volta per ordine" senza costringere ogni query a diventare
 * una sottoquery per ordine piu' un'aggregazione esterna.
 *
 * Funziona in qualunque raggruppamento in cui un ordine cade intero in un
 * gruppo solo (per cliente, per negozio): e' il caso di tutte le query della
 * tab Clienti, che non escludono mai singole righe. Una query che un giorno
 * filtrasse le righe (per prodotto, per variante) potrebbe scartare proprio la
 * prima e perdere il costo: li' serve un'altra forma, ed e' anche il motivo per
 * cui il profitto per prodotto il costo logistico non lo porta.
 *
 * `logistics_cost` NULL — gli ordini scritti prima che la colonna esistesse —
 * vale 0: un profitto NULL cancellerebbe tutto il resto del conto. Il
 * COALESCE esterno copre il gruppo senza nessuna riga.
 *
 * Non filtra da se' gli ordini che non sono vendite: si usa SOLO in una query
 * con `ORDER_COUNTS_AS_SALE` nel WHERE, come la somma dei contributi. Un ordine
 * annullato o in valute discordi non arriva nemmeno al FILTER, e non sottrae
 * niente.
 */
export const ORDER_LOGISTICS_SUM = `COALESCE(SUM(COALESCE(o.logistics_cost, 0)) FILTER (WHERE l.shopify_line_id = (
    SELECT MIN(fl.shopify_line_id) FROM order_lines fl
    WHERE fl.shopify_order_id = o.shopify_order_id
  )), 0)`;

/**
 * Il profitto degli ordini: contributo delle righe meno il costo logistico.
 *
 * Tutte le query della tab Clienti scrivono il profitto cosi', da qui: la
 * sottrazione in un posto solo, per la stessa ragione del contributo netto.
 */
export const ORDER_PROFIT_SUM = `(${NET_CONTRIBUTION_SUM} - ${ORDER_LOGISTICS_SUM})`;

/**
 * Il contributo netto di una riga, fuori dall'SQL: stessa formula, stesso ordine.
 *
 * `unitCostAtSale` ha la precedenza come nell'SQL, ed e' un parametro a se' e
 * non un valore gia' risolto dal chiamante: risolverlo fuori vorrebbe dire due
 * posti in cui ricordarsi quale dei due costi vince, che e' esattamente cio' che
 * questo file esiste per impedire.
 *
 * Il costo logistico qui NON c'e', e di proposito: e' un costo dell'ordine, non
 * della riga, e una funzione per riga non ha modo di contarlo una volta sola.
 * Nell'SQL lo toglie `ORDER_LOGISTICS_SUM`; chi somma righe in TypeScript
 * (oggi nessuno fuori dai test: `profit.ts`) deve toglierlo per ordine.
 */
export function netContribution(input: {
  lineNetTotal: number | null;
  unitCost: number | null;
  unitCostAtSale?: number | null;
  currentQuantity: number;
}): number | null {
  const costo = input.unitCostAtSale ?? input.unitCost;
  if (input.lineNetTotal == null || costo == null) return null;
  return input.lineNetTotal - costo * input.currentQuantity;
}
