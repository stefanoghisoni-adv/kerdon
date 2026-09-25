// app/routes/api.stats.customers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const findPlanMock = vi.fn();
const getCustomers = vi.fn();
const getCustomerStatsCache = vi.fn();
const setCustomerStatsCache = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'test-shop.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) },
    // Lo stesso finto risponde anche al cancello delle capacita', che il piano
    // del negozio lo legge da qui.
    plan: { findFirst: (...a: unknown[]) => findPlanMock(...a) },
  },
}));
vi.mock('~/lib/shopify-api.server', () => ({
  ShopifyAPIClient: class {
    getCustomers = (...a: unknown[]) => getCustomers(...a);
    static async forShop() {
      return new this();
    }
  },
}));
vi.mock('~/lib/cache/stats-cache.server', () => ({
  getCustomerStatsCache: (...a: unknown[]) => getCustomerStatsCache(...a),
  setCustomerStatsCache: (...a: unknown[]) => setCustomerStatsCache(...a),
}));

import { loader } from './api.stats.customers';

const call = (url = 'https://app/api/stats/customers') =>
  loader({ request: new Request(url), params: {}, context: {} } as any);

describe('/api/stats/customers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueShop.mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'enc',
      currentPlan: 'growth',
  // Le colonne da cui la policy decide: senza, il cancello di `use_app`
    // rifiuterebbe prima ancora che il test cominci — ed e' proprio quello che
    // deve fare a un negozio fermo.
    lifecycleStatus: 'active',
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products,write_products',
    isInTrial: false,
    trialEndsAt: null,
    activeChargeId: null,
    });
  });

  it('piano senza clienti → enabled false e nessuna chiamata a Shopify', async () => {
    findPlanMock.mockResolvedValue({ customersSyncEnabled: false });
    const res = await call();
    expect(await res.json()).toMatchObject({ enabled: false, optIn: 0, optOut: 0 });
    expect(getCustomers).not.toHaveBeenCalled();
  });

  it('usa la cache quando presente', async () => {
    findPlanMock.mockResolvedValue({ customersSyncEnabled: true });
    getCustomerStatsCache.mockResolvedValue({ totalCustomers: 10, optIn: 6, optOut: 4, computedAt: 'x' });
    const res = await call();
    expect(await res.json()).toMatchObject({ enabled: true, totalCustomers: 10, optIn: 6, optOut: 4, cached: true });
    expect(getCustomers).not.toHaveBeenCalled();
  });

  it('senza cache pagina Shopify e somma i conteggi', async () => {
    findPlanMock.mockResolvedValue({ customersSyncEnabled: true });
    getCustomerStatsCache.mockResolvedValue(null);
    getCustomers
      .mockResolvedValueOnce({
        customers: [
          { id: 1, email_marketing_consent: { state: 'subscribed' } },
          { id: 2, email_marketing_consent: { state: 'unsubscribed' } },
        ],
        nextPageInfo: 'p2',
      })
      .mockResolvedValueOnce({
        customers: [{ id: 3, accepts_marketing: true }],
        nextPageInfo: null,
      });
    const res = await call();
    expect(await res.json()).toMatchObject({ enabled: true, totalCustomers: 3, optIn: 2, optOut: 1, cached: false });
    expect(setCustomerStatsCache).toHaveBeenCalled();
  });
});
