import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('~/lib/webhooks/verify.server', () => ({ verifyWebhook: () => true }));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn() }));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: vi.fn() },
    plan: { findFirst: vi.fn() },
    syncJob: { create: vi.fn() },
  },
}));

import { action } from './webhooks.orders.delete';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';

function req(body: unknown) {
  return new Request('https://app/webhooks/orders/delete', {
    method: 'POST',
    headers: {
      'X-Shopify-Hmac-Sha256': 'sig',
      'X-Shopify-Shop-Domain': 'test-shop.myshopify.com',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function mockShop(over: Record<string, unknown> = {}) {
  (prisma.shop.findUnique as any).mockResolvedValue({
    id: 'shop-1',
    shopDomain: 'test-shop.myshopify.com',
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products,read_orders,read_all_orders',
    currentPlan: 'pro',
    supabaseConfig: { connectionVerifiedAt: new Date(), tableNameProducts: 'products' },
    ...over,
  });
  (prisma.plan.findFirst as any).mockResolvedValue({
    planName: 'pro',
    customersSyncEnabled: true,
    productFeedsEnabled: true,
  });
}

/** Registra le cancellazioni nell'ordine in cui arrivano: qui l'ordine conta. */
function mockSupabase(errors: Record<string, { message: string }> = {}) {
  const deleted: { table: string; orderId: unknown }[] = [];

  (createSupabaseClient as any).mockReturnValue({
    from: (table: string) => ({
      delete: () => ({
        eq: async (_col: string, value: unknown) => {
          deleted.push({ table, orderId: value });
          return errors[table] ? { error: errors[table] } : { error: null };
        },
      }),
    }),
  });

  return { deleted };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('webhook orders/delete', () => {
  it('toglie prima le righe e poi l ordine', async () => {
    // Al contrario della scrittura: se ci si ferma a meta' resta un ordine
    // senza righe — visibile e che non porta margine — invece di righe che
    // nessuna query saprebbe raggruppare.
    mockShop();
    const { deleted } = mockSupabase();

    const res = await action({ request: req({ id: 5001 }) } as any);

    expect(res.status).toBe(200);
    expect(deleted).toEqual([
      { table: 'order_lines', orderId: 5001 },
      { table: 'orders', orderId: 5001 },
    ]);
  });

  it('non rilegge niente: dalla ricevuta prende il solo identificativo', async () => {
    // E' l'unico topic sugli ordini che non rilegge, e non per risparmiare: di
    // un ordine cancellato non c'e' piu' niente da leggere.
    mockShop();
    const { deleted } = mockSupabase();

    await action({ request: req({ id: '5001', name: '#1042', total_price: '119.80' }) } as any);

    expect(deleted[0].orderId).toBe(5001);
  });

  it('righe non rimosse: 500, cosi Shopify riprova', async () => {
    // Le righe rimaste continuerebbero a portare margine per un ordine che su
    // Shopify non esiste piu', e nessuna corsa periodica le toglierebbe mai:
    // la corsa legge cio' che c'e', non sa cosa e' sparito.
    mockShop();
    const { deleted } = mockSupabase({ order_lines: { message: 'permission denied' } });

    const res = await action({ request: req({ id: 5001 }) } as any);

    expect(res.status).toBe(500);
    // L'ordine non si tocca: senza le sue righe via, toglierlo lascerebbe righe
    // orfane e nessun modo di ritrovarle.
    expect(deleted.map((d) => d.table)).toEqual(['order_lines']);
  });

  it('payload senza id: non si cancella niente', async () => {
    mockShop();
    const { deleted } = mockSupabase();

    const res = await action({ request: req({}) } as any);

    expect(res.status).toBe(200);
    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(deleted).toHaveLength(0);
  });

  it('negozio sospeso: nemmeno le cancellazioni passano', async () => {
    // Verrebbe da lasciar passare sempre una rimozione, ma la copia del
    // merchant si ferma tutta insieme: se le aggiunte sono bloccate e le
    // rimozioni no, quel che resta non e' la fotografia di niente.
    mockShop({ authorization: 'DISABLED' });
    mockSupabase();

    const res = await action({ request: req({ id: 5001 }) } as any);

    expect(res.status).toBe(200);
    expect(createSupabaseClient).not.toHaveBeenCalled();
  });

  it('nessun progetto collegato: non c e niente da cui cancellare', async () => {
    mockShop({ supabaseConfig: null });
    mockSupabase();

    const res = await action({ request: req({ id: 5001 }) } as any);

    expect(res.status).toBe(200);
    expect(createSupabaseClient).not.toHaveBeenCalled();
  });

  it('corpo illeggibile: 200, perche riprovarlo non servirebbe', async () => {
    mockShop();
    mockSupabase();

    const res = await action({ request: req('{ non e JSON') } as any);

    expect(res.status).toBe(200);
    expect(createSupabaseClient).not.toHaveBeenCalled();
  });
});
