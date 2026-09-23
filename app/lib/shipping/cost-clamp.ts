// app/lib/shipping/cost-clamp.ts
//
// Il costo logistico come puo' finire in `orders.logistics_cost`.
//
// PERCHE' IN UN FILE SUO. Due strade scrivono quella colonna: la scrittura
// dell'ordine (sync e webhook, via order-rows) e il ricalcolo in background.
// Se applicano regole diverse, lo stesso ordine ha un costo diverso a seconda
// di chi l'ha scritto per ultimo, e un valore che una accetta fa fallire
// l'altra. Una funzione sola, usata da entrambe, toglie la domanda.

/** Il tetto di NUMERIC(10,2): oltre, Postgres rifiuterebbe la scrittura intera. */
export const MAX_LOGISTICS_COST = 99_999_999.99;

/**
 * Il costo arrotondato al centesimo, oppure zero se non e' scrivibile.
 *
 * Zero e non un errore: un costo non finito, negativo (nessuno paga noi per
 * spedire) o fuori dal tetto della colonna e' un dato sbagliato in
 * configurazione, e non deve ne' gonfiare il profitto ne' far fallire la
 * scrittura di un ordine — o di una pagina intera di ordini — per un valore
 * solo. E' la stessa scelta di quando il costo non si sa.
 */
export function clampLogisticsCost(valore: number): number {
  if (!Number.isFinite(valore) || valore < 0 || valore > MAX_LOGISTICS_COST) return 0;
  return Math.round(valore * 100) / 100;
}
