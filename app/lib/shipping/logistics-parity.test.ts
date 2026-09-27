// app/lib/shipping/logistics-parity.test.ts
//
// Tre strade scrivono o riscrivono il costo logistico di un ordine: la
// sincronizzazione e il webhook (orderToRows sull'ordine letto da GraphQL), il
// recupero dello storico (getOrderShippingFacts + backfill) e il ricalcolo
// (dalle colonne salvate). Per lo stesso ordine devono dare lo stesso costo.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { orderToRows } from '~/lib/customers/order-rows';
import { netContribution } from '~/lib/customers/net-contribution';
import { computeLogisticsCost } from './logistics-cost';
import { storedOrderToLogisticsInput, type StoredOrderRow } from './stored-order-input';
import type { LogisticsConfig } from './types';

vi.mock('~/shopify.server', () => ({ unauthenticated: { admin: vi.fn() } }));

function ok(data: unknown) {
  return {
    ok: true,
    headers: new Headers({ 'X-Shopify-API-Version': '2026-07' }),
    json: async () => ({ data }),
  };
}

const client = () => new ShopifyAPIClient('test.myshopify.com', 'token');

const CONFIG: LogisticsConfig = {
  zones: [
    {
      zoneName: 'Italia',
      countries: ['IT'],
      restOfWorld: false,
      rateType: 'per_package',
      rates: [{ weightFromKg: null, weightToKg: null, cost: 5 }],
      options: [
        // 4,50 EUR a collo con l'opzione "Corriere Espresso".
        { name: 'Corriere Espresso', costType: 'per_package', confirmed: true, brackets: [{ from: null, to: null, cost: 4.5 }] },
      ],
    },
  ],
  categories: [{ name: 'Scatola M', cost: 1.2 }],
  fallbackRules: [],
  defaultWeightPerItemKg: null,
  returnCost: 6,
};

/** L'ordine come lo consegna GraphQL: un collo tracciato tre volte, un reso chiuso. */
const nodo = (over: Record<string, unknown> = {}) => ({
  id: 'gid://shopify/Order/4242',
  name: '#4242',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-10T00:00:00Z',
  cancelledAt: null,
  displayFinancialStatus: 'PAID',
  currentTotalPriceSet: { shopMoney: { amount: '120.00', currencyCode: 'EUR' } },
  customer: null,
  displayFulfillmentStatus: 'FULFILLED',
  requiresShipping: true,
  shippingAddress: { countryCodeV2: 'IT' },
  totalWeight: '3000',
  metafield: { value: 'Scatola M' },
  fulfillments: [
    { status: 'SUCCESS', trackingInfo: [{ number: 'BRT1' }, { number: 'BRT2' }, { number: 'BRT3' }, { number: 'BRT1' }] },
    // Annullata prima di prendere un tracking: nessun pacco. (Con un tracking
    // conterebbe: il tracking fa fede, vedi package-count.)
    { status: 'CANCELLED', trackingInfo: [] },
  ],
  returns: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      { status: 'REQUESTED', createdAt: '2026-08-06T00:00:00Z' },
      { status: 'CLOSED', createdAt: '2026-08-07T00:00:00Z' },
    ],
  },
  shippingLines: { nodes: [{ title: 'Corriere Espresso' }, { title: 'Standard' }] },
  lineItems: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      {
        id: 'gid://shopify/LineItem/1',
        title: 'Giacca',
        quantity: 2,
        currentQuantity: 2,
        product: { id: 'gid://shopify/Product/10' },
        variant: { id: 'gid://shopify/ProductVariant/20' },
        priceAfterAllDiscountsBeforeTaxesSet: { shopMoney: { amount: '100.00', currencyCode: 'EUR' } },
        discountedUnitPriceSet: { shopMoney: { amount: '50.00' } },
        originalUnitPriceSet: { shopMoney: { amount: '50.00' } },
        totalDiscountSet: { shopMoney: { amount: '0.00' } },
      },
    ],
  },
  ...over,
});

/** La riga salvata, come la rileggerebbe il ricalcolo. */
function salvata(row: ReturnType<typeof orderToRows>): StoredOrderRow {
  const o = row!.order;
  return {
    shopify_order_id: String(o.shopify_order_id),
    fulfillment_status: o.fulfillment_status,
    shipping_country_code: o.shipping_country_code,
    total_weight_grams: String(o.total_weight_grams),
    item_count: o.item_count,
    returned_at: o.returned_at,
    packaging_category: o.packaging_category,
    shipping_method: o.shipping_method,
    total_price: String(o.total_price),
    package_count: o.package_count,
  };
}

beforeEach(() => {
  global.fetch = vi.fn();
});

