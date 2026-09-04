import { isCalendarDate } from './customers-query';
import {
  LINE_NET_CONTRIBUTION_OR_NULL,
  ORDER_COUNTS_AS_SALE,
} from './net-contribution';

/**
 * I prodotti che hanno reso di piu', in un periodo.
 *
 * Quattro modi di chiedere la stessa cosa, che danno quattro risposte diverse e
 * servono a decisioni diverse:
 *
 * - **CM** (margine di contribuzione): quanto profitto ha portato in tutto.
 *   Premia chi vende tanto. E' il numero da guardare per sapere cosa tiene in
 *   piedi il negozio.
 * - **AOP**: quanto profitto porta ogni volta che viene comprato. Premia il
 *   prodotto caro anche se raro — e' il numero per decidere cosa spingere.
 * - **ACP**: quanto profitto fa l'intero carrello in cui si trova. Premia il
 *   prodotto che se ne porta dietro altri, e che da solo varrebbe poco.
 * - **LTP**: quanto profitto ha portato ogni cliente che l'ha comprato. Premia
 *   il prodotto che fa tornare.
 *
 * Le righe senza costo restano fuori da tutti e quattro: profitto sconosciuto
 * non e' profitto zero, e metterlo a zero abbasserebbe una media che nessuno
 * sa calcolare.
 *
 * Il profitto di una riga lo definisce `net-contribution`, come per la tab
 * Clienti e per le card della dashboard. Qui c'era la quinta copia della stessa
 * moltiplicazione, ed era il posto in cui un errore si vedeva meno: un prodotto
 * molto reso restava in cima alla classifica proprio perche' i resi non
 * contavano.
 */

export const METRICS = ['cm', 'aop', 'acp', 'ltp'] as const;
export type Metric = (typeof METRICS)[number];

export function isMetric(value: string): value is Metric {
  return (METRICS as readonly string[]).includes(value);
}

/** La colonna su cui ordinare, per ciascuna domanda. */
const ORDER_BY: Record<Metric, string> = {
  cm: 'cm',
  aop: 'aop',
  acp: 'acp',
  ltp: 'ltp',
};

function literalDate(value: string): string {
  // Come nel resto delle query sul database del merchant: cio' che arriva da
  // fuori e non e' una data non entra, invece di essere ripulito.
  if (!isCalendarDate(value)) throw new Error(`Data non valida: ${value}`);
  return `'${value}'`;
}

export interface TopProductsInput {
  from: string;
  to: string;
  metric: Metric;
  limit?: number;
}

export function topProductsSQL(input: TopProductsInput): string {
  const from = literalDate(input.from);
  const to = literalDate(input.to);
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 5)));
  const order = ORDER_BY[input.metric];

  return `
WITH l AS (
  SELECT
    o.shopify_order_id                       AS order_id,
    o.shopify_customer_id                    AS customer_id,
    l.shopify_variant_id                     AS variant_id,
    p.shopify_product_id                     AS product_id,
    p.product_title                          AS product_title,
    p.variant_title                          AS variant_title,
    ${LINE_NET_CONTRIBUTION_OR_NULL} AS profit
  FROM orders o
  JOIN order_lines l ON l.shopify_order_id = o.shopify_order_id
  LEFT JOIN products p ON p.shopify_variant_id = l.shopify_variant_id
  WHERE ${ORDER_COUNTS_AS_SALE}
    AND o.placed_at >= ${from}::date
    AND o.placed_at < (${to}::date + INTERVAL '1 day')
),
-- Il profitto dell'intero carrello, ordine per ordine: e' il numeratore di ACP,
-- e si calcola prima perche' non dipende dal prodotto che si sta guardando.
cart AS (
  SELECT order_id, COALESCE(SUM(profit), 0) AS cart_profit
  FROM l
  GROUP BY order_id
),
-- Una riga per prodotto e per ordine: senza questo passaggio un prodotto
-- comprato due volte nello stesso ordine conterebbe l'ordine due volte, e la
-- media del carrello con lui.
vo AS (
  SELECT
    variant_id,
    order_id,
    MAX(customer_id)   AS customer_id,
    MAX(product_id)    AS product_id,
    MAX(product_title) AS product_title,
    MAX(variant_title) AS variant_title,
    SUM(profit)        AS variant_profit
  FROM l
  WHERE variant_id IS NOT NULL AND profit IS NOT NULL
  GROUP BY variant_id, order_id
)
SELECT
  vo.variant_id,
  MAX(vo.product_id)                                   AS product_id,
  MAX(vo.product_title)                                AS product_title,
  MAX(vo.variant_title)                                AS variant_title,
  COUNT(*)                                             AS orders,
  COUNT(DISTINCT vo.customer_id)                       AS customers,
  COALESCE(SUM(vo.variant_profit), 0)                  AS cm,
  COALESCE(SUM(vo.variant_profit) / NULLIF(COUNT(*), 0), 0) AS aop,
  COALESCE(AVG(cart.cart_profit), 0)                   AS acp,
  COALESCE(
    SUM(vo.variant_profit) / NULLIF(COUNT(DISTINCT vo.customer_id), 0),
    0
  )                                                    AS ltp
FROM vo
JOIN cart ON cart.order_id = vo.order_id
GROUP BY vo.variant_id
ORDER BY ${order} DESC NULLS LAST
LIMIT ${limit};`.trim();
}
