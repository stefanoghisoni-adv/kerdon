import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { creaFakeWebhookStore } from '~/lib/webhooks/inbox-fake-store';

/**
 * I resi: stessa ricevuta, stessa firma, stessa posta in arrivo degli ordini,
 * e lo stesso lavoro: si rilegge l'ordine del reso e lo si riscrive. E' cosi'
 * che un reso annullato perde il suo costo anche quando Shopify non tocca
 * l'ordine.
 */
const store = creaFakeWebhookStore();
const firma = vi.hoisted(() => ({ valida: true }));

vi.mock('~/lib/webhooks/verify.server', () => ({ verifyWebhook: () => firma.valida }));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn() }));
vi.mock('~/db.server', () => ({
  prisma: {
    get webhookEvent() {
      return store;
    },
    session: { count: async () => 0, findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    shop: { findUnique: vi.fn() },
    plan: { findFirst: vi.fn() },
    syncJob: { create: vi.fn() },
  },
}));

const { getOrderById, getReturnOrderId } = vi.hoisted(() => ({
  getOrderById: vi.fn(),
  getReturnOrderId: vi.fn(),
}));
vi.mock('~/lib/shopify-api.server', () => ({
  ShopifyAPIClient: { forShop: vi.fn(async () => ({ getOrderById, getReturnOrderId })) },
}));
vi.mock('~/lib/tracking/users.server', () => ({ linkUserToCustomer: vi.fn() }));
vi.mock('~/lib/supabase/ensure-users-table.server', () => ({ provisionUsersTable: vi.fn(async () => true) }));

import { action as rotta } from './webhooks.returns';
import { settleWebhookWork } from '~/lib/webhooks/receive.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import type { ShopifyOrder } from '~/lib/customers/order-rows';

async function action(request: Request) {
  const res = await rotta({ request } as never);
  await settleWebhookWork();
  return res;
}

function req(body: unknown, topic = 'returns/cancel', consegna = `c-${Math.random()}`) {
  return new Request('https://app/webhooks/returns', {
    method: 'POST',
    headers: {
      'X-Shopify-Hmac-Sha256': 'sig',
      'X-Shopify-Shop-Domain': 'test-shop.myshopify.com',
      'X-Shopify-Topic': topic,
      'X-Shopify-Webhook-Id': consegna,
    },
    body: JSON.stringify(body),
  });
}

function mockShop() {
  (prisma.shop.findUnique as any).mockResolvedValue({
    id: 'shop-1',
    shopDomain: 'test-shop.myshopify.com',
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products,read_orders,read_all_orders,read_returns',
    currentPlan: 'growth',
    supabaseConfig: { connectionVerifiedAt: new Date(), tableNameProducts: 'products' },
  });
  (prisma.plan.findFirst as any).mockResolvedValue({ planName: 'growth', customersSyncEnabled: true, productFeedsEnabled: true });
  (prisma.syncJob.create as any).mockResolvedValue({});
}

function mockSupabase() {
  const writes: Record<string, any[]> = {};
  (createSupabaseClient as any).mockReturnValue({
    from: (table: string) => ({
      upsert: async (rows: any[]) => {
        writes[table] = [...(writes[table] ?? []), ...rows];
        return { error: null };
      },
      delete: () => {
        const b: any = { eq: () => b, in: () => b, not: () => b, select: async () => ({ data: [], error: null }) };
        return b;
      },
    }),
  });
  return writes;
}

const ordine = (over: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: 5001,
  order_number: '#1042',
  placed_at: '2026-08-27T09:12:00Z',
  updated_at: '2026-08-27T09:12:03Z',
  cancelled_at: null,
  financial_status: 'paid',
  total_price: '50.00',
  currency: 'EUR',
  customer_id: 77,
  customer_first_name: 'Anna',
  customer_last_name: 'Rossi',
  lines: [],
  lines_complete: true,
  fulfillment_status: 'FULFILLED',
  shipping_country_code: 'IT',
  returned_at: null,
  package_count: 1,
  logistics_unknown: [],
  ...over,
});

/** La busta di un reso come la manda Shopify: il reso in cima, l'ordine dentro. */
const busta = (over: Record<string, unknown> = {}) => ({
  id: 9101,
  admin_graphql_api_id: 'gid://shopify/Return/9101',
  status: 'canceled',
  order: { id: 5001, admin_graphql_api_id: 'gid://shopify/Order/5001' },
  ...over,
});

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  firma.valida = true;
  getOrderById.mockResolvedValue(ordine());
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('webhook dei resi', () => {
  it.each(['returns/approve', 'returns/decline', 'returns/cancel', 'returns/close', 'returns/reopen'])(
    '%s: si rilegge l ordine del reso, non il reso, e lo si riscrive',
    async (topic) => {
      mockShop();
      const writes = mockSupabase();

      const res = await action(req(busta(), topic));

      expect(res.status).toBe(200);
      expect(store.righe[0]).toMatchObject({ topic, status: 'completed' });
      // Nella riga si conserva solo l'ordine da rileggere.
      expect(store.righe[0].payload).toEqual({ orderId: 5001, customerId: null, externalId: null });
      expect(getOrderById).toHaveBeenCalledWith(5001);
      expect(getReturnOrderId).not.toHaveBeenCalled();
      expect(writes.orders[0]).toMatchObject({ shopify_order_id: 5001 });
    },
  );

  it('un reso annullato toglie il rientro dall ordine riscritto', async () => {
    mockShop();
    const writes = mockSupabase();
    getOrderById.mockResolvedValue(ordine({ returned_at: null }));

    await action(req(busta(), 'returns/cancel'));

    expect(writes.orders[0]).toMatchObject({ returned_at: null });
  });

  it('busta senza l ordine: lo si ricava dal reso', async () => {
    mockShop();
    mockSupabase();
    getReturnOrderId.mockResolvedValue(5001);

    await action(req({ id: 9101, admin_graphql_api_id: 'gid://shopify/Return/9101' }, 'returns/close'));

    expect(store.righe[0].payload).toEqual({ returnId: 9101 });
    expect(getReturnOrderId).toHaveBeenCalledWith(9101);
    expect(getOrderById).toHaveBeenCalledWith(5001);
    expect(store.righe[0].status).toBe('completed');
  });

  it('reso non piu leggibile: niente da scrivere, evento concluso', async () => {
    mockShop();
    const writes = mockSupabase();
    getReturnOrderId.mockResolvedValue(null);

    await action(req({ id: 9101 }, 'returns/close'));

    expect(getOrderById).not.toHaveBeenCalled();
    expect(writes.orders).toBeUndefined();
    expect(store.righe[0].status).toBe('completed');
  });

  it('firma non valida: rifiutata, niente in posta in arrivo', async () => {
    firma.valida = false;
    const res = await action(req(busta()));
    expect(res.status).toBe(401);
    expect(store.righe).toHaveLength(0);
    expect(getOrderById).not.toHaveBeenCalled();
  });

  it('un topic non dei resi nell header non sceglie il processore', async () => {
    mockShop();
    mockSupabase();
    await action(req(busta(), 'orders/delete'));
    // Si registra col ripiego dei resi, e l'ordine si rilegge, non si cancella.
    expect(store.righe[0].topic).toBe('returns/cancel');
    expect(getOrderById).toHaveBeenCalledWith(5001);
  });
});
