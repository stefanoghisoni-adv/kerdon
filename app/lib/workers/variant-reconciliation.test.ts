import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * La regola che questo file difende: non si cancella per differenza da un elenco
 * di cui non si sa se e' completo.
 *
 * Il guasto che c'era prima era invisibile a occhio: `variants(first: 100)`
 * restituisce cento varianti sia quando il prodotto ne ha cento sia quando ne ha
 * centocinquanta, e la sincronizzazione cancellava dal database del merchant le
 * cinquanta che non aveva chiesto — a ogni corsa, per sempre, senza un errore.
 * Il client GraphQL ora esaurisce la connessione e dichiara l'esito in
 * `variants_complete`; qui si verifica che sia davvero quel bit, e non altro, a
 * decidere se una cancellazione puo' avvenire.
 */

vi.mock('../../db.server', () => ({
  prisma: {
    shop: { findUnique: vi.fn(), update: vi.fn() },
    syncJob: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
    },
    syncJobEvent: {
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    plan: { findFirst: vi.fn() },
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

vi.mock('../shopify-api.server', () => {
  const ctor = vi.fn();
  return {
    ShopifyAPIClient: Object.assign(ctor, {
      forShop: vi.fn(async (shop: string) => new (ctor as any)(shop)),
    }),
  };
});

vi.mock('../supabase.server', () => ({ createSupabaseClient: vi.fn() }));
vi.mock('../transformers/product.server', () => ({ transformProduct: vi.fn() }));
vi.mock('../stats/inventory-cost.server', () => ({
  enrichVariantCosts: vi.fn(async (_client: unknown, products: unknown) => products),
}));
vi.mock('../supabase/ensure-products-table.server', () => ({
  ensureProductsTable: vi.fn(async () => ({ status: 'already_present', empty: false })),
}));
vi.mock('../supabase/ensure-customers-table.server', () => ({
  ensureCustomersTable: vi.fn(async () => ({ status: 'already_present', empty: false })),
}));

import { processPeriodicSyncCheck, processInitialBulkSync } from './processors.server';
import { ShopifyAPIClient } from '../shopify-api.server';
import { createSupabaseClient } from '../supabase.server';
import { transformProduct } from '../transformers/product.server';
import { prisma } from '../../db.server';

const shopConfig = {
  connectionVerifiedAt: new Date(),
  tableNameProducts: 'products',
  tableNameCustomers: 'customers',
  supabaseUrl: 'https://test.supabase.co',
  supabasePublicKey: 'k',
  supabaseServiceRoleKey: 's',
  updatedAt: new Date('2026-07-10T00:00:00Z'),
};

function mockShop(id = 'shop-1') {
  vi.mocked(prisma.shop.findUnique).mockResolvedValue({
    id,
    shopDomain: 'test-shop.myshopify.com',
    accessToken: 'enc',
    authorization: 'ENABLED',
    currentPlan: 'pro',
    supabaseConfig: shopConfig,
  } as any);
  vi.mocked(prisma.syncJob.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'job-1' } as any);
  vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);
  vi.mocked(prisma.shop.update).mockResolvedValue({} as any);
  vi.mocked(prisma.plan.findFirst).mockResolvedValue({
    maxProducts: null,
    customersSyncEnabled: false,
  } as any);
}

/** Varianti finte come le restituirebbe il client, gia' con il costo. */
function variants(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: from + i, title: `V${from + i}` }));
}

function rowsFor(productId: number, ids: number[]) {
  return ids.map((id) => ({
    shopify_product_id: productId,
    shopify_variant_id: id,
    product_title: 'Maglietta',
    variant_title: `V${id}`,
    cost_per_item: 5,
    net_value: 5,
  }));
}

/**
 * Doppione del client Supabase per la sync incrementale: registra ogni riga
 * scritta e ogni cancellazione tentata, e finge che nella tabella ci siano gia'
 * le varianti di `existing`.
 */
