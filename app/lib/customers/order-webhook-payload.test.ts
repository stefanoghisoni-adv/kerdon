import { describe, it, expect } from 'vitest';
import { orderToRows } from './order-rows';
import {
  WEBHOOK_LINE_ITEMS_CAP,
  webhookOrderToShopifyOrder,
  type WebhookOrderPayload,
} from './order-webhook-payload';

const SYNCED = new Date('2026-08-27T10:00:00Z');

/** Un corpo di `orders/create` come lo manda Shopify, ridotto ai campi usati. */
function payload(over: Partial<WebhookOrderPayload> = {}): WebhookOrderPayload {
  return {
    id: 5001,
    name: '#1042',
    order_number: 1042,
    created_at: '2026-08-27T09:12:00+02:00',
    updated_at: '2026-08-27T09:12:03+02:00',
    cancelled_at: null,
    financial_status: 'paid',
    total_price: '119.80',
    current_total_price: '119.80',
    currency: 'EUR',
    customer: { id: 77, first_name: 'Anna', last_name: 'Rossi' },
    line_items: [
      {
        id: 9001,
        title: 'Felpa',
        name: 'Felpa - L',
        quantity: 2,
        product_id: 301,
        variant_id: 401,
        price: '49.90',
        total_discount: '0.00',
        discount_allocations: [{ amount: '9.98' }],
      },
    ],
    ...over,
  };
}

describe('webhookOrderToShopifyOrder — i nomi della REST diventano quelli normalizzati', () => {
  it('traduce i campi dell ordine', () => {
    const order = webhookOrderToShopifyOrder(payload())!;

    expect(order.id).toBe(5001);
    expect(order.order_number).toBe('#1042');
    expect(order.placed_at).toBe('2026-08-27T09:12:00+02:00');
    expect(order.updated_at).toBe('2026-08-27T09:12:03+02:00');
    expect(order.financial_status).toBe('paid');
    expect(order.currency).toBe('EUR');
    expect(order.customer_id).toBe(77);
    expect(order.customer_first_name).toBe('Anna');
  });

  it('traduce le righe, che nella REST si chiamano line_items', () => {
    const order = webhookOrderToShopifyOrder(payload())!;

    expect(order.lines).toHaveLength(1);
    expect(order.lines[0].id).toBe(9001);
    expect(order.lines[0].product_id).toBe(301);
    expect(order.lines[0].variant_id).toBe(401);
    expect(order.lines[0].quantity).toBe(2);
    // `title` e non `name`: la colonna contiene il prodotto, non prodotto+variante.
    expect(order.lines[0].title).toBe('Felpa');
  });

  it('il prezzo unitario e quello pagato, non il listino', () => {
    // 49.90 x 2 = 99.80, meno 9.98 di sconto allocato, diviso 2 unita'.
    const order = webhookOrderToShopifyOrder(payload())!;
    expect(order.lines[0].unit_price).toBe('44.91');
  });

  it('senza sconti allocati il listino resta il listino', () => {
    const order = webhookOrderToShopifyOrder(
      payload({
        line_items: [
          { id: 9002, title: 'Cappello', quantity: 1, product_id: 302, variant_id: 402, price: '19.90' },
        ],
      }),
    )!;
    expect(order.lines[0].unit_price).toBe('19.90');
  });

  it('uno sconto piu grande della riga non fa un prezzo negativo', () => {
    const order = webhookOrderToShopifyOrder(
      payload({
        line_items: [
          {
            id: 9003,
            title: 'Omaggio',
            quantity: 1,
            price: '10.00',
            discount_allocations: [{ amount: '12.00' }],
          },
        ],
      }),
    )!;
    expect(order.lines[0].unit_price).toBe('0.00');
  });

  it('su un ordine rimborsato vale il totale corrente, non quello originale', () => {
    const order = webhookOrderToShopifyOrder(
      payload({ total_price: '119.80', current_total_price: '0.00', financial_status: 'refunded' }),
    )!;
    expect(order.total_price).toBe('0.00');
    expect(order.financial_status).toBe('refunded');
  });

  it('senza name il numero d ordine si ricompone dal progressivo', () => {
    const order = webhookOrderToShopifyOrder(payload({ name: null, order_number: 1042 }))!;
    expect(order.order_number).toBe('#1042');
  });

  it('un acquisto senza account non ha cliente e non e un errore', () => {
    const order = webhookOrderToShopifyOrder(payload({ customer: null }))!;
    expect(order.customer_id).toBeNull();
    expect(order.customer_first_name).toBeNull();
  });

  it('gli id dati come stringa restano numeri', () => {
    const order = webhookOrderToShopifyOrder(
      payload({ id: '5001', customer: { id: '77' }, line_items: [{ id: '9001', quantity: '3', price: '5' }] }),
    )!;
    expect(order.id).toBe(5001);
    expect(order.customer_id).toBe(77);
    expect(order.lines[0].id).toBe(9001);
    expect(order.lines[0].quantity).toBe(3);
  });

  it('senza id non c e ordine da riconoscere', () => {
    expect(webhookOrderToShopifyOrder(payload({ id: null }))).toBeNull();
    expect(webhookOrderToShopifyOrder(null)).toBeNull();
  });

  it('un ordine senza righe si traduce lo stesso', () => {
    const order = webhookOrderToShopifyOrder(payload({ line_items: [] }))!;
    expect(order.lines).toEqual([]);
    expect(order.lines_complete).toBe(true);
  });

  it('line_items assente non fa esplodere niente', () => {
    const order = webhookOrderToShopifyOrder(payload({ line_items: null }))!;
    expect(order.lines).toEqual([]);
  });
});

