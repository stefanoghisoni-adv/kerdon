import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const findManyPlans = vi.fn();
const countSyncedCustomers = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'test-shop.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) },
    plan: { findMany: (...a: unknown[]) => findManyPlans(...a) },
    partnerPlanPrice: { count: async () => 0 },
  },
}));
vi.mock('~/lib/billing/shop-pricing.server', () => ({
  resolveShopPricing: async (plans: any[]) => ({
    currency: 'EUR',
    plans: plans.map((p) => ({ ...p, priceMonthly: 0, priceYearly: 0 })),
  }),
}));
const createSupabaseClient = vi.fn((_config: unknown) => ({}));
vi.mock('~/lib/supabase.server', () => ({
  createSupabaseClient: (config: unknown) => createSupabaseClient(config),
}));
vi.mock('~/lib/limits/customer-limit.server', () => ({
  countSyncedCustomers: (...a: unknown[]) => countSyncedCustomers(...a),
}));

import { loader } from './api.plan.limits';

const call = () =>
  loader({ request: new Request('https://app/api/plan/limits'), params: {}, context: {} } as any);

const PLANS = [
  { planName: 'Growth', maxProducts: 200, maxCustomers: 250, customersSyncEnabled: true, productFeedsEnabled: false },
  { planName: 'Basic', maxProducts: 20, maxCustomers: 0, customersSyncEnabled: false, productFeedsEnabled: false },
];

describe('/api/plan/limits — clienti', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findManyPlans.mockResolvedValue(PLANS);
    findUniqueShop.mockResolvedValue({
      id: 'shop-1',
      currentPlan: 'growth',
      partnerName: null,
      supabaseConfig: { connectionVerifiedAt: new Date(), tableNameCustomers: 'customers' },
    });
  });

  it('riporta i clienti sincronizzati sul totale consentito', async () => {
    countSyncedCustomers.mockResolvedValue(270);
    const body = await (await call()).json();
    expect(countSyncedCustomers).toHaveBeenCalledWith(expect.anything(), 'customers');
    expect(body.customerQuota).toEqual({ synced: 270, limit: 250, active: 250, paused: 20 });
  });

  it('piano senza clienti: nessuna lettura e nessun conteggio', async () => {
    findUniqueShop.mockResolvedValue({
      id: 'shop-1',
      currentPlan: 'basic',
      partnerName: null,
      supabaseConfig: { connectionVerifiedAt: new Date(), tableNameCustomers: 'customers' },
    });
    const body = await (await call()).json();
    expect(countSyncedCustomers).not.toHaveBeenCalled();
    expect(body.customerQuota).toBeNull();
  });

  it('conteggio non disponibile: null, non zero', async () => {
    countSyncedCustomers.mockResolvedValue(null);
    const body = await (await call()).json();
    expect(body.customerQuota).toBeNull();
  });

  it('credenziali non utilizzabili: niente 500, solo nessun conteggio', async () => {
    // La chiave di servizio non si decifra (segreto sbagliato, chiave non
    // cifrata): l'avviso dei limiti deve rispondere comunque, come quando il
    // conteggio non e' disponibile.
    createSupabaseClient.mockImplementationOnce(() => {
      throw new Error('ENCRYPTION_SECRET must be 64 hex characters (256 bits)');
    });
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).customerQuota).toBeNull();
  });
});