function periodicSupabase(existing: (number | null)[]) {
  const upserted: any[][] = [];
  const deletedVariantIds: number[][] = [];
  let nullRowsDeleted = 0;

  vi.mocked(createSupabaseClient).mockReturnValue({
    from: () => ({
      select: () => ({
        eq: async () => ({
          data: existing.map((id) => ({ shopify_variant_id: id })),
          error: null,
        }),
        range: async () => ({ data: [], error: null }),
      }),
      upsert: async (rows: any[]) => {
        upserted.push(rows);
        return { error: null };
      },
      delete: () => ({
        eq: () => ({
          in: async (_col: string, ids: number[]) => {
            deletedVariantIds.push(ids);
            return { error: null };
          },
          is: async () => {
            nullRowsDeleted++;
            return { error: null };
          },
        }),
      }),
    }),
  } as any);

  return {
    upserted,
    deletedVariantIds,
    get nullRowsDeleted() {
      return nullRowsDeleted;
    },
  };
}

function mockGetProducts(pages: { products: unknown[]; nextPageInfo: string | null }[]) {
  const fn = vi.fn();
  for (const page of pages) fn.mockResolvedValueOnce(page);
  fn.mockResolvedValue({ products: [], nextPageInfo: null });
  vi.mocked(ShopifyAPIClient).mockImplementation(() => ({ getProducts: fn }) as any);
  return fn;
}

describe('Riconciliazione delle varianti — sync incrementale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('101 varianti: si scrivono tutte e non si cancella niente', async () => {
    mockShop();
    const all = variants(1, 101);
    mockGetProducts([
      {
        products: [{ id: 1, title: 'Maglietta', variants_complete: true, variants: all }],
        nextPageInfo: null,
      },
    ]);
    // Nel database ci sono gia' le prime cento: la centunesima e' l'aggiunta.
    const db = periodicSupabase(all.slice(0, 100).map((v) => v.id));
    vi.mocked(transformProduct).mockReturnValue(
      rowsFor(1, all.map((v) => v.id)) as any,
    );

    await processPeriodicSyncCheck('shop-1');

    expect(db.upserted[0]).toHaveLength(101);
    // Il punto dell'intero fix: la centunesima non manda in cancellazione le
    // altre, e nessuna riga viene tolta.
    expect(db.deletedVariantIds).toEqual([]);
  });

  it('elenco incompleto: si aggiorna quel che si e letto, non si cancella nulla', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockShop();
    // La paginazione si e' rotta alla seconda pagina: cento varianti su
    // centocinquanta, e il client lo dichiara.
    mockGetProducts([
      {
        products: [
          { id: 1, title: 'Maglietta', variants_complete: false, variants: variants(1, 100) },
        ],
        nextPageInfo: null,
      },
    ]);
    const db = periodicSupabase(Array.from({ length: 150 }, (_, i) => i + 1));
    vi.mocked(transformProduct).mockReturnValue(
      rowsFor(1, Array.from({ length: 100 }, (_, i) => i + 1)) as any,
    );

    await processPeriodicSyncCheck('shop-1');

    // Le cinquanta che non abbiamo visto sono vive e restano dove sono.
    expect(db.deletedVariantIds).toEqual([]);
    // L'aggiornamento delle altre avviene lo stesso.
    expect(db.upserted[0]).toHaveLength(100);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Elenco varianti incompleto'));
    warn.mockRestore();
  });

  it('elenco incompleto e nessuna riga idonea: il prodotto non viene svuotato', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockShop();
    mockGetProducts([
      {
        products: [
          { id: 1, title: 'Maglietta', variants_complete: false, variants: variants(1, 100) },
        ],
        nextPageInfo: null,
      },
    ]);
    const db = periodicSupabase([1, 2, 3]);
    // Nella parte letta nessuna variante ha il costo.
    vi.mocked(transformProduct).mockReturnValue([] as any);

    await processPeriodicSyncCheck('shop-1');

    expect(db.deletedVariantIds).toEqual([]);
    expect(db.upserted).toEqual([]);
    warn.mockRestore();
  });

  it('variante davvero rimossa da Shopify: cancellata, e una volta sola', async () => {
    mockShop();
    // Prima corsa: la 103 c'e' ancora nel database ma non arriva piu' da Shopify.
    mockGetProducts([
      {
        products: [
          { id: 1, title: 'Maglietta', variants_complete: true, variants: variants(101, 2) },
        ],
        nextPageInfo: null,
      },
    ]);
    const first = periodicSupabase([101, 102, 103]);
    vi.mocked(transformProduct).mockReturnValue(rowsFor(1, [101, 102]) as any);

    await processPeriodicSyncCheck('shop-1');

    expect(first.deletedVariantIds).toEqual([[103]]);

    // Seconda corsa, stesso prodotto: la 103 non c'e' piu' nemmeno nel database,
    // quindi non c'e' piu' niente da cancellare. La delete non si ripete.
    vi.clearAllMocks();
    mockShop();
    mockGetProducts([
      {
        products: [
          { id: 1, title: 'Maglietta', variants_complete: true, variants: variants(101, 2) },
        ],
        nextPageInfo: null,
      },
    ]);
    const second = periodicSupabase([101, 102]);
    vi.mocked(transformProduct).mockReturnValue(rowsFor(1, [101, 102]) as any);

    await processPeriodicSyncCheck('shop-1');

    expect(second.deletedVariantIds).toEqual([]);
  });

  it('sincronizzare due volte lo stesso prodotto non cambia il risultato', async () => {
    const run = async () => {
      vi.clearAllMocks();
      mockShop();
      const all = variants(1, 120);
      mockGetProducts([
        {
          products: [{ id: 1, title: 'Maglietta', variants_complete: true, variants: all }],
          nextPageInfo: null,
        },
      ]);
      // Alla seconda corsa il database contiene gia' esattamente cio' che la
      // prima ha scritto: e' la condizione in cui l'idempotenza si vede.
      const db = periodicSupabase(all.map((v) => v.id));
      vi.mocked(transformProduct).mockReturnValue(rowsFor(1, all.map((v) => v.id)) as any);

      await processPeriodicSyncCheck('shop-1');
      return db;
    };

    const first = await run();
    const second = await run();

    expect(second.upserted[0].map((r: any) => r.shopify_variant_id)).toEqual(
      first.upserted[0].map((r: any) => r.shopify_variant_id),
    );
    expect(second.deletedVariantIds).toEqual([]);
    expect(second.nullRowsDeleted).toBe(0);
  });
});

