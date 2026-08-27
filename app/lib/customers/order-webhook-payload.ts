/**
 * Il corpo di un webhook `orders/create` / `orders/updated`, tradotto nella
 * forma che il resto dell'applicazione conosce.
 *
 * Esiste perche' un ordine arriva qui per due strade che non parlano la stessa
 * lingua. La corsa periodica lo legge in GraphQL e `getOrders` lo consegna gia'
 * normalizzato — `lines`, `placed_at`, `unit_price`. Il webhook invece arriva
 * ancora nei nomi della REST: `line_items`, `created_at`, `price`. Le due forme
 * si somigliano abbastanza da sembrare la stessa cosa, ed e' il tipo di
 * somiglianza che fa danno: passare la seconda a `orderToRows`, che e' scritta
 * per la prima, non produce nessun errore di tipo e non scrive niente —
 * `order.lines` e' `undefined`, il `.filter` che segue esplode, e il `catch` del
 * webhook (che risponde 200 di proposito) si mangia tutto in silenzio.
 *
 * PERCHE' TRADURRE INVECE DI RILEGGERE. Per i prodotti la scelta e' stata
 * l'opposta — `webhooks.products.create` butta via il payload e rilegge tutto
 * dall'API — e vale la pena dire perche' qui non si fa lo stesso.
 *
 * La ragione che li' obbligava a rileggere era che un elenco di varianti monco
 * veniva usato per cancellare per differenza: le varianti che il payload non
 * nominava sparivano dal database del merchant. Sugli ordini quella riga di
 * codice non esiste — le righe d'ordine si aggiungono soltanto, nessuno le
 * toglie confrontando gli elenchi — quindi un elenco troncato qui non cancella
 * niente: scrive meno, e la corsa periodica completa. Il pericolo che li'
 * giustificava una chiamata in piu' qui non c'e'.
 *
 * E la chiamata in piu' costerebbe. Il webhook degli ordini scatta a ogni
 * vendita, che e' un ordine di grandezza sopra ai prodotti modificati, e questo
 * handler e' dichiaratamente la scorciatoia economica: due scritture, nessuna
 * lettura. Per i prodotti la rilettura era comunque obbligata (il costo vive
 * sull'InventoryItem e nel payload non compare mai); qui non lo e'.
 *
 * COSA RESTA VERO DEL TRONCAMENTO. Shopify spedisce al massimo cento
 * `line_items` nel corpo del webhook. Le righe oltre la centesima non ci sono e
 * non c'e' modo di saperlo se non contando: sotto, `lines_complete` viene messo
 * a `false` appena l'elenco tocca il tetto. Non cambia cosa si scrive — si
 * scrive quel che c'e' — ma impedisce che qualcuno, un domani, prenda un elenco
 * monco per l'elenco vero. E' lo stesso bit che `getOrders` calcola dopo aver
 * esaurito la connessione annidata, con lo stesso significato.
 */

import type { ShopifyOrder, ShopifyOrderLine } from './order-rows';

/**
 * Il tetto di Shopify sulle righe dentro al corpo del webhook. Un ordine che ne
 * ha esattamente cento e' indistinguibile da uno che ne ha centoventi: e'
 * proprio per questo che il confronto sotto e' `>=` e non `>`.
 */
export const WEBHOOK_LINE_ITEMS_CAP = 100;

/** Il pezzo di payload REST che ci interessa. Del resto non si guarda niente. */
export interface WebhookOrderLineItem {
  id?: number | string | null;
  title?: string | null;
  name?: string | null;
  quantity?: number | string | null;
  product_id?: number | string | null;
  variant_id?: number | string | null;
  price?: string | number | null;
  total_discount?: string | number | null;
  discount_allocations?: { amount?: string | number | null }[] | null;
}

export interface WebhookOrderPayload {
  id?: number | string | null;
  name?: string | null;
  order_number?: number | string | null;
  created_at?: string | null;
  updated_at?: string | null;
  cancelled_at?: string | null;
  financial_status?: string | null;
  total_price?: string | number | null;
  current_total_price?: string | number | null;
  currency?: string | null;
  customer?: {
    id?: number | string | null;
    first_name?: string | null;
    last_name?: string | null;
  } | null;
  line_items?: WebhookOrderLineItem[] | null;
}

