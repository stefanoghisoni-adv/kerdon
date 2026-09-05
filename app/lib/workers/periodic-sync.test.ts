import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all dependencies BEFORE imports (using factory functions)
vi.mock('../../db.server', () => ({
  prisma: {
    shop: {
      findUnique: vi.fn(),
    },
    syncJob: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
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
    // Il registro delle riparazioni: la corsa lo legge all'inizio e lo riscrive
    // alla fine, nella stessa transazione del confine incrementale. Qui e'
    // vuoto e non oppone resistenza; cosa ci finisca dentro lo provano i test
    // dedicati (sync-repairs.test.ts).
    syncRepair: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
      groupBy: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    // La chiusura della corsa e' una transazione sola: o ci sono confine e
    // riparazioni, o non c'e' nessuno dei due.
    $transaction: vi.fn(async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : ops,
    ),
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

// enrichVariantCosts muta i prodotti in place leggendo il costo via API: nei test
// la mockiamo a passthrough, così non tenta chiamate agli InventoryItem.
vi.mock('../stats/inventory-cost.server', () => ({
  enrichVariantCosts: vi.fn(async (_client: unknown, products: unknown) => products),
}));

// La tabella clienti viene garantita prima di sincronizzarla: qui interessa
// solo COSA fa il processor a seconda dell'esito, non come la tabella nasce.
vi.mock('../supabase/ensure-customers-table.server', () => ({
  ensureCustomersTable: vi.fn(async () => ({ status: 'already_present', empty: false })),
}));

// Idem per la tabella prodotti (test propri in ensure-products-table.test.ts).
vi.mock('../supabase/ensure-products-table.server', () => ({
  ensureProductsTable: vi.fn(async () => ({ status: 'already_present', empty: false })),
}));

// Import after mocks
import { processPeriodicSyncCheck } from './processors.server';
import { ShopifyAPIClient } from '../shopify-api.server';
import { createSupabaseClient } from '../supabase.server';
import { transformProduct } from '../transformers/product.server';
import { prisma } from '../../db.server';
import { ensureCustomersTable } from '../supabase/ensure-customers-table.server';

// I processor non ricompongono piu' le condizioni sul posto: chiedono alla
// policy se quel negozio puo' sincronizzare. Da qui i due campi in piu' su ogni
// negozio finto — installato e autorizzato — che prima si davano per scontati
// perche' nessuno li guardava.
describe('Periodic sync check processor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should sync only updated products with delta detection and orphaned variant deletion', async () => {
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
        updatedAt: new Date('2026-07-10T00:00:00Z'),
      },
    };

    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);

    // Il confine che la corsa precedente si e' guadagnata: l'istante in cui era
    // partita, scritto in una colonna sua e solo perche' quella corsa aveva
    // davvero scritto tutto.
    const confinePrecedente = new Date('2026-07-12T12:00:00Z');
    vi.mocked(prisma.syncJob.findFirst).mockResolvedValue({
      watermarkAt: confinePrecedente,
    } as any);
    // Meno la sovrapposizione: scarto fra gli orologi e fessura sul confine.
    const lastSyncTime = new Date(confinePrecedente.getTime() - 120_000);

    // Mock SyncJob create
    const mockSyncJob = { id: 'sync-job-1' };
    vi.mocked(prisma.syncJob.create).mockResolvedValue(mockSyncJob as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);

    // Mock Shopify API client - only updated products since lastSyncTime
    // `variants_complete: true` e' la promessa che il client GraphQL fa dopo aver
    // esaurito la connessione annidata: senza, il processor si rifiuta di
    // cancellare per differenza (vedi variant-reconciliation.test.ts).
    const mockUpdatedProducts = [
      // Product 1: has 2 variants currently
      { id: 1, title: 'Product 1', variants_complete: true, variants: [{ id: 101, title: 'Variant 1' }, { id: 102, title: 'Variant 2' }] },
    ];

    const mockGetProducts = vi.fn().mockResolvedValueOnce({
      products: mockUpdatedProducts,
      nextPageInfo: null,
    });

    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: mockGetProducts,
    } as any));

    // Mock transformProduct - Product 1 now has 2 variants
    vi.mocked(transformProduct).mockReturnValueOnce([
      { shopify_product_id: 1, shopify_variant_id: 101, is_variant: true, title: 'Product 1 - Variant 1' } as any,
      { shopify_product_id: 1, shopify_variant_id: 102, is_variant: true, title: 'Product 1 - Variant 2' } as any,
    ]);

    // Mock Supabase client
    // Existing rows in DB: Product 1 has 3 variants (101, 102, 103)
    // Variant 103 is orphaned (deleted in Shopify)
    const mockSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({
        data: [
          { shopify_variant_id: 101 },
          { shopify_variant_id: 102 },
          { shopify_variant_id: 103 }, // This one will be orphaned
        ],
      }),
    });

    const mockDeleteIn = vi.fn().mockResolvedValue({ error: null });
    const mockDeleteEq = vi.fn().mockReturnValue({
      in: mockDeleteIn,
      is: vi.fn().mockResolvedValue({ error: null }),
      not: vi.fn().mockResolvedValue({ error: null }),
    });
    const mockDelete = vi.fn().mockReturnValue({
      eq: mockDeleteEq,
      in: mockDeleteIn,
      is: vi.fn().mockResolvedValue({ error: null }),
      not: vi.fn().mockResolvedValue({ error: null }),
    });

    const mockUpsert = vi.fn().mockResolvedValue({ error: null });

    const mockFrom = vi.fn().mockImplementation((tableName) => ({
      select: mockSelect,
      delete: mockDelete,
      upsert: mockUpsert,
    }));

    vi.mocked(createSupabaseClient).mockReturnValue({
      from: mockFrom,
    } as any);

    // Execute periodic sync
    await processPeriodicSyncCheck('shop-1');

    // Verify shop was loaded with config
    expect(prisma.shop.findUnique).toHaveBeenCalledWith({
      where: { id: 'shop-1' },
      include: { supabaseConfig: true },
    });

    // Il confine si cerca per COLONNA, non per stato.
    //
    // Prima si cercava l'ultima corsa `completed` e se ne prendeva `startedAt`.
    // Ma `completed` lo diventava anche una corsa che aveva ignorato una
    // manciata di errori: il confine passava sopra le risorse che nessuno era
    // riuscito a scrivere, e quelle — se su Shopify non le toccava piu'
    // nessuno — non venivano rilette mai piu'.
    expect(prisma.syncJob.findFirst).toHaveBeenCalledWith({
      where: {
        shopId: 'shop-1',
        jobType: { in: ['periodic_check', 'initial_bulk'] },
        watermarkAt: { not: null },
      },
      orderBy: { watermarkAt: 'desc' },
      select: { watermarkAt: true },
    });

    // Verify SyncJob was created as 'running'
    expect(prisma.syncJob.create).toHaveBeenCalledWith({
      data: {
        shopId: 'shop-1',
        jobType: 'periodic_check',
        status: 'running',
        // L'istante d'inizio si scrive, non si lascia al default: e' lo stesso
        // che diventera' il confine di questa corsa, e due istanti diversi
        // lascerebbero fuori quel che e' cambiato fra l'uno e l'altro.
        startedAt: expect.any(Date),
      },
    });

    // Il difetto che questa correzione chiude, in una riga.
    //
    // La corsa precedente e' andata dalle 12:00 alle 12:05. Un prodotto
    // modificato alle 12:02 — dopo che la sua pagina era gia' stata letta, ma
    // prima della fine — aveva un `updated_at` anteriore alle 12:05: con il
    // vecchio confine nessuna corsa successiva lo avrebbe mai piu' chiesto.
    // Ripartendo dall'inizio, ci ricade dentro.
    const modificaAMetaCorsa = new Date('2026-07-12T12:02:00Z');
    expect(new Date(mockGetProducts.mock.calls[0][0].updatedAtMin).getTime()).toBeLessThan(
      modificaAMetaCorsa.getTime(),
    );

    // Verify getProducts was called with updatedAtMin (delta)
    expect(mockGetProducts).toHaveBeenCalledWith({
      limit: 250,
      pageInfo: undefined,
      updatedAtMin: lastSyncTime.toISOString(),
    });

    // Verify existing rows were fetched for delta detection
    expect(mockSelect).toHaveBeenCalled();

    // Verify orphaned variant (103) was deleted with product scoping
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeleteEq).toHaveBeenCalledWith('shopify_product_id', 1);
    expect(mockDeleteIn).toHaveBeenCalledWith('shopify_variant_id', [103]);

    // Verify SEPARATED upserts for variant rows
    expect(mockUpsert).toHaveBeenCalled();

    // Verify at least one upsert with 'shopify_variant_id' conflict (variant rows)
    const variantUpsertCalls = vi.mocked(mockUpsert).mock.calls.filter(
      call => call[1]?.onConflict === 'shopify_variant_id'
    );
    expect(variantUpsertCalls.length).toBeGreaterThan(0);

    // Verify SyncJob was marked as completed
    const completedCall = vi.mocked(prisma.syncJob.update).mock.calls.find(
      (call: any) => call[0].data?.status === 'completed'
    );
    expect(completedCall).toBeDefined();
    expect(completedCall?.[0].data).toMatchObject({
      status: 'completed',
      completedAt: expect.any(Date),
      productsSynced: 1,
      variantsSynced: 2,
    });
  });

  it('should use supabaseConfig.updatedAt as fallback when no last sync job exists', async () => {
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
        updatedAt: new Date('2026-07-01T00:00:00Z'),
      },
    };

    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);

    // No last sync job found
    vi.mocked(prisma.syncJob.findFirst).mockResolvedValue(null);

    const mockSyncJob = { id: 'sync-job-2' };
    vi.mocked(prisma.syncJob.create).mockResolvedValue(mockSyncJob as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);

    const mockGetProducts = vi.fn().mockResolvedValueOnce({
      products: [],
      nextPageInfo: null,
    });

    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: mockGetProducts,
    } as any));

    vi.mocked(createSupabaseClient).mockReturnValue({
      from: vi.fn(),
    } as any);

    await processPeriodicSyncCheck('shop-2');

    // Verify getProducts was called with supabaseConfig.updatedAt as fallback
    expect(mockGetProducts).toHaveBeenCalledWith({
      limit: 250,
      pageInfo: undefined,
      updatedAtMin: mockShop.supabaseConfig.updatedAt.toISOString(),
    });
  });

  it('should handle errors and mark job as failed', async () => {
    const mockShop = {
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
        updatedAt: new Date('2026-07-10T00:00:00Z'),
      },
    };

    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);
    vi.mocked(prisma.syncJob.findFirst).mockResolvedValue(null);

    const mockSyncJob = { id: 'sync-job-3' };
    vi.mocked(prisma.syncJob.create).mockResolvedValue(mockSyncJob as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);

    // Mock Shopify API to throw error
    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: vi.fn().mockRejectedValue(new Error('Shopify API error')),
    } as any));

    // Expect the sync to throw
    await expect(processPeriodicSyncCheck('shop-3')).rejects.toThrow('Shopify API error');

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

  it('should skip sync if shop not configured or sync disabled', async () => {
    const mockShop = {
      id: 'shop-4',
      shopDomain: 'test-shop.myshopify.com',
      uninstalledAt: null,
      authorization: 'ENABLED',
      accessToken: 'encrypted-token',
      supabaseConfig: {
        connectionVerifiedAt: null, // progetto non ancora verificato
        tableNameProducts: 'products',
        supabaseUrl: 'https://test.supabase.co',
        supabasePublicKey: 'encrypted-key',
        supabaseServiceRoleKey: 'encrypted-service',
        updatedAt: new Date('2026-07-10T00:00:00Z'),
      },
    };

    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);

    await processPeriodicSyncCheck('shop-4');

    // Verify no sync job was created
    expect(prisma.syncJob.create).not.toHaveBeenCalled();
  });

  it('should handle single→multi variant transition by deleting old non-variant row', async () => {
    const mockShop = {
      id: 'shop-6',
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
        updatedAt: new Date('2026-07-10T00:00:00Z'),
      },
    };

    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);
    vi.mocked(prisma.syncJob.findFirst).mockResolvedValue(null);

    const mockSyncJob = { id: 'sync-job-6' };
    vi.mocked(prisma.syncJob.create).mockResolvedValue(mockSyncJob as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);

    // Product that transitioned from single (non-variant) to multi-variant
    const mockProduct = {
      id: 100,
      title: 'Product 100',
      variants: [
        { id: 1001, title: 'Variant 1' },
        { id: 1002, title: 'Variant 2' },
      ],
    };

    const mockGetProducts = vi.fn().mockResolvedValueOnce({
      products: [mockProduct],
      nextPageInfo: null,
    });

    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: mockGetProducts,
    } as any));

    // Transform returns 2 variant rows (current state)
    vi.mocked(transformProduct).mockReturnValueOnce([
      { shopify_product_id: 100, shopify_variant_id: 1001, is_variant: true, title: 'Product 100 - Variant 1' } as any,
      { shopify_product_id: 100, shopify_variant_id: 1002, is_variant: true, title: 'Product 100 - Variant 2' } as any,
    ]);

    // Existing rows in DB: Product 100 previously had a non-variant row (shopify_variant_id = null)
    // This row has shopify_variant_id = null, so it's filtered out by .filter(Boolean)
    const mockSelect = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({
        data: [
          { shopify_variant_id: null }, // Old non-variant row (single-variant product)
        ],
      }),
    });

    const mockDeleteNot = vi.fn().mockResolvedValue({ error: null });
    const mockDeleteIs = vi.fn().mockResolvedValue({ error: null });
    const mockDeleteIn = vi.fn().mockResolvedValue({ error: null });
    const mockDeleteEq = vi.fn().mockReturnValue({
      not: mockDeleteNot,
      is: mockDeleteIs,
      in: mockDeleteIn,
    });
    const mockDelete = vi.fn().mockReturnValue({
      eq: mockDeleteEq,
      not: mockDeleteNot,
      is: mockDeleteIs,
    });

    const mockUpsert = vi.fn().mockResolvedValue({ error: null });

    const mockFrom = vi.fn().mockImplementation((tableName) => ({
      select: mockSelect,
      delete: mockDelete,
      upsert: mockUpsert,
    }));

    vi.mocked(createSupabaseClient).mockReturnValue({
      from: mockFrom,
    } as any);

    await processPeriodicSyncCheck('shop-6');

    // Verify old non-variant (NULL) row was deleted (single→multi transition cleanup).
    // Multi-variant products must delete the stale shopify_variant_id IS NULL row,
    // NOT the freshly-upserted variant rows.
    expect(mockDelete).toHaveBeenCalled();
    expect(mockDeleteEq).toHaveBeenCalledWith('shopify_product_id', 100);
    expect(mockDeleteIs).toHaveBeenCalledWith('shopify_variant_id', null);
    // Must NOT delete non-null variant rows in a multi-variant product transition
    expect(mockDeleteNot).not.toHaveBeenCalledWith('shopify_variant_id', 'is', null);
  });

  it('should handle pagination correctly', async () => {
    const mockShop = {
      id: 'shop-5',
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
        updatedAt: new Date('2026-07-10T00:00:00Z'),
      },
    };

    vi.mocked(prisma.shop.findUnique).mockResolvedValue(mockShop as any);
    vi.mocked(prisma.syncJob.findFirst).mockResolvedValue(null);

    const mockSyncJob = { id: 'sync-job-5' };
    vi.mocked(prisma.syncJob.create).mockResolvedValue(mockSyncJob as any);
    vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);

    // Mock pagination: 2 pages
    let callCount = 0;
    const mockGetProducts = vi.fn().mockImplementation(async (options) => {
      callCount++;
      if (callCount === 1) {
        return {
          products: [{ id: 1, title: 'Product 1', variants: [{ id: 101, title: 'V1' }] }],
          nextPageInfo: 'page-2-token',
        };
      }
      if (callCount === 2) {
        return {
          products: [{ id: 2, title: 'Product 2', variants: [{ id: 201, title: 'V2' }] }],
          nextPageInfo: null,
        };
      }
      return { products: [], nextPageInfo: null };
    });

    vi.mocked(ShopifyAPIClient).mockImplementation(() => ({
      getProducts: mockGetProducts,
    } as any));

    vi.mocked(transformProduct)
      .mockReturnValueOnce([{ shopify_product_id: 1, shopify_variant_id: 101, is_variant: true } as any])
      .mockReturnValueOnce([{ shopify_product_id: 2, shopify_variant_id: 201, is_variant: true } as any]);

    const mockFrom = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: [] }),
      }),
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          not: vi.fn().mockResolvedValue({ error: null }),
          is: vi.fn().mockResolvedValue({ error: null }),
          in: vi.fn().mockResolvedValue({ error: null }),
        }),
      }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    });

    vi.mocked(createSupabaseClient).mockReturnValue({
      from: mockFrom,
    } as any);

    await processPeriodicSyncCheck('shop-5');

    // Verify pagination: getProducts called twice
    expect(mockGetProducts).toHaveBeenCalledTimes(2);

    // Second call should use nextPageInfo
    expect(mockGetProducts).toHaveBeenNthCalledWith(2, {
      limit: 250,
      pageInfo: 'page-2-token',
      updatedAtMin: expect.any(String),
    });

    // Verify 2 products were synced
    const completedCall = vi.mocked(prisma.syncJob.update).mock.calls.find(
      (call: any) => call[0].data?.status === 'completed'
    );
    expect(completedCall?.[0].data).toMatchObject({
      productsSynced: 2,
      variantsSynced: 2,
    });
  });

  it('cancella la variante che perde il costo e upserta solo le idonee', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'free',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        updatedAt: new Date('2026-07-01T00:00:00Z'),
      },
    };
    (prisma.shop.findUnique as any).mockResolvedValue(mockShop);
    (prisma.plan.findFirst as any).mockResolvedValue({ maxProducts: null, customersSyncEnabled: false });
    (prisma.syncJob.findFirst as any).mockResolvedValue(null);
    (prisma.syncJob.create as any).mockResolvedValue({ id: 'job-1' });
    (prisma.syncJob.update as any).mockResolvedValue({});

    const deletedInIds: any[] = [];
    const upserted: any[] = [];
    const supabaseMock = {
      from: () => ({
        // riga esistente: variante 11 (che ora perde il costo)
        select: () => ({ eq: async () => ({ data: [{ shopify_variant_id: 11 }] }) }),
        delete: () => ({
          eq: () => ({
            in: async (_col: string, ids: any[]) => { deletedInIds.push(...ids); return { error: null }; },
            is: async () => ({ error: null }),
          }),
        }),
        upsert: async (rows: any[]) => { upserted.push(...rows); return { error: null }; },
      }),
    };
    (createSupabaseClient as any).mockReturnValue(supabaseMock);
    (ShopifyAPIClient as any).mockImplementation(() => ({
      getProducts: vi
        .fn()
        .mockResolvedValueOnce({ products: [{ id: 1, variants_complete: true }], nextPageInfo: null })
        .mockResolvedValue({ products: [], nextPageInfo: null }),
    }));
    // Il prodotto ora ha variante 11 senza costo e 12 con costo.
    (transformProduct as any).mockReturnValue([
      { shopify_product_id: 1, shopify_variant_id: 11, cost_per_item: null },
      { shopify_product_id: 1, shopify_variant_id: 12, cost_per_item: 8 },
    ]);

    await processPeriodicSyncCheck('shop-1');

    // La 11 (persa idoneità) viene cancellata come orfana; solo la 12 è upsertata.
    expect(deletedInIds).toContain(11);
    expect(upserted.map((r) => r.shopify_variant_id)).toEqual([12]);
  });

  // Scenario del passaggio a un piano che include i clienti: al collegamento la
  // tabella non era prevista, quindi qui nasce ora.
  function mockShopWithCustomers() {
    (prisma.shop.findUnique as any).mockResolvedValue({
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
        supabaseServiceRoleKey: 'encrypted-service',
        supabaseProjectRef: 'abcdefghijklmnopqrst',
        updatedAt: new Date('2026-07-01T00:00:00Z'),
      },
    });
    (prisma.plan.findFirst as any).mockResolvedValue({
      maxProducts: null,
      customersSyncEnabled: true,
    });
    // Il confine lasciato dalla corsa precedente: e' questo che si legge
    // adesso, non il suo `startedAt`.
    (prisma.syncJob.findFirst as any).mockResolvedValue({
      watermarkAt: new Date('2026-07-20T00:00:00Z'),
    });
    (prisma.syncJob.create as any).mockResolvedValue({ id: 'job-1' });
    (prisma.syncJob.update as any).mockResolvedValue({});
    (createSupabaseClient as any).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: async () => ({ data: [] }),
          limit: () => ({ error: null }),
          // Chi c'era già fra i clienti della pagina: serve solo al dettaglio.
          in: async () => ({ data: [], error: null }),
        }),
        upsert: async () => ({ error: null }),
        update: () => ({ in: async () => ({ error: null }) }),
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }), is: async () => ({ error: null }) }) }),
      }),
    });
  }

  it('tabella clienti appena creata → recupera TUTTI i clienti, non il delta', async () => {
    mockShopWithCustomers();
    (ensureCustomersTable as any).mockResolvedValue({ status: 'created', empty: true });

    const getCustomers = vi.fn().mockResolvedValue({ customers: [], nextPageInfo: null });
    (ShopifyAPIClient as any).mockImplementation(() => ({
      getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
      getCustomers,
    }));

    await processPeriodicSyncCheck('shop-1');

    // Senza updatedAtMin: su una tabella vuota il delta lascerebbe fuori tutto
    // lo storico dei clienti.
    expect(getCustomers).toHaveBeenCalled();
    expect(getCustomers.mock.calls[0][0].updatedAtMin).toBeUndefined();
  });

  it('tabella clienti gia\' presente → sync incrementale', async () => {
    mockShopWithCustomers();
    (ensureCustomersTable as any).mockResolvedValue({ status: 'already_present', empty: false });

    const getCustomers = vi.fn().mockResolvedValue({ customers: [], nextPageInfo: null });
    (ShopifyAPIClient as any).mockImplementation(() => ({
      getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
      getCustomers,
    }));

    await processPeriodicSyncCheck('shop-1');

    // Si riparte dal confine della corsa precedente meno la sovrapposizione:
    // due minuti che coprono insieme lo scarto fra i due orologi e il confine
    // stesso, dove una modifica avvenuta nell'istante esatto della lettura non
    // starebbe ne' di qua ne' di la'.
    expect(getCustomers.mock.calls[0][0].updatedAtMin).toBe('2026-07-19T23:58:00.000Z');
  });

  it('tabella clienti non disponibile → clienti saltati, prodotti comunque completati', async () => {
    mockShopWithCustomers();
    (ensureCustomersTable as any).mockResolvedValue({ status: 'unavailable', empty: false });

    const getCustomers = vi.fn().mockResolvedValue({ customers: [], nextPageInfo: null });
    (ShopifyAPIClient as any).mockImplementation(() => ({
      getProducts: vi.fn().mockResolvedValue({ products: [], nextPageInfo: null }),
      getCustomers,
    }));

    await processPeriodicSyncCheck('shop-1');

    // Nessuna chiamata ai clienti, e la corsa NON fallisce: i prodotti sono
    // sincronizzati comunque.
    expect(getCustomers).not.toHaveBeenCalled();
    expect(prisma.syncJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed', customersSynced: 0 }),
      }),
    );
  });

  it('registra il dettaglio: varianti nuove aggiunte, orfane rimosse', async () => {
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'free',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        updatedAt: new Date('2026-07-01T00:00:00Z'),
      },
    };
    (prisma.shop.findUnique as any).mockResolvedValue(mockShop);
    (prisma.plan.findFirst as any).mockResolvedValue({ maxProducts: null, customersSyncEnabled: false });
    (prisma.syncJob.findFirst as any).mockResolvedValue(null);
    (prisma.syncJob.create as any).mockResolvedValue({ id: 'job-1' });
    (prisma.syncJob.update as any).mockResolvedValue({});

    (createSupabaseClient as any).mockReturnValue({
      from: () => ({
        // Prima della corsa il prodotto aveva le varianti 11 e 99.
        select: () => ({ eq: async () => ({ data: [{ shopify_variant_id: 11 }, { shopify_variant_id: 99 }] }) }),
        delete: () => ({
          eq: () => ({
            // PostgREST restituisce le righe cancellate se si concatena .select().
            in: () => ({
              select: async () => ({
                data: [
                  {
                    shopify_product_id: 1,
                    shopify_variant_id: 99,
                    product_title: 'Maglietta',
                    variant_title: 'XL',
                  },
                ],
                error: null,
              }),
            }),
            is: async () => ({ error: null }),
          }),
        }),
        upsert: async () => ({ error: null }),
      }),
    });
    (ShopifyAPIClient as any).mockImplementation(() => ({
      getProducts: vi
        .fn()
        .mockResolvedValueOnce({ products: [{ id: 1, variants_complete: true }], nextPageInfo: null })
        .mockResolvedValue({ products: [], nextPageInfo: null }),
    }));
    // Ora il prodotto ha la 11 (già presente) e la 12 (nuova).
    (transformProduct as any).mockReturnValue([
      { shopify_product_id: 1, shopify_variant_id: 11, product_title: 'Maglietta', variant_title: 'S', cost_per_item: 5, net_value: 5 },
      { shopify_product_id: 1, shopify_variant_id: 12, product_title: 'Maglietta', variant_title: 'M', cost_per_item: 5, net_value: 5 },
    ]);

    await processPeriodicSyncCheck('shop-1');

    const written = (prisma.syncJobEvent.createMany as any).mock.calls[0][0].data;
    expect(written).toEqual([
      {
        syncJobId: 'job-1',
        entity: 'product',
        action: 'removed',
        shopifyId: 1n,
        variantId: 99n,
        label: 'Maglietta',
        sublabel: 'XL',
      },
      {
        syncJobId: 'job-1',
        entity: 'product',
        action: 'added',
        shopifyId: 1n,
        variantId: 12n,
        label: 'Maglietta',
        sublabel: 'M',
      },
    ]);

    const completedCall = (prisma.syncJob.update as any).mock.calls.find(
      (call: any) => call[0].data?.status === 'completed',
    );
    expect(completedCall?.[0].data).toMatchObject({
      productsAdded: 1,
      productsRemoved: 1,
    });
  });

  it('senza .select() concatenato alle delete il dettaglio resta vuoto ma la sync passa', async () => {
    // Client che non regge la concatenazione (o versioni più vecchie): la
    // cancellazione avviene comunque, semplicemente non si sa cosa è sparito.
    const mockShop = {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      accessToken: 'encrypted-token',
      authorization: 'ENABLED',
      currentPlan: 'free',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameProducts: 'products',
        updatedAt: new Date('2026-07-01T00:00:00Z'),
      },
    };
    (prisma.shop.findUnique as any).mockResolvedValue(mockShop);
    (prisma.plan.findFirst as any).mockResolvedValue({ maxProducts: null, customersSyncEnabled: false });
    (prisma.syncJob.findFirst as any).mockResolvedValue(null);
    (prisma.syncJob.create as any).mockResolvedValue({ id: 'job-1' });
    (prisma.syncJob.update as any).mockResolvedValue({});

    const deletedIds: any[] = [];
    (createSupabaseClient as any).mockReturnValue({
      from: () => ({
        select: () => ({ eq: async () => ({ data: [{ shopify_variant_id: 99 }] }) }),
        delete: () => ({
          eq: () => ({
            in: async (_col: string, ids: any[]) => { deletedIds.push(...ids); return { error: null }; },
            is: async () => ({ error: null }),
          }),
        }),
        upsert: async () => ({ error: null }),
      }),
    });
    (ShopifyAPIClient as any).mockImplementation(() => ({
      getProducts: vi
        .fn()
        .mockResolvedValueOnce({ products: [{ id: 1, variants_complete: true }], nextPageInfo: null })
        .mockResolvedValue({ products: [], nextPageInfo: null }),
    }));
    (transformProduct as any).mockReturnValue([
      { shopify_product_id: 1, shopify_variant_id: 12, product_title: 'Maglietta', variant_title: 'M', cost_per_item: 5, net_value: 5 },
    ]);

    await processPeriodicSyncCheck('shop-1');

    // La cancellazione è avvenuta come prima...
    expect(deletedIds).toEqual([99]);
    // ...ma delle rimozioni non si sa nulla: si conta zero e si prosegue.
    const completedCall = (prisma.syncJob.update as any).mock.calls.find(
      (call: any) => call[0].data?.status === 'completed',
    );
    expect(completedCall?.[0].data).toMatchObject({
      productsAdded: 1,
      productsRemoved: 0,
      variantsSynced: 1,
    });
  });
});