describe('Riconciliazione delle varianti — spazzata della sync completa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Client Supabase per il bulk: registra la spazzata finale (`lt`). */
  function bulkSupabase() {
    const sweeps: any[][] = [];
    vi.mocked(createSupabaseClient).mockReturnValue({
      from: () => ({
        select: () => ({ range: async () => ({ data: [], error: null }) }),
        upsert: async () => ({ error: null }),
        delete: () => ({
          lt: async (...args: any[]) => {
            sweeps.push(args);
            return { error: null };
          },
        }),
      }),
    } as any);
    return sweeps;
  }

  it('scansione tutta completa: la spazzata avviene come prima', async () => {
    mockShop();
    const sweeps = bulkSupabase();
    mockGetProducts([
      {
        products: [{ id: 1, variants_complete: true, variants: variants(1, 2) }],
        nextPageInfo: null,
      },
    ]);
    vi.mocked(transformProduct).mockReturnValue(rowsFor(1, [1, 2]) as any);

    await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

    expect(sweeps).toHaveLength(1);
    expect(sweeps[0][0]).toBe('synced_at');
  });

  it('un solo prodotto monco basta a fermare la spazzata dell intero catalogo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockShop();
    const sweeps = bulkSupabase();
    mockGetProducts([
      {
        products: [
          { id: 1, variants_complete: true, variants: variants(1, 2) },
          // Questo si e' fermato a meta': le sue varianti non lette non sono
          // state riscritte, e la spazzata — che cancella "tutto cio' che non ha
          // synced_at di adesso" — se le porterebbe via.
          { id: 2, variants_complete: false, variants: variants(10, 100) },
        ],
        nextPageInfo: null,
      },
    ]);
    vi.mocked(transformProduct).mockImplementation((p: any) => rowsFor(p.id, [p.id * 10]) as any);

    await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

    expect(sweeps).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Spazzata dei prodotti obsoleti saltata'));
    warn.mockRestore();
  });

  it('prodotto monco e senza righe idonee: conta lo stesso, la spazzata resta ferma', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockShop();
    const sweeps = bulkSupabase();
    mockGetProducts([
      {
        products: [{ id: 2, variants_complete: false, variants: variants(10, 100) }],
        nextPageInfo: null,
      },
    ]);
    // Nella parte letta nessuna variante ha il costo: senza il conteggio fatto
    // prima dello scarto, questo prodotto uscirebbe di scena inosservato.
    vi.mocked(transformProduct).mockReturnValue([] as any);

    await processInitialBulkSync('shop-1', { updateProgress: vi.fn() } as any);

    expect(sweeps).toEqual([]);
    warn.mockRestore();
  });
});
