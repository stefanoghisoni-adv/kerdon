// app/routes/api.stats.products.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const getProducts = vi.fn();
const getInventoryItemCosts = vi.fn();
const getReadinessCache = vi.fn();
const setReadinessCache = vi.fn();
const loadSoldVariantIds = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'test-shop.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) },
    // Il cancello delle capacita' legge il piano del negozio.
    plan: { findFirst: async () => ({ planName: 'pro', customersSyncEnabled: true }) },
  },
}));
vi.mock('~/lib/shopify-api.server', () => ({
  ShopifyAPIClient: class {
    getProducts = (...a: unknown[]) => getProducts(...a);
    getInventoryItemCosts = (...a: unknown[]) => getInventoryItemCosts(...a);
    static async forShop() {
      return new this();
    }
  },
}));
vi.mock('~/lib/cache/stats-cache.server', () => ({
  getReadinessCache: (...a: unknown[]) => getReadinessCache(...a),
  setReadinessCache: (...a: unknown[]) => setReadinessCache(...a),
}));
vi.mock('~/lib/stats/sold-variants.server', () => ({
  loadSoldVariantIds: (...a: unknown[]) => loadSoldVariantIds(...a),
}));
vi.mock('~/lib/stats/eligibility-snapshot.server', () => ({
  upsertTodayEligibilitySnapshot: async () => {},
}));

import { loader } from './api.stats.products';

const call = (url = 'https://app/api/stats/products') =>
  loader({ request: new Request(url), params: {}, context: {} } as any);

const CACHE = { totalProducts: 12, readyCount: 30, problemCount: 2, soldWithoutCost: 1 };

describe('/api/stats/products', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueShop.mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      currentPlan: 'pro',
      // Le colonne da cui la policy decide: senza, il cancello di `use_app`
      // rifiuterebbe prima ancora che il test cominci — ed e' proprio quello
      // che deve fare a un negozio fermo.
      lifecycleStatus: 'active',
      uninstalledAt: null,
      authorization: 'ENABLED',
      trackingAuthorization: 'ENABLED',
      scopes: 'read_products,write_products',
      isInTrial: false,
      trialEndsAt: null,
      activeChargeId: null,
    });
    loadSoldVariantIds.mockResolvedValue({ ids: new Set<string>() });
  });

  it('senza refresh risponde dalla cache, senza chiamare Shopify', async () => {
    getReadinessCache.mockResolvedValue(CACHE);
    const res = await call();
    expect(await res.json()).toMatchObject({ readyCount: 30, problemCount: 2, cached: true });
    expect(getProducts).not.toHaveBeenCalled();
  });

  // Il 4 settembre questo caso ha prodotto un 500 sulla dashboard, e nei log non
  // c'era una riga che dicesse perche'.
  it('Shopify guasto e cache presente: si mostra l ultimo numero noto, marcato vecchio', async () => {
    getReadinessCache.mockResolvedValue(CACHE);
    getProducts.mockRejectedValue(new Error('Shopify API error: INTERNAL_SERVER_ERROR'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await call('https://app/api/stats/products?refresh=1');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ readyCount: 30, cached: true, stale: true });
    expect(error.mock.calls[0][0]).toContain('lettura del catalogo fallita');
    error.mockRestore();
  });

  it('Shopify guasto e nessuna cache: l errore non si nasconde', async () => {
    getReadinessCache.mockResolvedValue(null);
    getProducts.mockRejectedValue(new Error('Shopify API error: INTERNAL_SERVER_ERROR'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(call()).rejects.toThrow('INTERNAL_SERVER_ERROR');
    error.mockRestore();
  });

  it('il calcolo riuscito scrive in cache e non si dichiara vecchio', async () => {
    getReadinessCache.mockResolvedValue(null);
    getProducts.mockResolvedValue({
      products: [
        { id: 1, variants: [{ id: 11, cost: '3.00' }, { id: 12, cost: null }] },
      ],
      nextPageInfo: null,
    });
    getInventoryItemCosts.mockResolvedValue(new Map());

    const res = await call('https://app/api/stats/products?refresh=1');
    // Il tipo va allargato a mano: `stale` esiste solo sul ramo che risponde
    // con la cache, e TypeScript, restringendo alla risposta riuscita, non
    // lascerebbe nemmeno CHIEDERE se il campo c'e' — che e' proprio cio' che
    // questa riga deve verificare.
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ totalProducts: 1, cached: false });
    expect(body.stale).toBeUndefined();
    expect(setReadinessCache).toHaveBeenCalledWith('shop-1', expect.objectContaining({ totalProducts: 1 }));
  });
});