describe('webhookOrderToShopifyOrder — quel che il corpo del webhook non contiene', () => {
  it('un elenco al tetto e dichiarato incompleto: non si sa cosa c e oltre', () => {
    const line_items = Array.from({ length: WEBHOOK_LINE_ITEMS_CAP }, (_, i) => ({
      id: 9000 + i,
      title: `Riga ${i}`,
      quantity: 1,
      price: '1.00',
    }));

    const order = webhookOrderToShopifyOrder(payload({ line_items }))!;

    expect(order.lines).toHaveLength(WEBHOOK_LINE_ITEMS_CAP);
    expect(order.lines_complete).toBe(false);
  });

  it('sotto al tetto l elenco e tutto l ordine', () => {
    const line_items = Array.from({ length: WEBHOOK_LINE_ITEMS_CAP - 1 }, (_, i) => ({
      id: 9000 + i,
      quantity: 1,
      price: '1.00',
    }));

    expect(webhookOrderToShopifyOrder(payload({ line_items }))!.lines_complete).toBe(true);
  });
});

describe('la forma tradotta e quella che orderToRows sa leggere', () => {
  it('dal payload REST si arriva alle righe di Supabase', () => {
    const order = webhookOrderToShopifyOrder(payload())!;
    const rows = orderToRows(order, SYNCED)!;

    expect(rows.order.shopify_order_id).toBe(5001);
    expect(rows.order.total_price).toBe(119.8);
    expect(rows.order.placed_at).toBe('2026-08-27T09:12:00+02:00');
    expect(rows.lines).toHaveLength(1);
    expect(rows.lines[0].unit_price).toBe(44.91);
    expect(rows.lines[0].shopify_order_id).toBe(5001);
  });

  it('il payload GREZZO invece non ci arriva: e il bug che questa traduzione chiude', () => {
    // Prima della correzione il webhook passava esattamente questo a
    // `orderToRows`. Non e' un errore di tipo, e' un TypeError a runtime —
    // `order.lines` e' undefined — che il catch del webhook si mangiava
    // rispondendo 200: nessuna scrittura, nessuna traccia, per ogni ordine.
    expect(() => orderToRows(payload() as never, SYNCED)).toThrow();
  });
});