/** Gli id REST sono numeri, ma un payload puo' darli come stringa: si accetta. */
function toId(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Il denaro viaggia come stringa fino a `orderToRows`, che sara' lui a convertirlo. */
function toAmount(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Gli stati REST sono gia' minuscoli, ma non costa niente non fidarsene. */
function lower(value: string | null | undefined): string | null {
  return value ? value.toLowerCase() : null;
}

/**
 * Il prezzo unitario davvero pagato, che e' quello che la colonna `unit_price`
 * dichiara di contenere ("sconti gia' tolti") e quello su cui si fa il margine.
 *
 * La REST non ce l'ha pronto: da' `price`, che e' il listino, e a parte
 * `discount_allocations`, cioe' quanto di ogni sconto — anche di quelli applicati
 * all'ordine intero — e' finito su questa riga. Il prezzo effettivo e' la
 * differenza, spalmata sulle unita'. GraphQL lo consegna gia' fatto
 * (`discountedUnitPriceSet`) ed e' quello che scrive la corsa periodica: se qui
 * si scrivesse il listino, ogni ordine scontato risulterebbe piu' redditizio del
 * vero fino alla corsa successiva, che poi lo correggerebbe di soppiatto. Due
 * strade che scrivono la stessa colonna devono scriverci la stessa cosa.
 *
 * Due decimali perche' tanti ne tiene la colonna — `NUMERIC(10, 2)` — e
 * arrotondare qui e' meglio che lasciarlo fare al database su un numero
 * periodico.
 */
function discountedUnitPrice(line: WebhookOrderLineItem): string | null {
  const listino = toNumber(line.price);
  if (listino === null) return null;

  const quantity = toNumber(line.quantity) ?? 0;
  const allocazioni = line.discount_allocations ?? [];
  const scontato = allocazioni.reduce<number>(
    (somma, alloc) => somma + (toNumber(alloc?.amount) ?? 0),
    0,
  );

  // Niente sconti, o una riga a quantita' zero su cui non c'e' niente da
  // spalmare: il listino e' gia' il prezzo pagato, e si restituisce com'era
  // scritto invece di farlo passare per un arrotondamento inutile.
  if (scontato <= 0 || quantity <= 0) return toAmount(line.price);

  const netto = (listino * quantity - scontato) / quantity;
  // Uno sconto piu' grande della riga non dovrebbe esistere; se esiste, un
  // prezzo negativo in cassa non c'e' mai stato.
  return (netto > 0 ? netto : 0).toFixed(2);
}

function toLine(line: WebhookOrderLineItem): ShopifyOrderLine {
  return {
    id: toId(line.id),
    // `title` e' il nome del prodotto, `name` quello con la variante in coda:
    // GraphQL manda il primo, e la colonna contiene quello da sempre.
    title: line.title ?? line.name ?? null,
    quantity: toNumber(line.quantity) ?? 0,
    product_id: toId(line.product_id),
    variant_id: toId(line.variant_id),
    unit_price: discountedUnitPrice(line),
    total_discount: toAmount(line.total_discount),
  };
}

/**
 * Da payload REST a ordine normalizzato.
 *
 * `null` quando manca l'id, che e' l'unica cosa senza la quale non c'e' niente
 * da fare: la stessa condizione per cui `orderToRows` si rifiuta di lavorare.
 * Un ordine senza righe invece si traduce eccome — l'ordine vale per i totali
 * del negozio anche quando non ha nessuna riga da raggruppargli sotto.
 */
export function webhookOrderToShopifyOrder(
  payload: WebhookOrderPayload | null | undefined,
): ShopifyOrder | null {
  const id = toId(payload?.id);
  if (payload == null || id === null) return null;

  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : [];

  return {
    id,
    // La colonna contiene il numero come lo mostra Shopify, con il cancelletto
    // ("#1001"): e' `name` nella REST, non `order_number`, che e' il progressivo
    // nudo. Se `name` mancasse, il cancelletto glielo si rimette qui.
    order_number:
      payload.name ??
      (payload.order_number != null && payload.order_number !== ''
        ? `#${payload.order_number}`
        : null),
    placed_at: payload.created_at ?? null,
    updated_at: payload.updated_at ?? null,
    cancelled_at: payload.cancelled_at ?? null,
    financial_status: lower(payload.financial_status),
    // `current_total_price` e' il totale dopo rimborsi e modifiche, ed e' quello
    // che GraphQL chiama `currentTotalPriceSet`: su un ordine rimborsato le due
    // cifre divergono, e quella buona e' la corrente.
    total_price: toAmount(payload.current_total_price ?? payload.total_price),
    currency: payload.currency ?? null,
    // null = acquisto senza account: l'ordine esiste, ma non appartiene a
    // nessun cliente da mettere in elenco.
    customer_id: toId(payload.customer?.id),
    customer_first_name: payload.customer?.first_name ?? null,
    customer_last_name: payload.customer?.last_name ?? null,
    lines: lineItems.map(toLine),
    lines_complete: lineItems.length < WEBHOOK_LINE_ITEMS_CAP,
  };
}
