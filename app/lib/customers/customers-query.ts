/**
 * La domanda che la tab Clienti fa al database del merchant.
 *
 * Il conto si fa in SQL e non in memoria: un negozio con centomila ordini non
 * si porta in JavaScript per sommarlo, e il raggruppamento per cliente e' esatta-
 * mente cio' che un database sa fare meglio di noi.
 *
 * Il costo si legge dai prodotti al momento della lettura — e' la giuntura fra
 * `order_lines` e `products` — ed e' per questo che compilare un costo oggi
 * riscrive il profitto di ieri senza che nessuno ricalcoli niente.
 *
 * La formula del contributo netto non e' scritta qui e non lo e' piu' in nessuna
 * di queste query: sta in `net-contribution`, in un posto solo, insieme al
 * perche' non sia piu' `unit_price * quantity`. Quattro copie della stessa
 * moltiplicazione — tante ce n'erano in questo file — sono quattro occasioni
 * perche' una resti indietro, e ne basta una per mostrare al merchant due
 * profitti diversi nella stessa schermata.
 *
 * Vale adesso anche per il PERIODO. Il filtro sulle date era riscritto a mano in
 * ognuna di queste query, con dei confini che il fuso del negozio non lo
 * conoscevano: sta in `dates/order-window`, dove c'e' scritto anche perche' un
 * giorno non duri sempre ventiquattro ore.
 *
 * E vale per il COSTO LOGISTICO: ogni `profit` qui e' `ORDER_PROFIT_SUM`, cioe'
 * contributo delle righe meno spedizione, imballo e rientro dell'ordine. La
 * giuntura con `order_lines` ripete l'ordine una volta per riga, e sommare il
 * costo "normalmente" lo toglierebbe tante volte quante righe: il frammento lo
 * conta sulla prima riga soltanto, e il perche' sta accanto a lui.
 */


import { placedAtWindowSQL } from '~/lib/dates/order-window';
import { comparisonRange } from '~/lib/dates/ranges';
import {
  COVERED_LINES,
  NET_REVENUE_SUM,
  ORDER_COUNTS_AS_SALE,
  ORDER_PROFIT_SUM,
  TOTAL_LINES,
} from './net-contribution';

// La verifica delle date vive accanto a chi le date le costruisce: chi le
// produce e chi le controlla non possono avere due idee diverse di cosa sia una
// data. Resta esposta da qui perche' e' da qui che le rotte l'hanno sempre
// presa.
export { isCalendarDate } from '~/lib/dates/ranges';

/**
 * Il periodo di una lettura, con il fuso di chi lo sta guardando.
 *
 * Il fuso e' obbligatorio e puo' essere `null`, non assente: `null` vuol dire
 * "questo negozio non ce l'ha, si conta in UTC" ed e' una risposta: dimenticare
 * il campo invece no, ed era esattamente cio' che succedeva prima.
 */
export interface QueryRange {
  /** Primo giorno compreso. */
  from: string;
  /** Ultimo giorno compreso: la query lo estende fino alla mezzanotte dopo. */
  to: string;
  /** Il fuso del negozio (`shops.iana_timezone`). null = si conta in UTC. */
  timeZone: string | null;
}

export interface CustomersRangeInput extends QueryRange {
  /** Quanti clienti al massimo, per non riportare un negozio intero. */
  limit?: number;
}

/**
 * I clienti con i loro numeri nel periodo scelto.
 *
 * Gli ordini annullati restano fuori dal conto ma non dal database: sono merce
 * mai partita o tornata indietro, non profitto. Un ordine RIMBORSATO invece
 * resta dentro: la vendita c'e' stata, e a portarla a zero sono la quantita'
 * corrente e il netto di riga, non un'esclusione in blocco.
 *
 * `covered_lines` e `total_lines` viaggiano con il profitto perche' senza di
 * loro il numero mentirebbe per omissione: una riga il cui prodotto non ha
 * ancora un costo non vale profitto zero, vale profitto ignoto, e chi guarda
 * deve poterlo sapere.
 */
