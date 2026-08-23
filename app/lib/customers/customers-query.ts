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
 */

/** Una data di calendario, come la scrive un selettore: 2026-08-01. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

/**
 * Una data pronta per finire dentro una query.
 *
 * La query si compone come testo — l'API che la esegue non prende parametri —
 * quindi ogni valore che arriva da fuori va verificato prima, non ripulito
 * dopo: una data che non e' una data non entra affatto.
 */
function literalDate(value: string): string {
  if (!isCalendarDate(value)) {
    throw new Error(`Data non valida: ${value}`);
  }
  return `'${value}'`;
}

export interface CustomersRangeInput {
  /** Primo giorno compreso. */
  from: string;
  /** Ultimo giorno compreso: la query lo estende a tutto il giorno. */
  to: string;
  /** Quanti clienti al massimo, per non riportare un negozio intero. */
  limit?: number;
}

/**
 * I clienti con i loro numeri nel periodo scelto.
 *
 * Gli ordini annullati restano fuori dal conto ma non dal database: sono merce
 * mai partita o tornata indietro, non profitto.
 *
 * `covered_lines` e `total_lines` viaggiano con il profitto perche' senza di
 * loro il numero mentirebbe per omissione: una riga il cui prodotto non ha
 * ancora un costo non vale profitto zero, vale profitto ignoto, e chi guarda
 * deve poterlo sapere.
 */
export function customersInRangeSQL(input: CustomersRangeInput): string {
  const from = literalDate(input.from);
  const to = literalDate(input.to);
  const limit = Number.isInteger(input.limit) && input.limit! > 0 ? input.limit! : 500;

  return `
SELECT
  o.shopify_customer_id AS customer_id,
  MAX(o.customer_first_name) AS first_name,
  MAX(o.customer_last_name) AS last_name,
  COUNT(DISTINCT o.shopify_order_id) AS orders,
  COALESCE(SUM((l.unit_price - p.cost_per_item) * l.quantity)
    FILTER (WHERE p.cost_per_item IS NOT NULL), 0) AS profit,
  COUNT(l.shopify_line_id) FILTER (WHERE p.cost_per_item IS NOT NULL) AS covered_lines,
  COUNT(l.shopify_line_id) AS total_lines,
  -- La valuta con cui il negozio vende, non quella con cui paga noi: il
  -- profitto e' suo, e va scritto nei soldi che incassa.
  MAX(o.currency) AS currency,
  -- Il cliente e' anche fra quelli sincronizzati? Lo dice la sola presenza
  -- della sua riga: la tabella dei clienti contiene chi ha dato consenso.
  BOOL_OR(c.shopify_customer_id IS NOT NULL) AS synced
FROM orders o
JOIN order_lines l ON l.shopify_order_id = o.shopify_order_id
LEFT JOIN products p ON p.shopify_variant_id = l.shopify_variant_id
LEFT JOIN customers c ON c.shopify_customer_id = o.shopify_customer_id
WHERE o.cancelled_at IS NULL
  AND o.shopify_customer_id IS NOT NULL
  AND o.placed_at >= ${from}::date
  AND o.placed_at < (${to}::date + INTERVAL '1 day')
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
  COALESCE(SUM((l.unit_price - p.cost_per_item) * l.quantity)
    FILTER (WHERE p.cost_per_item IS NOT NULL), 0) AS profit
FROM orders o
JOIN order_lines l ON l.shopify_order_id = o.shopify_order_id
LEFT JOIN products p ON p.shopify_variant_id = l.shopify_variant_id
WHERE o.cancelled_at IS NULL
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
 */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;

  const previousEnd = new Date(start.getTime() - 86_400_000);
  const previousStart = new Date(previousEnd.getTime() - (days - 1) * 86_400_000);

  return {
    from: previousStart.toISOString().slice(0, 10),
    to: previousEnd.toISOString().slice(0, 10),
  };
}
