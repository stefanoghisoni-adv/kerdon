/**
 * Da un ordine di Shopify alle righe che finiscono nel database del merchant.
 *
 * Due tabelle e non una: l'ordine dice quando e di chi, le righe dicono cosa.
 * Il profitto nasce dal secondo elenco moltiplicato per il costo che vive nei
 * prodotti — qui non se ne parla, e infatti nessuna di queste righe contiene un
 * costo o un margine.
 */

export interface ShopifyOrderLine {
  id: number | null;
  title: string | null;
  quantity: number;
  product_id: number | null;
  variant_id: number | null;
  unit_price: string | null;
  total_discount: string | null;
}

export interface ShopifyOrder {
  id: number | null;
  order_number: string | null;
  placed_at: string | null;
  updated_at: string | null;
  cancelled_at: string | null;
  financial_status: string | null;
  total_price: string | null;
  currency: string | null;
  customer_id: number | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  lines: ShopifyOrderLine[];
}

export interface OrderRow {
  shopify_order_id: number;
  order_number: string | null;
  shopify_customer_id: number | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  currency: string | null;
  total_price: number | null;
  financial_status: string | null;
  cancelled_at: string | null;
  placed_at: string | null;
  updated_at: string | null;
  synced_at: string;
}

export interface OrderLineRow {
  shopify_line_id: number;
  shopify_order_id: number;
  shopify_product_id: number | null;
  shopify_variant_id: number | null;
  title: string | null;
  quantity: number;
  unit_price: number | null;
  total_discount: number | null;
  synced_at: string;
}

/** Il denaro arriva come stringa: numero, o null se non e' un numero. */
function money(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Le due righe di un ordine.
 *
 * `null` quando l'ordine non ha un id: senza, non c'e' modo di riconoscerlo
 * alla corsa successiva e ogni sincronizzazione ne creerebbe un duplicato.
 */
export function orderToRows(
  order: ShopifyOrder,
  syncedAt: Date = new Date(),
): { order: OrderRow; lines: OrderLineRow[] } | null {
  if (order.id == null) return null;

  const synced_at = syncedAt.toISOString();

  return {
    order: {
      shopify_order_id: order.id,
      order_number: order.order_number,
      shopify_customer_id: order.customer_id,
      customer_first_name: order.customer_first_name,
      customer_last_name: order.customer_last_name,
      currency: order.currency,
      total_price: money(order.total_price),
      financial_status: order.financial_status,
      cancelled_at: order.cancelled_at,
      placed_at: order.placed_at,
      updated_at: order.updated_at,
      synced_at,
    },
    // Le righe senza id restano fuori per la stessa ragione dell'ordine: non
    // sarebbero riconoscibili, e a ogni corsa se ne aggiungerebbe una copia.
    lines: order.lines
      .filter((line) => line.id != null)
      .map((line) => ({
        shopify_line_id: line.id as number,
        shopify_order_id: order.id as number,
        shopify_product_id: line.product_id,
        shopify_variant_id: line.variant_id,
        title: line.title,
        quantity: line.quantity ?? 0,
        unit_price: money(line.unit_price),
        total_discount: money(line.total_discount),
        synced_at,
      })),
  };
}

/**
 * Un ordine annullato conta come profitto?
 *
 * No: e' merce tornata indietro o mai partita. Resta pero' nel database — il
 * merchant lo vede nel suo Shopify e non capirebbe perche' qui non c'e' — e a
 * escluderlo e' il conto, non la sincronizzazione.
 */
export function countsAsSale(order: { cancelled_at: string | null }): boolean {
  return order.cancelled_at == null;
}
