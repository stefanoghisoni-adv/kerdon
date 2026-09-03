import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

// Mock all dependencies BEFORE imports (using factory functions)
vi.mock('../../db.server', () => ({
  prisma: {
    shop: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    syncJob: {
      create: vi.fn(),
      update: vi.fn(),
      // Usata dalla potatura del dettaglio: quali corse restano raggiungibili.
      findMany: vi.fn(async () => []),
    },
    syncJobEvent: {
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    plan: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../../utils/crypto.server', () => ({
  decrypt: (val: string) => `decrypted_${val}`,
}));

// `forShop` delega al costruttore mockato: cosi' i mockImplementation gia'
// scritti nei singoli test continuano a governare cosa restituisce il client.
vi.mock('../shopify-api.server', () => {
  const ctor = vi.fn();
  return {
    ShopifyAPIClient: Object.assign(ctor, {
      forShop: vi.fn(async (shop: string) => new (ctor as any)(shop)),
    }),
  };
});

vi.mock('../supabase.server', () => ({
  createSupabaseClient: vi.fn(),
}));

vi.mock('../transformers/product.server', () => ({
  transformProduct: vi.fn(),
}));

vi.mock('../stats/inventory-cost.server', () => ({
  enrichVariantCosts: vi.fn(async (_client: unknown, products: unknown) => products),
}));

// La tabella prodotti si da' per presente: la sua verifica ha i test suoi
// (ensure-products-table.test.ts) e qui aggiungerebbe solo rumore ai doppioni
// del client Supabase.
vi.mock('../supabase/ensure-products-table.server', () => ({
  ensureProductsTable: vi.fn(async () => ({ status: 'already_present', empty: false })),
}));

// Import after mocks
import { processInitialBulkSync } from './processors.server';
import { ShopifyAPIClient } from '../shopify-api.server';
import { createSupabaseClient } from '../supabase.server';
import { transformProduct } from '../transformers/product.server';
import { prisma } from '../../db.server';
import { ensureProductsTable } from '../supabase/ensure-products-table.server';

/**
 * La sync legge le varianti già presenti (in pagine, con .range) per capire
 * quali righe sono aggiunte di questa corsa. È una lettura accessoria: qui la
 * si serve vuota, così i test che non guardano il dettaglio restano come erano.
 */
const emptyProductsSelect = () => ({
  range: async () => ({ data: [], error: null }),
  in: async () => ({ data: [], error: null }),
});

// I processor non ricompongono piu' le condizioni sul posto: chiedono alla
// policy se quel negozio puo' sincronizzare. Da qui i due campi in piu' su ogni
// negozio finto — installato e autorizzato — che prima si davano per scontati
// perche' nessuno li guardava.
describe('Initial bulk sync processor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should sync all products with pagination and separated upserts', async () => {
    // Mock shop with config
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      uninstalledAt: null,
      authorization: 'ENABLED',
      accessToken: 'encrypted-token',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'encrypted-key',
        supabaseServiceRoleKey: 'encrypted-service',
      },
    };

    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);

    // Mock SyncJob create
    const mockSyncJob = { id: 'sync-job-1' };
    vi.mocked(prisma.syncJob.create).mockResolvedValue(mockSyncJob as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);

    // Mock Shopify API client - 2 pages of products
    const mockProducts1 = [
      { id: 1, title: 'Product 1', variants: [{ id: 101, title: 'Variant 1' }, { id: 102, title: 'Variant 2' }] },
      { id: 2, title: 'Product 2', variants: [{ id: 201, title: 'Default Title' }] },
    ];
    const mockProducts2 = [
      { id: 3, title: 'Product 3', variants: [{ id: 301, title: 'Variant A' }, { id: 302, title: 'Variant B' }] },
    ];

    let getProductsCallCount = 0;
    const mockGetProducts = vi.fn().mockImplementation(async (options) => {
      getProductsCallCount++;
      if (getProductsCallCount === 1) {
        return { products: mockProducts1, nextPageInfo: 'page-2-token' };
      }
      if (getProductsCallCount === 2) {
        return { products: mockProducts2, nextPageInfo: null };
      }
      return { products: [], nextPageInfo: null };
    });

    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: mockGetProducts,
    } as any));

    // Mock transformProduct to return rows with is_variant flag
    vi.mocked(transformProduct)
      .mockReturnValueOnce([
        { shopify_product_id: 1, shopify_variant_id: 101, is_variant: true } as any,
        { shopify_product_id: 1, shopify_variant_id: 102, is_variant: true } as any,
      ])
      .mockReturnValueOnce([
        { shopify_product_id: 2, shopify_variant_id: null, is_variant: false } as any,
      ])
      .mockReturnValueOnce([
        { shopify_product_id: 3, shopify_variant_id: 301, is_variant: true } as any,
        { shopify_product_id: 3, shopify_variant_id: 302, is_variant: true } as any,
      ]);

    // Mock Supabase client
    const mockUpsert = vi.fn().mockReturnValue({
      error: null,
    });

    // Il clear dei prodotti prima del ripopolamento: .delete().gte(...) → { error: null }
    const mockGte = vi.fn().mockReturnValue({ error: null });
    const mockLt = vi.fn().mockReturnValue({ error: null });
    const mockDelete = vi.fn().mockReturnValue({ gte: mockGte, lt: mockLt });
    const mockFrom = vi.fn().mockReturnValue({
      upsert: mockUpsert,
      delete: mockDelete,
      // Lettura delle varianti già presenti: serve solo al dettaglio.
      select: emptyProductsSelect,
    });

    vi.mocked(createSupabaseClient).mockReturnValue({
      from: mockFrom,
    } as any);

    // Mock BullMQ job
    const mockJob = {
      updateProgress: vi.fn().mockResolvedValue(undefined),
    } as unknown as Job;

    // Execute bulk sync
    await processInitialBulkSync('shop-1', mockJob);

    // Verify shop was loaded with config
    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      where: { id: 'shop-1' },
      include: { supabaseConfig: true },
    });

    // Verify SyncJob was created as 'running'
    expect(prisma.syncJob.create).toHaveBeenCalledWith({
      data: {
        shopId: 'shop-1',
        jobType: 'initial_bulk',
        status: 'running',
      },
    });

    // Verify pagination: getProducts called twice (page 1, page 2)
    expect(getProductsCallCount).toBe(2);

    // Verify transformProduct called for each product (3 products total)
    expect(transformProduct).toHaveBeenCalledTimes(3);

    // Verify products upsert usa SEMPRE la chiave univoca shopify_variant_id
    // (anche i prodotti a variante singola ora hanno un id reale).
    expect(mockUpsert).toHaveBeenCalled();

    const productUpsertCalls = mockUpsert.mock.calls.filter(
      call => call[1]?.onConflict === 'shopify_variant_id'
    );
    expect(productUpsertCalls.length).toBeGreaterThan(0);

    // Nessun upsert deve più usare shopify_product_id (non ha vincolo UNIQUE).
    const nonVariantUpsertCalls = mockUpsert.mock.calls.filter(
      call => call[1]?.onConflict === 'shopify_product_id'
    );
    expect(nonVariantUpsertCalls.length).toBe(0);

    // Verify job progress was updated
    expect(mockJob.updateProgress).toHaveBeenCalled();

    // Verify SyncJob progress updates
    expect(prisma.syncJob.update).toHaveBeenCalledWith({
      where: { id: 'sync-job-1' },
      data: expect.objectContaining({
        productsSynced: expect.any(Number),
        variantsSynced: expect.any(Number),
      }),
    });

    // Verify SyncJob was marked as completed
    const completedCall = vi.mocked(prisma.syncJob.update).mock.calls.find(
      (call: any) => call[0].data?.status === 'completed'
    );
    expect(completedCall).toBeDefined();
    expect(completedCall?.[0].data).toMatchObject({
      status: 'completed',
      completedAt: expect.any(Date),
    });
  });

  it('should handle sync errors and mark job as failed', async () => {
    const mockShop = {
      id: 'shop-2',
      shopDomain: 'test-shop.myshopify.com',
      uninstalledAt: null,
      authorization: 'ENABLED',
      accessToken: 'encrypted-token',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'encrypted-key',
        supabaseServiceRoleKey: 'encrypted-service',
      },
    };

    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);

    const mockSyncJob = { id: 'sync-job-2' };
    vi.mocked(prisma.syncJob.create).mockResolvedValue(mockSyncJob as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);

    // Supabase mock (il clear prodotti gira prima di getProducts).
    const mockGte = vi.fn().mockReturnValue({ error: null });
    const mockLt = vi.fn().mockReturnValue({ error: null });
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({ gte: mockGte, lt: mockLt }),
        upsert: vi.fn().mockReturnValue({ error: null }),
        select: emptyProductsSelect,
      }),
    } as any);

    // Mock Shopify API to throw error
    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: vi.fn().mockRejectedValue(new Error('Shopify API error')),
    } as any));

    const mockJob = {
      updateProgress: vi.fn().mockResolvedValue(undefined),
    } as unknown as Job;

    // Expect the sync to throw
    await expect(processInitialBulkSync('shop-2', mockJob)).rejects.toThrow('Shopify API error');

    // Verify SyncJob was marked as failed
    const failedCall = vi.mocked(prisma.syncJob.update).mock.calls.find(
      (call: any) => call[0].data?.status === 'failed'
    );
    expect(failedCall).toBeDefined();
    expect(failedCall?.[0].data).toMatchObject({
      status: 'failed',
      completedAt: expect.any(Date),
      errors: {
        message: 'Shopify API error',
      },
    });
  });

  it('tabella prodotti non disponibile → si ferma subito, senza scaricare da Shopify', async () => {
    // Il guasto da cui nasce il controllo: la corsa scaricava mezzo catalogo e
    // poi si schiantava sull'upsert con l'errore grezzo dell'API REST.
    vi.mocked(ensureProductsTable).mockResolvedValueOnce({
      status: 'unavailable',
      empty: false,
    });

    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-3',
      shopDomain: 'test-shop.myshopify.com',
      uninstalledAt: null,
      authorization: 'ENABLED',
      accessToken: 'encrypted-token',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'encrypted-key',
        supabaseServiceRoleKey: 'encrypted-service',
      },
    } as any);
    vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'sync-job-3' } as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);
    vi.mocked(createSupabaseClient).mockReturnValue({ from: vi.fn() } as any);

    const getProducts = vi.fn();
    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({ getProducts } as any));

    await expect(processInitialBulkSync('shop-3')).rejects.toThrow('Tabella prodotti');
    expect(getProducts).not.toHaveBeenCalled();

    const failedCall = vi.mocked(prisma.syncJob.update).mock.calls.find(
      (call: any) => call[0].data?.status === 'failed',
    );
    expect(failedCall).toBeDefined();
  });

  it('should cap synced products to the plan maxProducts limit', async () => {
    const mockShop = {
      id: 'shop-free',
      shopDomain: 'test-shop.myshopify.com',
      uninstalledAt: null,
      authorization: 'ENABLED',
      accessToken: 'encrypted-token',
      currentPlan: 'free',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'encrypted-key',
        supabaseServiceRoleKey: 'encrypted-service',
      },
    };

    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);
    // Piano con tetto di 2 prodotti.
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: 2 } as any);
    vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'sync-free' } as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);

    // Una sola pagina con 3 prodotti (più del limite) e un cursore successivo:
    // il cap deve fermare la paginazione senza chiedere la pagina 2.
    const page = [
      { id: 1, title: 'P1', variants_complete: true, variants: [{ id: 101 }] },
      { id: 2, title: 'P2', variants_complete: true, variants: [{ id: 201 }] },
      { id: 3, title: 'P3', variants_complete: true, variants: [{ id: 301 }] },
    ];
    const mockGetProducts = vi.fn().mockResolvedValue({ products: page, nextPageInfo: 'page-2' });
    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: mockGetProducts,
    } as any));

    vi.mocked(transformProduct).mockImplementation((p: any) => [
      { shopify_product_id: p.id, shopify_variant_id: p.variants[0].id, is_variant: true } as any,
    ]);

    const mockGte = vi.fn().mockReturnValue({ error: null });
    const mockLt = vi.fn().mockReturnValue({ error: null });
    const mockUpsert = vi.fn().mockReturnValue({ error: null });
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn().mockReturnValue({
        delete: vi.fn().mockReturnValue({ gte: mockGte, lt: mockLt }),
        upsert: mockUpsert,
        select: emptyProductsSelect,
      }),
    } as any);

    const mockJob = { updateProgress: vi.fn().mockResolvedValue(undefined) } as unknown as Job;

    await processInitialBulkSync('shop-free', mockJob);

    // Solo 2 prodotti trasformati (cap), e paginazione fermata dopo la pagina 1.
    expect(transformProduct).toHaveBeenCalledTimes(2);
    expect(mockGetProducts).toHaveBeenCalledTimes(1);

    // Job completato con productsSynced = 2.
    const completedCall = vi.mocked(prisma.syncJob.update).mock.calls.find(
      (call: any) => call[0].data?.status === 'completed'
    );
    expect(completedCall).toBeDefined();

    const progressCall = vi.mocked(prisma.syncJob.update).mock.calls.find(
      (call: any) => call[0].data?.productsSynced === 2
    );
    expect(progressCall).toBeDefined();
  });

  it('should throw error if shop not configured for sync', async () => {
    const mockShop = {
      id: 'shop-3',
      shopDomain: 'test-shop.myshopify.com',
      uninstalledAt: null,
      authorization: 'ENABLED',
      accessToken: 'encrypted-token',
      supabaseConfig: null,
    };

    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);

    const mockJob = {
      updateProgress: vi.fn().mockResolvedValue(undefined),
    } as unknown as Job;

    await expect(processInitialBulkSync('shop-3', mockJob)).rejects.toThrow(
      'Shop shop-3 not configured for sync'
    );
  });

  it('upserta solo le varianti idonee e non conta i prodotti senza costo verso il tetto', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'free',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
    };
    (prisma.shop.findUnique as any).mockResolvedValue(mockShop);
    (prisma.plan.findFirst as any).mockResolvedValue({ maxProducts: null, customersSyncEnabled: false });
    (prisma.syncJob.create as any).mockResolvedValue({ id: 'job-1' });
    (prisma.syncJob.update as any).mockResolvedValue({});

    // Pagina 1: due prodotti. Prodotto A con una variante idonea e una no;
    // prodotto B senza varianti idonee.
    const upserted: any[] = [];
    const supabaseMock = {
      from: () => ({
        delete: () => ({
          gte: async () => ({ error: null }),
          lt: async () => ({ error: null }),
        }),
        upsert: async (rows: any[]) => { upserted.push(...rows); return { error: null }; },
        select: emptyProductsSelect,
      }),
    };
    (createSupabaseClient as any).mockReturnValue(supabaseMock);
    (ShopifyAPIClient as any).mockImplementation(() => ({
      getProducts: vi
        .fn()
        .mockResolvedValueOnce({ products: [{ id: 1 }, { id: 2 }], nextPageInfo: null })
        .mockResolvedValue({ products: [], nextPageInfo: null }),
    }));
    (transformProduct as any).mockImplementation((p: any) =>
      p.id === 1
        ? [
            { shopify_product_id: 1, shopify_variant_id: 11, cost_per_item: 5 },
            { shopify_product_id: 1, shopify_variant_id: 12, cost_per_item: null },
          ]
        : [{ shopify_product_id: 2, shopify_variant_id: 21, cost_per_item: null }],
    );

    const job = { updateProgress: vi.fn() } as any;
    await processInitialBulkSync('shop-1', job);

    // Solo la variante 11 (idonea) è stata upsertata.
    expect(upserted.map((r) => r.shopify_variant_id)).toEqual([11]);
    // Il progresso registra 1 prodotto (A) e 1 variante: B, senza varianti idonee,
    // non consuma quota. (updateProgress riceve i totali cumulativi; qui c'è una
    // sola pagina, quindi coincidono coi totali di pagina.)
    expect(job.updateProgress).toHaveBeenCalledWith({ products: 1, variants: 1 });
  });

  it('non azzera piu la tabella prodotti', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'free',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
    };
    (prisma.shop.findUnique as any).mockResolvedValue(mockShop);
    (prisma.plan.findFirst as any).mockResolvedValue({ maxProducts: null, customersSyncEnabled: false });
    (prisma.syncJob.create as any).mockResolvedValue({ id: 'job-1' });
    (prisma.syncJob.update as any).mockResolvedValue({});

    const deleteCalls: { method: string; args: any[] }[] = [];
    const supabaseMock = {
      from: () => ({
        delete: () => ({
          gte: async (...a: any[]) => { deleteCalls.push({ method: 'gte', args: a }); return { error: null }; },
          lt: async (...a: any[]) => { deleteCalls.push({ method: 'lt', args: a }); return { error: null }; },
        }),
        upsert: async () => ({ error: null }),
        select: emptyProductsSelect,
      }),
    };
    (createSupabaseClient as any).mockReturnValue(supabaseMock);
    (ShopifyAPIClient as any).mockImplementation(() => ({
      getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
    }));

    await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

    // L'azzeramento totale passava da delete().gte('shopify_product_id', 0).
    expect(deleteCalls.some((c) => c.method === 'gte')).toBe(false);
  });

  it('spazza le righe non toccate dopo una scansione completa', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'free',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
    };
    (prisma.shop.findUnique as any).mockResolvedValue(mockShop);
    (prisma.plan.findFirst as any).mockResolvedValue({ maxProducts: null, customersSyncEnabled: false });
    (prisma.syncJob.create as any).mockResolvedValue({ id: 'job-1' });
    (prisma.syncJob.update as any).mockResolvedValue({});

    const deleteCalls: { method: string; args: any[] }[] = [];
    const supabaseMock = {
      from: () => ({
        delete: () => ({
          gte: async (...a: any[]) => { deleteCalls.push({ method: 'gte', args: a }); return { error: null }; },
          lt: async (...a: any[]) => { deleteCalls.push({ method: 'lt', args: a }); return { error: null }; },
        }),
        upsert: async () => ({ error: null }),
        select: emptyProductsSelect,
      }),
    };
    (createSupabaseClient as any).mockReturnValue(supabaseMock);
    (ShopifyAPIClient as any).mockImplementation(() => ({
      getProducts: vi.fn().mockResolvedValue({ products: [{ id: 1, variants_complete: true }], nextPageInfo: null }),
    }));
    (transformProduct as any).mockReturnValue([
      { shopify_product_id: 1, shopify_variant_id: 10, cost_per_item: 5 },
    ]);

    await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

    const sweep = deleteCalls.find((c) => c.method === 'lt');
    expect(sweep).toBeDefined();
    expect(sweep!.args[0]).toBe('synced_at');
  });

  it('non spazza nulla se la scansione fallisce a meta', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'free',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
    };
    (prisma.shop.findUnique as any).mockResolvedValue(mockShop);
    (prisma.plan.findFirst as any).mockResolvedValue({ maxProducts: null, customersSyncEnabled: false });
    (prisma.syncJob.create as any).mockResolvedValue({ id: 'job-1' });
    (prisma.syncJob.update as any).mockResolvedValue({});

    const deleteCalls: { method: string; args: any[] }[] = [];
    const supabaseMock = {
      from: () => ({
        delete: () => ({
          gte: async (...a: any[]) => { deleteCalls.push({ method: 'gte', args: a }); return { error: null }; },
          lt: async (...a: any[]) => { deleteCalls.push({ method: 'lt', args: a }); return { error: null }; },
        }),
        upsert: async () => ({ error: null }),
        select: emptyProductsSelect,
      }),
    };
    (createSupabaseClient as any).mockReturnValue(supabaseMock);
    (ShopifyAPIClient as any).mockImplementation(() => ({
      getProducts: vi
        .fn()
        .mockResolvedValueOnce({ products: [{ id: 1 }], nextPageInfo: 'p2' })
        .mockRejectedValueOnce(new Error('Shopify API error')),
    }));

    await expect(
      processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any),
    ).rejects.toThrow();

    // Nessuna cancellazione: meglio righe obsolete che perdere prodotti veri.
    expect(deleteCalls.some((c) => c.method === 'lt')).toBe(false);
  });

  it('spazza anche quando si raggiunge il tetto del piano', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'free',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
    };
    (prisma.shop.findUnique as any).mockResolvedValue(mockShop);
    (prisma.plan.findFirst as any).mockResolvedValue({ maxProducts: 1, customersSyncEnabled: false });
    (prisma.syncJob.create as any).mockResolvedValue({ id: 'job-1' });
    (prisma.syncJob.update as any).mockResolvedValue({});

    const deleteCalls: { method: string; args: any[] }[] = [];
    const supabaseMock = {
      from: () => ({
        delete: () => ({
          gte: async (...a: any[]) => { deleteCalls.push({ method: 'gte', args: a }); return { error: null }; },
          lt: async (...a: any[]) => { deleteCalls.push({ method: 'lt', args: a }); return { error: null }; },
        }),
        upsert: async () => ({ error: null }),
        select: emptyProductsSelect,
      }),
    };
    (createSupabaseClient as any).mockReturnValue(supabaseMock);
    (ShopifyAPIClient as any).mockImplementation(() => ({
      getProducts: vi.fn().mockResolvedValue({
        products: [{ id: 1, variants_complete: true }, { id: 2, variants_complete: true }],
        nextPageInfo: 'p2',
      }),
    }));
    (transformProduct as any).mockImplementation((p: any) => [
      { shopify_product_id: p.id, shopify_variant_id: p.id * 10, cost_per_item: 5 },
    ]);

    await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

    // Il tetto e' una terminazione regolare: la spazzata deve avvenire.
    expect(deleteCalls.some((c) => c.method === 'lt')).toBe(true);
  });

  it('registra il piano usato quando la sync si completa', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'pro',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
    };
    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: null, customersSyncEnabled: false } as any);
    vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'job-1' } as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);
    vi.mocked(prisma.shop.update).mockResolvedValue({} as any);

    const mockGte = vi.fn().mockReturnValue({ error: null });
    const mockLt = vi.fn().mockReturnValue({ error: null });
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: () => ({
        upsert: vi.fn().mockReturnValue({ error: null }),
        delete: () => ({ gte: mockGte, lt: mockLt }),
        select: emptyProductsSelect,
      }),
    } as any);
    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
    }) as any);

    await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

    expect(prisma.shop.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'shop-1' },
        data: expect.objectContaining({ lastSyncedPlan: 'pro' }),
      }),
    );
  });

  it('sincronizza solo i clienti opt-in', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'pro',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
    };
    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: null, customersSyncEnabled: true } as any);
    vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'job-1' } as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);
    vi.mocked(prisma.shop.update).mockResolvedValue({} as any);

    const upserted: any[] = [];
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: () => ({
        upsert: (rows: any[]) => { upserted.push(...rows); return { error: null }; },
        // Verifica della tabella clienti: qui c'e' gia' ed e' popolata.
        select: () => ({
          limit: async () => ({ data: [{ shopify_customer_id: 1 }], error: null }),
          range: async () => ({ data: [], error: null }),
          in: async () => ({ data: [], error: null }),
        }),
        update: () => ({
          in: () => ({ error: null, count: 0 }),
          eq: () => ({ error: null, count: 0 }),
        }),
        delete: () => ({
          gte: vi.fn().mockReturnValue({ error: null }),
          lt: vi.fn().mockReturnValue({ error: null }),
        }),
      }),
    } as any);

    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
      getCustomers: vi.fn().mockResolvedValue({
        customers: [
          { id: 1, email: 'si@x.it', email_marketing_consent: { state: 'subscribed' } },
          { id: 2, email: 'no@x.it', email_marketing_consent: { state: 'unsubscribed' } },
          { id: 3, email: 'legacy@x.it', accepts_marketing: true },
        ],
        nextPageInfo: null,
      }),
    }) as any);

    await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

    // Solo i due consenzienti (nidificato subscribed + legacy true).
    const customerIds = upserted
      .filter((r) => r.shopify_customer_id != null)
      .map((r) => r.shopify_customer_id);
    expect(customerIds).toEqual([1, 3]);
  });

  it('chi ha revocato non entra, e la sua riga resta dov e', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'pro',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
    };
    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: null, customersSyncEnabled: true } as any);
    vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'job-1' } as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);
    vi.mocked(prisma.shop.update).mockResolvedValue({} as any);

    const upserted: any[] = [];
    const revokedUpdates: Array<{ table: string; payload: any; ids: any }> = [];
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: (table: string) => ({
        upsert: (rows: any[]) => { upserted.push(...rows); return { error: null }; },
        select: () => ({
          limit: async () => ({ data: [{ shopify_customer_id: 1 }], error: null }),
          range: async () => ({ data: [], error: null }),
          in: async () => ({ data: [], error: null }),
        }),
        update: (payload: any) => ({
          in: (_col: string, ids: any) => {
            revokedUpdates.push({ table, payload, ids });
            return { error: null, count: ids.length };
          },
        }),
        delete: () => ({
          gte: vi.fn().mockReturnValue({ error: null }),
          lt: vi.fn().mockReturnValue({ error: null }),
        }),
      }),
    } as any);

    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
      getCustomers: vi.fn().mockResolvedValue({
        customers: [
          { id: 1, email: 'si@x.it', email_marketing_consent: { state: 'subscribed' } },
          { id: 2, email: 'no@x.it', email_marketing_consent: { state: 'unsubscribed' } },
          { id: 4, email: 'no2@x.it', email_marketing_consent: { state: 'unsubscribed' } },
        ],
        nextPageInfo: null,
      }),
    }) as any);

    await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

    // I revocanti NON finiscono nell'upsert...
    expect(upserted.map((r) => r.shopify_customer_id).filter((v) => v != null)).toEqual([1]);
    // ...e in una sola chiamata perdono il consenso e i dati che li
    // identificavano: una riga marcata ma intatta restava leggibile per sempre
    // a chi ha le credenziali del database del merchant.
    // Una sola scrittura, su una colonna sola: non si cancella niente. Chi si
    // disiscrive dalle comunicazioni non ha chiesto di sparire dagli archivi
    // del negozio, e a impedire che il dato venga usato e' il rifiuto del
    // proxy, non la cancellazione.
    expect(revokedUpdates).toHaveLength(1);
    const cliente = revokedUpdates[0];
    expect(cliente.table).toBe('customers');
    expect(cliente.ids).toEqual([2, 4]);
    expect(cliente.payload).toEqual({ accepts_marketing: false });
  });

  // La data di nascita nei due versi. Il merchant puo' scriverla a mano nella
  // sua tabella, ed e' l'unico posto in cui quel valore esiste: Shopify vince
  // quando ne ha una, ma quando non ce l'ha non deve cancellarla — e quello che
  // ha solo lui va rimesso su Shopify, dove temi, segmenti e automazioni lo
  // vedono.
  describe('data di nascita', () => {
    const shopWith = (extra: Record<string, unknown>) => ({
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'pro',
      scopes: 'read_products,read_customers,write_customers',
      // Il campo standard, quello che l'app sa accendere sul negozio.
      birthdateMetafieldNamespace: 'facts',
      birthdateMetafieldKey: 'birth_date',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
      ...extra,
    });

    /**
     * Il database del merchant, con dentro quello che ha scritto a mano.
     * `select().in()` e' la lettura che il processor fa PRIMA dell'upsert, ed e'
     * la stessa che gia' serviva a distinguere aggiunti da aggiornati.
     */
    const supabaseWith = (stored: any[], upserted: any[]) => ({
      from: () => ({
        upsert: (rows: any[]) => { upserted.push(...rows); return { error: null }; },
        select: () => ({
          limit: async () => ({ data: [{ shopify_customer_id: 1 }], error: null }),
          range: async () => ({ data: [], error: null }),
          in: async () => ({ data: stored, error: null }),
        }),
        update: () => ({
          in: () => ({ error: null, count: 0 }),
          eq: () => ({ error: null, count: 0 }),
        }),
        delete: () => ({
          gte: vi.fn().mockReturnValue({ error: null }),
          lt: vi.fn().mockReturnValue({ error: null }),
        }),
      }),
    });

    const prepare = (shop: any) => {
      vi.mocked(prisma.shop.findUnique).mockResolvedValue(shop as any);
      vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: null, customersSyncEnabled: true } as any);
      vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'job-1' } as any);
      vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);
      vi.mocked(prisma.shop.update).mockResolvedValue({} as any);
    };

    it('Shopify ha la data: vince lei, e non si riscrive niente', async () => {
      prepare(shopWith({}));
      const upserted: any[] = [];
      vi.mocked(createSupabaseClient).mockReturnValue(
        supabaseWith([{ shopify_customer_id: 1, date_of_birth: '19700101' }], upserted) as any,
      );

      const setCustomerBirthdates = vi.fn().mockResolvedValue({ written: 0, errors: [] });
      vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
        getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
        getCustomers: vi.fn().mockResolvedValue({
          customers: [
            {
              id: 1,
              email: 'si@x.it',
              email_marketing_consent: { state: 'subscribed' },
              date_of_birth: '1985-04-23',
            },
          ],
          nextPageInfo: null,
        }),
        setCustomerBirthdates,
      }) as any);

      await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

      const cliente = upserted.find((r) => r.shopify_customer_id === 1);
      expect(cliente.date_of_birth).toBe('19850423');
      expect(setCustomerBirthdates).not.toHaveBeenCalled();
    });

    it('Shopify vuoto e database del merchant pieno: la colonna non si azzera e la data torna su Shopify', async () => {
      prepare(shopWith({}));
      const upserted: any[] = [];
      vi.mocked(createSupabaseClient).mockReturnValue(
        supabaseWith([{ shopify_customer_id: 1, date_of_birth: '19850423' }], upserted) as any,
      );

      const setCustomerBirthdates = vi.fn().mockResolvedValue({ written: 1, errors: [] });
      vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
        getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
        getCustomers: vi.fn().mockResolvedValue({
          customers: [
            {
              id: 1,
              email: 'si@x.it',
              email_marketing_consent: { state: 'subscribed' },
              // Il metafield e' stato chiesto ed e' vuoto.
              date_of_birth: null,
            },
          ],
          nextPageInfo: null,
        }),
        setCustomerBirthdates,
      }) as any);

      await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

      // La chiave fuori dalla riga: PostgREST non tocca la colonna, e il valore
      // scritto a mano dal merchant resta dov'e'.
      const cliente = upserted.find((r) => r.shopify_customer_id === 1);
      expect('date_of_birth' in cliente).toBe(false);

      // E parte per Shopify, nella forma che vuole un metafield `date`.
      expect(setCustomerBirthdates).toHaveBeenCalledWith(
        [{ customerId: 1, date: '1985-04-23' }],
        { namespace: 'facts', key: 'birth_date', type: 'date' },
      );
    });

    it('Shopify vuoto e database del merchant vuoto: non succede niente', async () => {
      prepare(shopWith({}));
      const upserted: any[] = [];
      vi.mocked(createSupabaseClient).mockReturnValue(
        supabaseWith([{ shopify_customer_id: 1, date_of_birth: null }], upserted) as any,
      );

      const setCustomerBirthdates = vi.fn().mockResolvedValue({ written: 0, errors: [] });
      vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
        getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
        getCustomers: vi.fn().mockResolvedValue({
          customers: [
            { id: 1, email: 'si@x.it', email_marketing_consent: { state: 'subscribed' }, date_of_birth: null },
          ],
          nextPageInfo: null,
        }),
        setCustomerBirthdates,
      }) as any);

      await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

      const cliente = upserted.find((r) => r.shopify_customer_id === 1);
      expect('date_of_birth' in cliente).toBe(false);
      expect(setCustomerBirthdates).not.toHaveBeenCalled();
    });

    it('senza il permesso di scrittura si salta, e la sincronizzazione arriva in fondo lo stesso', async () => {
      prepare(shopWith({ scopes: 'read_products,read_customers' }));
      const upserted: any[] = [];
      vi.mocked(createSupabaseClient).mockReturnValue(
        supabaseWith([{ shopify_customer_id: 1, date_of_birth: '19850423' }], upserted) as any,
      );

      const setCustomerBirthdates = vi.fn().mockResolvedValue({ written: 0, errors: [] });
      vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
        getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
        getCustomers: vi.fn().mockResolvedValue({
          customers: [
            { id: 1, email: 'si@x.it', email_marketing_consent: { state: 'subscribed' }, date_of_birth: null },
          ],
          nextPageInfo: null,
        }),
        setCustomerBirthdates,
      }) as any);

      await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

      expect(setCustomerBirthdates).not.toHaveBeenCalled();
      // Il cliente e' comunque sincronizzato: il permesso mancante non e' un
      // guasto, e non deve far fallire cio' che sa gia' funzionare.
      expect(upserted.some((r) => r.shopify_customer_id === 1)).toBe(true);
    });

    it('una data malformata sul database del merchant non parte per Shopify', async () => {
      prepare(shopWith({}));
      const upserted: any[] = [];
      vi.mocked(createSupabaseClient).mockReturnValue(
        supabaseWith([{ shopify_customer_id: 1, date_of_birth: 'boh' }], upserted) as any,
      );

      const setCustomerBirthdates = vi.fn().mockResolvedValue({ written: 0, errors: [] });
      vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
        getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
        getCustomers: vi.fn().mockResolvedValue({
          customers: [
            { id: 1, email: 'si@x.it', email_marketing_consent: { state: 'subscribed' }, date_of_birth: null },
          ],
          nextPageInfo: null,
        }),
        setCustomerBirthdates,
      }) as any);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);
      warn.mockRestore();

      expect(setCustomerBirthdates).not.toHaveBeenCalled();
    });

    it('chi ha revocato il consenso non viene mai riscritto su Shopify', async () => {
      prepare(shopWith({}));
      const upserted: any[] = [];
      vi.mocked(createSupabaseClient).mockReturnValue(
        supabaseWith([{ shopify_customer_id: 2, date_of_birth: '19850423' }], upserted) as any,
      );

      const setCustomerBirthdates = vi.fn().mockResolvedValue({ written: 0, errors: [] });
      vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
        getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
        getCustomers: vi.fn().mockResolvedValue({
          customers: [
            { id: 2, email: 'no@x.it', email_marketing_consent: { state: 'unsubscribed' }, date_of_birth: null },
          ],
          nextPageInfo: null,
        }),
        setCustomerBirthdates,
      }) as any);

      await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

      // I suoi dati stanno per essere svuotati, non rimessi in circolo.
      expect(setCustomerBirthdates).not.toHaveBeenCalled();
    });

    it('il campo scelto dal merchant si legge ma non si riscrive: del suo tipo non sappiamo niente', async () => {
      prepare(shopWith({
        birthdateMetafieldNamespace: 'custom',
        birthdateMetafieldKey: 'data_di_nascita',
      }));
      const upserted: any[] = [];
      vi.mocked(createSupabaseClient).mockReturnValue(
        supabaseWith([{ shopify_customer_id: 1, date_of_birth: '19850423' }], upserted) as any,
      );

      const setCustomerBirthdates = vi.fn().mockResolvedValue({ written: 0, errors: [] });
      const getCustomers = vi.fn().mockResolvedValue({
        customers: [
          { id: 1, email: 'si@x.it', email_marketing_consent: { state: 'subscribed' }, date_of_birth: null },
        ],
        nextPageInfo: null,
      });
      vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
        getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
        getCustomers,
        setCustomerBirthdates,
      }) as any);

      await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

      // Letto si', dal campo che il merchant ha indicato...
      expect(getCustomers.mock.calls[0][0].birthdateMetafield).toEqual({
        namespace: 'custom',
        key: 'data_di_nascita',
      });
      // ...riscritto no: scrivere altrove da dove si legge ripeterebbe la
      // stessa mutation a ogni corsa.
      expect(setCustomerBirthdates).not.toHaveBeenCalled();
    });
  });

  it('registra il dettaglio dei prodotti: nuove varianti aggiunte, righe spazzate rimosse', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'pro',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
    };
    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: null, customersSyncEnabled: false } as any);
    vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'job-1' } as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);
    vi.mocked(prisma.shop.update).mockResolvedValue({} as any);

    vi.mocked(createSupabaseClient).mockReturnValue({
      from: () => ({
        // Prima della corsa c'era solo la variante 10.
        select: () => ({
          range: async () => ({ data: [{ shopify_variant_id: 10 }], error: null }),
        }),
        upsert: async () => ({ error: null }),
        delete: () => ({
          lt: () => ({
            // PostgREST restituisce le righe cancellate se si concatena .select().
            select: async () => ({
              data: [
                {
                  shopify_product_id: 9,
                  shopify_variant_id: 90,
                  product_title: 'Fuori catalogo',
                  variant_title: 'Taglia L',
                },
              ],
              error: null,
            }),
          }),
        }),
      }),
    } as any);

    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: vi.fn().mockResolvedValue({ products: [{ id: 1, variants_complete: true }], nextPageInfo: null }),
    }) as any);
    vi.mocked(transformProduct).mockReturnValue([
      { shopify_product_id: 1, shopify_variant_id: 10, product_title: 'Maglietta', variant_title: 'S', cost_per_item: 5, net_value: 5 },
      { shopify_product_id: 1, shopify_variant_id: 11, product_title: 'Maglietta', variant_title: 'M', cost_per_item: 5, net_value: 5 },
    ] as any);

    await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

    // La 10 c'era già: solo la 11 è un'aggiunta. La riga spazzata è una rimozione.
    const written = (vi.mocked(prisma.syncJobEvent.createMany).mock.calls[0][0] as any).data as any[];
    expect(written).toEqual([
      {
        syncJobId: 'job-1',
        entity: 'product',
        action: 'added',
        shopifyId: 1n,
        variantId: 11n,
        label: 'Maglietta',
        sublabel: 'M',
      },
      {
        syncJobId: 'job-1',
        entity: 'product',
        action: 'removed',
        shopifyId: 9n,
        variantId: 90n,
        label: 'Fuori catalogo',
        sublabel: 'Taglia L',
      },
    ]);

    // I contatori viaggiano con lo stesso update che marca il job completato.
    const completedCall = vi.mocked(prisma.syncJob.update).mock.calls.find(
      (call: any) => call[0].data?.status === 'completed',
    );
    expect(completedCall?.[0].data).toMatchObject({
      productsAdded: 1,
      productsRemoved: 1,
      customersAdded: 0,
    });

    // Il dettaglio delle corse non più raggiungibili dalla tab Logs viene potato.
    expect(prisma.syncJobEvent.deleteMany).toHaveBeenCalled();
  });

  it('conta i clienti aggiunti, aggiornati e sospesi senza scriverne il dettaglio', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'pro',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
    };
    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: null, customersSyncEnabled: true } as any);
    vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'job-1' } as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);
    vi.mocked(prisma.shop.update).mockResolvedValue({} as any);

    vi.mocked(createSupabaseClient).mockReturnValue({
      from: () => ({
        select: () => ({
          limit: async () => ({ data: [{ shopify_customer_id: 1 }], error: null }),
          range: async () => ({ data: [], error: null }),
          // Dei consenzienti (1 e 3) solo il primo era già sincronizzato.
          in: async () => ({ data: [{ shopify_customer_id: 1 }], error: null }),
        }),
        upsert: async () => ({ error: null }),
        update: () => ({
          in: () => ({
            // Dei due revocanti (2 e 4) solo il 2 aveva una riga da sospendere.
            select: async () => ({ data: [{ shopify_customer_id: 2 }], error: null }),
          }),
        }),
        delete: () => ({ lt: async () => ({ error: null }) }),
      }),
    } as any);

    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
      getCustomers: vi.fn().mockResolvedValue({
        customers: [
          { id: 1, first_name: 'Mario', last_name: 'Rossi', email_marketing_consent: { state: 'subscribed' } },
          { id: 3, first_name: 'Anna', last_name: null, email_marketing_consent: { state: 'subscribed' } },
          { id: 2, first_name: null, last_name: null, email_marketing_consent: { state: 'unsubscribed' } },
          { id: 4, first_name: 'Luca', last_name: 'Bianchi', email_marketing_consent: { state: 'unsubscribed' } },
        ],
        nextPageInfo: null,
      }),
    }) as any);

    await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

    // Nessuna riga di dettaglio: dei clienti restano solo i contatori. Sul
    // database dell'applicazione non deve finire chi sono, ne' per nome ne' per
    // identificativo Shopify.
    expect(prisma.syncJobEvent.createMany).not.toHaveBeenCalled();

    // I contatori invece sono quelli veri: il 4 ha revocato ma non era mai stato
    // sincronizzato, quindi non c'era nulla da sospendere.
    const completedCall = vi.mocked(prisma.syncJob.update).mock.calls.find(
      (call: any) => call[0].data?.status === 'completed',
    );
    expect(completedCall?.[0].data).toMatchObject({
      customersAdded: 1,
      customersUpdated: 1,
      customersSuspended: 1,
    });
  });

  it('una corsa fallita salva comunque il dettaglio raccolto fino all\'errore', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'pro',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
    };
    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: null, customersSyncEnabled: false } as any);
    vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'job-1' } as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);

    vi.mocked(createSupabaseClient).mockReturnValue({
      from: () => ({
        select: emptyProductsSelect,
        upsert: async () => ({ error: null }),
        delete: () => ({ lt: async () => ({ error: null }) }),
      }),
    } as any);

    // Prima pagina sincronizzata, seconda in errore.
    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: vi
        .fn()
        .mockResolvedValueOnce({ products: [{ id: 1 }], nextPageInfo: 'p2' })
        .mockRejectedValueOnce(new Error('Shopify API error')),
    }) as any);
    vi.mocked(transformProduct).mockReturnValue([
      { shopify_product_id: 1, shopify_variant_id: 10, product_title: 'Maglietta', variant_title: null, cost_per_item: 5, net_value: 5 },
    ] as any);

    await expect(
      processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any),
    ).rejects.toThrow('Shopify API error');

    expect(prisma.syncJobEvent.createMany).toHaveBeenCalled();
    const failedCall = vi.mocked(prisma.syncJob.update).mock.calls.find(
      (call: any) => call[0].data?.status === 'failed',
    );
    expect(failedCall?.[0].data).toMatchObject({ productsAdded: 1 });
  });

  it('se il dettaglio non si scrive la sync arriva comunque in fondo', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'pro',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        tableNameCustomers: 'customers',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'k',
        supabaseServiceRoleKey: 's',
      },
    };
    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: null, customersSyncEnabled: false } as any);
    vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'job-1' } as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);
    vi.mocked(prisma.shop.update).mockResolvedValue({} as any);
    vi.mocked(prisma.syncJobEvent.createMany).mockRejectedValueOnce(new Error('tabella dettaglio assente') as never);

    vi.mocked(createSupabaseClient).mockReturnValue({
      from: () => ({
        select: emptyProductsSelect,
        upsert: async () => ({ error: null }),
        delete: () => ({ lt: async () => ({ error: null }) }),
      }),
    } as any);
    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: vi.fn().mockResolvedValue({ products: [{ id: 1, variants_complete: true }], nextPageInfo: null }),
    }) as any);
    vi.mocked(transformProduct).mockReturnValue([
      { shopify_product_id: 1, shopify_variant_id: 10, product_title: 'Maglietta', variant_title: null, cost_per_item: 5, net_value: 5 },
    ] as any);

    await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

    // I totali storici restano quelli di sempre: il dettaglio è accessorio.
    const completedCall = vi.mocked(prisma.syncJob.update).mock.calls.find(
      (call: any) => call[0].data?.status === 'completed',
    );
    expect(completedCall).toBeDefined();
    const progressCall = vi.mocked(prisma.syncJob.update).mock.calls.find(
      (call: any) => call[0].data?.variantsSynced === 1,
    );
    expect(progressCall).toBeDefined();
  });
});
