/**
 * Da un ordine di Shopify alle righe che finiscono nel database del merchant.
 *
 * Due tabelle e non una: l'ordine dice quando e di chi, le righe dicono cosa.
 * Il profitto nasce dal secondo elenco incrociato col costo che vive nei
 * prodotti — qui non se ne parla, e infatti nessuna di queste righe contiene un
 * costo o un margine.
 *
 * COSA E' CAMBIATO, E PERCHE'. Una riga portava `quantity` e `unit_price`, e
 * chi contava moltiplicava i due. Sono esattamente i due valori che un rimborso
 * rende falsi: `quantity` e' la quantita' ORDINATA e dopo un reso resta quella
 * di allora, mentre `unit_price` ha dentro allocazioni di sconto riferite anche
 * a unita' rimborsate o rimosse. L'ordine intanto seguiva
 * `currentTotalPriceSet`, che i rimborsi li riflette: totale e righe
 * raccontavano due realta' diverse, e quella sbagliata era sempre la piu'
 * generosa.
 *
 * Adesso i due valori su cui si conta sono `current_quantity` (le unita' rimaste
 * al cliente) e `line_net_total` (il netto della riga come lo dichiara
 * Shopify). Gli altri due restano scritti, perche' sono i numeri che il merchant
 * riconosce guardando una riga d'ordine, ma non entrano in nessuna metrica.
 */

export interface ShopifyOrderLine {
  id: number | null;
  title: string | null;
  /**
   * La quantita' ORDINATA. Traccia, non misura: dopo un rimborso resta quella
   * di allora, e moltiplicarla per un prezzo racconta merce che il cliente non
   * ha piu'.
   */
  quantity: number;
  /**
   * Le unita' ancora in mano al cliente: `quantity` meno cio' che e' stato
   * rimborsato o tolto dall'ordine. Zero su una riga interamente resa.
   */
  current_quantity: number | null;
  product_id: number | null;
  variant_id: number | null;
  unit_price: string | null;
  total_discount: string | null;
  /**
   * Il netto della riga, sconti di riga e d'ordine gia' tolti e tasse escluse,
   * cosi' come lo dichiara Shopify. Non si ricava moltiplicando.
   */
  line_net_total: string | null;
  /** La valuta di `line_net_total`. Mai sommare importi di valute diverse. */
  line_currency: string | null;
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
  /**
   * `lines` e' tutto l'ordine o solo le prime righe lette?
   *
   * E' l'unica cosa che autorizza a cancellare per differenza. Su un elenco
   * troncato, cancellare cio' che non si e' visto vuol dire cancellare righe che
   * esistono: si aggiornano quelle viste, si registra una riparazione in
   * sospeso, e non si tocca altro.
   */
  lines_complete?: boolean;
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
  current_quantity: number;
  unit_price: number | null;
  total_discount: number | null;
  line_net_total: number | null;
  line_currency: string | null;
  /** Quando Shopify ha toccato l'ordine da cui questa riga viene. */
  source_updated_at: string | null;
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
      .map((line) => {
        const currentQuantity = line.current_quantity ?? line.quantity ?? 0;

        return {
          shopify_line_id: line.id as number,
          shopify_order_id: order.id as number,
          shopify_product_id: line.product_id,
          shopify_variant_id: line.variant_id,
          title: line.title,
          quantity: line.quantity ?? 0,
          current_quantity: currentQuantity,
          unit_price: money(line.unit_price),
          total_discount: money(line.total_discount),
          // Niente piu' in mano al cliente vuol dire niente incassato su quella
          // riga, e lo si scrive invece di aspettare che sia il conto ad
          // arrivarci: un rimborso totale su una singola riga non tocca
          // `cancelledAt` dell'ordine — l'ordine resta valido, con dentro una
          // riga che non vale piu' niente — e un netto rimasto pieno accanto a
          // una quantita' a zero e' proprio la contraddizione da cui e' nato
          // tutto questo.
          line_net_total: currentQuantity <= 0 ? 0 : money(line.line_net_total),
          line_currency: line.line_currency ?? order.currency,
          // Dall'ordine e non dalla riga: e' l'ordine che Shopify data, e due
          // consegne dello stesso webhook non arrivano necessariamente in
          // ordine.
          source_updated_at: order.updated_at,
          synced_at,
        };
      }),
  };
}

/**
 * Un ordine annullato conta come profitto?
 *
 * No: e' merce tornata indietro o mai partita. Resta pero' nel database — il
 * merchant lo vede nel suo Shopify e non capirebbe perche' qui non c'e' — e a
 * escluderlo e' il conto, non la sincronizzazione.
 *
 * Un ordine RIMBORSATO invece non e' annullato, e la differenza conta: la
 * vendita c'e' stata, e a portarla a zero sono `current_quantity` e
 * `line_net_total` riga per riga, non un'esclusione in blocco.
 */
export function countsAsSale(order: { cancelled_at: string | null }): boolean {
  return order.cancelled_at == null;
}