export function customersInRangeSQL(input: CustomersRangeInput): string {
  const window = placedAtWindowSQL(input, input.timeZone);
  const limit = Number.isInteger(input.limit) && input.limit! > 0 ? input.limit! : 500;

  return `
SELECT
  o.shopify_customer_id AS customer_id,
  MAX(o.customer_first_name) AS first_name,
  MAX(o.customer_last_name) AS last_name,
  COUNT(DISTINCT o.shopify_order_id) AS orders,
  ${ORDER_PROFIT_SUM} AS profit,
  ${COVERED_LINES} AS covered_lines,
  ${TOTAL_LINES} AS total_lines,
  -- La valuta con cui il negozio vende, non quella con cui paga noi: il
  -- profitto e' suo, e va scritto nei soldi che incassa.
  MAX(o.currency) AS currency,
  -- Il cliente e' anche fra quelli sincronizzati? Lo dice la sola presenza
  -- della sua riga: la tabella dei clienti contiene chi ha dato consenso.
  BOOL_OR(c.shopify_customer_id IS NOT NULL) AS synced,
  -- Email e telefono non finiscono in tabella, ma viaggiano con la riga: sono
  -- i due modi in cui un cliente si ritrova quando del nome non si e' sicuri —
  -- un cognome scritto a meta', un omonimo — e la ricerca lavora sulle righe
  -- gia' caricate, quindi cio' che non arriva qui non si puo' cercare.
  MAX(c.email_address) AS email,
  MAX(c.phone_number) AS phone
FROM orders o
JOIN order_lines l ON l.shopify_order_id = o.shopify_order_id
LEFT JOIN products p ON p.shopify_variant_id = l.shopify_variant_id
LEFT JOIN customers c ON c.shopify_customer_id = o.shopify_customer_id
WHERE ${ORDER_COUNTS_AS_SALE}
  AND o.shopify_customer_id IS NOT NULL
  AND ${window}
GROUP BY o.shopify_customer_id
ORDER BY profit DESC
LIMIT ${limit};`.trim();
}

/**
 * Il profitto di sempre, per gli stessi clienti.
 *
 * Sta in una query a parte e non in una colonna della prima: "lifetime" non
 * conosce il periodo scelto, e infilarlo nella stessa GROUP BY avrebbe voluto
 * dire o filtrarlo con gli altri — e allora non sarebbe lifetime — o leggere
 * due volte la stessa tabella con due filtri diversi nella stessa istruzione.
 */
export function lifetimeProfitSQL(limit = 500): string {
  const rows = Number.isInteger(limit) && limit > 0 ? limit : 500;

  return `
SELECT
  o.shopify_customer_id AS customer_id,
  COUNT(DISTINCT o.shopify_order_id) AS orders,
  ${ORDER_PROFIT_SUM} AS profit
FROM orders o
JOIN order_lines l ON l.shopify_order_id = o.shopify_order_id
LEFT JOIN products p ON p.shopify_variant_id = l.shopify_variant_id
WHERE ${ORDER_COUNTS_AS_SALE}
  AND o.shopify_customer_id IS NOT NULL
GROUP BY o.shopify_customer_id
ORDER BY profit DESC
LIMIT ${rows};`.trim();
}

/**
 * Il periodo di lunghezza uguale che precede quello scelto.
 *
 * Serve al confronto: "rispetto a prima" ha senso solo se "prima" dura quanto
 * "adesso" — trenta giorni contro trenta, un mese contro il mese. Estremi
 * compresi da entrambe le parti, come li intende chi li ha scelti.
 *
 * Il conto non si fa piu' qui: e' lo stesso "periodo precedente" che il
 * selettore in cima alla dashboard offre fra i confronti, e finche' e' stato
 * scritto due volte le due copie potevano rispondere due cose diverse alla
 * stessa domanda. Qui resta il nome con cui questo file l'ha sempre chiamato.
 */
export function previousRange(from: string, to: string): { from: string; to: string } {
  // `comparisonRange` torna null solo per 'none': con 'previousPeriod' il
  // periodo c'e' sempre.
  return comparisonRange({ from, to }, 'previousPeriod')!;
}