describe('parita\' fra sincronizzazione, recupero e ricalcolo', () => {
  it('lo stesso ordine ha lo stesso costo logistico da tutte e tre le strade', async () => {
    // 1. Sincronizzazione / webhook.
    (global.fetch as any).mockResolvedValueOnce(ok({ order: nodo() }));
    const letto = await client().getOrderById(4242);
    const scritto = orderToRows(letto!, new Date('2026-08-10T00:00:00Z'), CONFIG)!;

    // 2. Recupero dello storico: lo stesso ordine, salvato con le regole
    //    vecchie (1 pacco, nessun reso), riletto con getOrderShippingFacts.
    (global.fetch as any).mockResolvedValueOnce(ok({ nodes: [nodo()] }));
    const fatti = (await client().getOrderShippingFacts(['4242'])).get('4242')!;
    const vecchia = { ...salvata(scritto), package_count: 1, returned_at: null };
    const dopoRecupero: StoredOrderRow = {
      ...vecchia,
      package_count: fatti.packageCount,
      returned_at: fatti.returnsKnown ? fatti.returnedAt : vecchia.returned_at,
    };

    // 3. Ricalcolo dalle colonne salvate.
    const ricalcolato = computeLogisticsCost(storedOrderToLogisticsInput(salvata(scritto)), CONFIG).total;
    const dopoRecuperoCosto = computeLogisticsCost(storedOrderToLogisticsInput(dopoRecupero), CONFIG).total;

    expect(scritto.order.package_count).toBe(3);
    expect(fatti).toMatchObject({ packageCount: 3, method: 'Corriere Espresso', returnedAt: '2026-08-07T00:00:00Z' });
    expect(scritto.order.logistics_cost).toBe(ricalcolato);
    expect(dopoRecuperoCosto).toBe(scritto.order.logistics_cost);
  });

  it('esempio completo: 3 colli a 4,50, scatola 1,20, reso 6 -> 20,70 di logistica e 59,30 di profitto', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ order: nodo() }));
    const letto = await client().getOrderById(4242);
    const { order, lines } = orderToRows(letto!, new Date('2026-08-10T00:00:00Z'), CONFIG)!;

    // 3 x 4,50 (opzione per collo) + 1,20 (scatola) + 6 (reso CLOSED) = 20,70.
    expect(order.logistics_cost).toBe(20.7);

    // Profitto: netto 100 - costo del venduto 2 x 10 - logistica 20,70.
    const contributo = lines.reduce(
      (s, l) => s + (netContribution({ lineNetTotal: l.line_net_total, unitCost: 10, currentQuantity: l.current_quantity }) ?? 0),
      0,
    );
    expect(Math.round((contributo - order.logistics_cost) * 100) / 100).toBe(59.3);
  });

  it('un reso OPEN poi annullato: il costo del rientro sparisce alla rilettura e al ricalcolo', async () => {
    const aperto = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ status: 'OPEN', createdAt: '2026-08-07T00:00:00Z' }] };
    const annullato = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ status: 'CANCELED', createdAt: '2026-08-07T00:00:00Z' }] };

    (global.fetch as any)
      .mockResolvedValueOnce(ok({ order: nodo({ returns: aperto }) }))
      .mockResolvedValueOnce(ok({ order: nodo({ returns: annullato }) }));

    const prima = orderToRows((await client().getOrderById(4242))!, new Date(), CONFIG)!;
    const dopo = orderToRows((await client().getOrderById(4242))!, new Date(), CONFIG)!;

    expect(prima.order.returned_at).toBe('2026-08-07T00:00:00Z');
    expect(prima.order.logistics_cost).toBe(20.7);
    expect(dopo.order.returned_at).toBeNull();
    expect(dopo.order.logistics_cost).toBe(14.7);
    // Il ricalcolo sulla riga salvata dopo l'annullamento: niente rientro.
    expect(computeLogisticsCost(storedOrderToLogisticsInput(salvata(dopo)), CONFIG).total).toBe(14.7);
  });

  it('il tracking fa fede allo stesso modo in tutte le strade: annullata con BRT9 = spedito, un pacco', async () => {
    const soloAnnullata = nodo({
      displayFulfillmentStatus: 'UNFULFILLED',
      fulfillments: [{ status: 'CANCELLED', trackingInfo: [{ number: 'BRT9' }] }],
      returns: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    });
    (global.fetch as any)
      .mockResolvedValueOnce(ok({ order: soloAnnullata }))
      .mockResolvedValueOnce(ok({ nodes: [soloAnnullata] }));

    const scritto = orderToRows((await client().getOrderById(4242))!, new Date(), CONFIG)!;
    const fatti = (await client().getOrderShippingFacts(['4242'])).get('4242')!;

    expect(scritto.order).toMatchObject({ fulfillment_status: 'FULFILLED', package_count: 1 });
    expect(fatti).toMatchObject({ fulfillmentStatus: 'FULFILLED', packageCount: 1 });
    // 1 x 4,50 + 1,20 di scatola, nessun reso.
    expect(scritto.order.logistics_cost).toBe(5.7);
    expect(computeLogisticsCost(storedOrderToLogisticsInput(salvata(scritto)), CONFIG).total).toBe(5.7);
  });
});
