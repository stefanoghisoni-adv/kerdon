import { describe, it, expect } from 'vitest';
import { countsAsSale, orderToRows, type ShopifyOrder } from './order-rows';

const SYNCED = new Date('2026-08-24T10:00:00Z');

const order = (over: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: 111,
  order_number: '#1001',
  placed_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:05:00Z',
  cancelled_at: null,
  financial_status: 'paid',
  total_price: '59.90',
  currency: 'EUR',
  customer_id: 55,
  customer_first_name: 'Anna',
  customer_last_name: 'Rossi',
  lines: [
    {
      id: 900,
      title: 'Maglia',
      quantity: 2,
      product_id: 10,
      variant_id: 20,
      unit_price: '19.95',
      total_discount: '0.00',
    },
  ],
  ...over,
});

describe('orderToRows', () => {
  it('separa l ordine dalle sue righe', () => {
    const rows = orderToRows(order(), SYNCED)!;

    expect(rows.order.shopify_order_id).toBe(111);
    expect(rows.order.shopify_customer_id).toBe(55);
    expect(rows.lines).toHaveLength(1);
    expect(rows.lines[0].shopify_order_id).toBe(111);
    expect(rows.lines[0].shopify_variant_id).toBe(20);
  });

  it('il denaro diventa numero', () => {
    const rows = orderToRows(order(), SYNCED)!;
    expect(rows.order.total_price).toBe(59.9);
    expect(rows.lines[0].unit_price).toBe(19.95);
  });

  it('un ordine senza id non si scrive: alla corsa dopo sarebbe un doppione', () => {
    expect(orderToRows(order({ id: null }), SYNCED)).toBeNull();
  });

  it('una riga senza id resta fuori, l ordine no', () => {
    const rows = orderToRows(
      order({
        lines: [
          { id: null, title: 'Ignota', quantity: 1, product_id: null, variant_id: null, unit_price: '5', total_discount: null },
          { id: 901, title: 'Nota', quantity: 1, product_id: 10, variant_id: 21, unit_price: '5', total_discount: null },
        ],
      }),
      SYNCED,
    )!;

    expect(rows.lines).toHaveLength(1);
    expect(rows.lines[0].shopify_line_id).toBe(901);
  });

  it('un acquisto senza account resta senza cliente, e non si butta', () => {
    // L'ordine esiste e vale per i totali del negozio: semplicemente non
    // appartiene a nessuno da mettere in elenco.
    const rows = orderToRows(order({ customer_id: null, customer_first_name: null }), SYNCED)!;
    expect(rows.order.shopify_customer_id).toBeNull();
  });

  it('nelle righe non finisce nessun costo: il costo vive nei prodotti', () => {
    const rows = orderToRows(order(), SYNCED)!;
    expect(Object.keys(rows.lines[0])).not.toContain('cost');
    expect(Object.keys(rows.lines[0])).not.toContain('profit');
  });
});

describe('countsAsSale', () => {
  it('un ordine annullato non e profitto', () => {
    expect(countsAsSale({ cancelled_at: '2026-08-02T10:00:00Z' })).toBe(false);
  });

  it('gli altri si', () => {
    expect(countsAsSale({ cancelled_at: null })).toBe(true);
  });
});