/**
 * Il profitto di tutto il negozio nel periodo, in una riga.
 *
 * Stessa giuntura della tabella per cliente — righe d'ordine per costo dei
 * prodotti — senza il raggruppamento: qui interessa il totale, e farlo sommare
 * al database costa una query invece di leggere ogni cliente per poi sommarlo
 * in memoria.
 *
 * `covered_lines` su `total_lines` non e' un dettaglio tecnico: e' quanto di
 * quel totale sia vero. Un profitto calcolato su meta' delle righe e' meta'
 * profitto, e mostrarlo senza dirlo sarebbe la bugia piu' facile che questa app
 * possa raccontare.
 */
export function shopProfitSQL(input: QueryRange): string {
  const window = placedAtWindowSQL(input, input.timeZone);

  return `
SELECT
  COUNT(DISTINCT o.shopify_order_id) AS orders,
  ${ORDER_PROFIT_SUM} AS profit,
  ${COVERED_LINES} AS covered_lines,
  ${TOTAL_LINES} AS total_lines,
  MAX(o.currency) AS currency
FROM orders o
JOIN order_lines l ON l.shopify_order_id = o.shopify_order_id
LEFT JOIN products p ON p.shopify_variant_id = l.shopify_variant_id
WHERE ${ORDER_COUNTS_AS_SALE}
  AND ${window};`.trim();
}


/**
 * Valore e profitto medi, per ordine e per cliente.
 *
 * Quattro numeri che rispondono alla stessa domanda da due lati: di quanto
 * incasso, quanto resta. AOV accanto ad AOP dice quanto margine c'e' in un
 * ordine medio; LTV accanto a LTP dice lo stesso su tutta la vita di un
 * cliente. Il valore da solo si puo' gonfiare con uno sconto; il profitto no.
 *
 * Su tutti gli ordini e non sul mese: "nel tempo" e' la meta' della domanda, e
 * un mese solo su un negozio stagionale direbbe quasi il contrario del vero.
 */
export function averagesSQL(range?: QueryRange): string {
  // Il periodo restringe gli ordini, non i prodotti: quello che si guarda e'
  // "quanto ho reso in questi giorni", e un ordine fuori dal periodo non deve
  // entrare nel conto nemmeno con le sue righe.
  //
  // I confini arrivano dallo stesso posto delle altre query — e con lo stesso
  // controllo sulle date, che qui mancava del tutto: interpolare una data presa
  // da fuori senza verificarla significa che basta una stringa costruita ad arte
  // per scrivere SQL dentro la nostra.
  const window = range ? `AND ${placedAtWindowSQL(range, range.timeZone)}` : '';
  return `
SELECT
  COUNT(DISTINCT o.shopify_order_id) AS orders,
  COUNT(DISTINCT o.shopify_customer_id) FILTER (WHERE o.shopify_customer_id IS NOT NULL)
    AS customers,
  ${NET_REVENUE_SUM} AS revenue,
  ${ORDER_PROFIT_SUM} AS profit,
  -- Su quante righe d'ordine il profitto si e' potuto calcolare davvero.
  --
  -- Il profitto qui sopra somma SOLO le righe il cui prodotto ha un costo noto,
  -- e i prodotti presenti dipendono da quanti il piano ne sincronizza. Alzando
  -- il piano ne entrano di piu', altre righe trovano il loro costo e il
  -- profitto sale: nessun ordine e' cambiato, e' cambiato quanto se ne sa. Chi
  -- guarda il grafico vede le barre muoversi e non ha modo di capire perche',
  -- se questi due numeri non escono di qui.
  ${COVERED_LINES} AS covered_lines,
  ${TOTAL_LINES} AS total_lines,
  MAX(o.currency) AS currency
FROM orders o
JOIN order_lines l ON l.shopify_order_id = o.shopify_order_id
LEFT JOIN products p ON p.shopify_variant_id = l.shopify_variant_id
WHERE ${ORDER_COUNTS_AS_SALE} ${window};`.trim();
}
