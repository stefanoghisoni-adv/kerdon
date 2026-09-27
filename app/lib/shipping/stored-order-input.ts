// app/lib/shipping/stored-order-input.ts
//
// Da una riga di `orders` salvata sul database del merchant all'input del
// calcolo del costo. Pura, in un file suo: la usa il ricalcolo, e le prove di
// parita' (sincronizzazione, recupero, ricalcolo devono dare lo stesso costo)
// la usano senza tirarsi dietro coda e database.

import type { OrderLogisticsInput } from './types';

/** Una riga letta dal database del merchant, come la restituisce la Management API. */
export interface StoredOrderRow {
  shopify_order_id: string | number;
  fulfillment_status: string | null;
  shipping_country_code: string | null;
  total_weight_grams: number | string | null;
  item_count: number | string | null;
  returned_at: string | null;
  packaging_category: string | null;
  shipping_method: string | null;
  /** NUMERIC: la Management API puo' restituirlo come testo. */
  total_price: number | string | null;
  /** INTEGER, ma come gli altri numeri lo si accetta anche come testo. */
  package_count: number | string | null;
}

/** Un numero dal JSON della Management API, o null se non lo e'. */
function numeroOppureNull(valore: number | string | null): number | null {
  if (valore === null || valore === undefined) return null;
  const n = Number(valore);
  return Number.isFinite(n) ? n : null;
}

export function storedOrderToLogisticsInput(riga: StoredOrderRow): OrderLogisticsInput {
  return {
    fulfillment_status: riga.fulfillment_status ?? null,
    shipping_country_code: riga.shipping_country_code ?? null,
    total_weight_grams: numeroOppureNull(riga.total_weight_grams),
    item_count: numeroOppureNull(riga.item_count),
    returned_at: riga.returned_at ?? null,
    packaging_category: riga.packaging_category ?? null,
    // Gli stessi due campi che la scrittura dell'ordine passa al costo: se
    // mancassero qui, il ricalcolo riporterebbe tutti gli ordini alla tariffa
    // generica e il costo cambierebbe a seconda di chi ha scritto per ultimo.
    shipping_method: riga.shipping_method ?? null,
    total_price: numeroOppureNull(riga.total_price),
    // Come l'opzione: se il ricalcolo non leggesse i pacchi, ogni ordine
    // riletto pagherebbe un pacco solo, e il costo cambierebbe a seconda di
    // chi ha scritto per ultimo.
    package_count: numeroOppureNull(riga.package_count),
  };
}
