import { describe, it, expect, vi, beforeEach } from 'vitest';

// Il guasto che questi test tengono chiuso, in una riga: la corsa completa
// smetteva di impaginare al tetto del piano e poi eseguiva lo stesso la
// spazzata globale, cancellando tutto cio' che stava oltre — dati vivi su
// Shopify, tolti dal database del merchant perche' nessuno era andato a
// chiederli.

vi.mock('../../db.server', () => ({
  prisma: {
    shop: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
    syncJob: {
      create: vi.fn(async () => ({ id: 'job-1' })),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
    syncJobEvent: {
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    plan: { findFirst: vi.fn() },
    syncRepair: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
      groupBy: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    productScopeEntry: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn((args: unknown) => args),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : ops,
    ),
  },
}));

vi.mock('../../utils/crypto.server', () => ({ decrypt: (v: string) => `d_${v}` }));

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
  enrichVariantCosts: vi.fn(async (_c: unknown, products: unknown) => products),
}));
vi.mock('../supabase/ensure-products-table.server', () => ({
  ensureProductsTable: vi.fn(async () => ({ status: 'already_present', empty: false })),
}));

import { processInitialBulkSync } from './processors.server';
import { ShopifyAPIClient } from '../shopify-api.server';
import { createSupabaseClient } from '../supabase.server';
import { transformProduct } from '../transformers/product.server';
import { prisma } from '../../db.server';
import { MAX_PRODUCT_PAGES } from '~/lib/sync/product-scope';

const NEGOZIO = {
  id: 'shop-1',
  shopDomain: 'test.myshopify.com',
  uninstalledAt: null,
  authorization: 'ENABLED',
  accessToken: 'tok',
  currentPlan: 'basic',
  supabaseConfig: {
    connectionVerifiedAt: new Date(),
    tableNameProducts: 'products',
    supabaseUrl: 'https://x.supabase.co',
    supabasePublicKey: 'k',
    supabaseServiceRoleKey: 's',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
};

interface DeleteCall {
  method: string;
  args: unknown[];
}

/**
 * Il doppione di Supabase con dentro la sola cosa che questi test guardano:
 * quali cancellazioni sono partite e con che condizioni.
 *
 * `righeTenute` sono i prodotti di cui il database del merchant ha gia' delle
 * righe: e' cio' che la corsa legge per sapere quali risorse fuori ambito hanno
 * dei dati da proteggere, e quali prodotti sono spariti da Shopify.
 */
function supabaseFinto(righeTenute: number[] = []) {
  const deletes: DeleteCall[] = [];
  const esito = { data: [], error: null };

  const client = {
    from: () => ({
      upsert: async () => ({ error: null }),
      select: (columns: string) => ({
        range: async (from: number) => ({
          data:
            columns === 'shopify_product_id' && from === 0
              ? righeTenute.map((id) => ({ shopify_product_id: id }))
              : [],
          error: null,
        }),
        in: async () => ({ data: [], error: null }),
        eq: async () => ({ data: [], error: null }),
      }),
      delete: () => ({
        gte: async (...args: unknown[]) => {
          deletes.push({ method: 'gte', args });
          return esito;
        },
        lt: (...args: unknown[]) => {
          deletes.push({ method: 'lt', args });
          return Object.assign(Promise.resolve(esito), {
            in: async (...ids: unknown[]) => {
              deletes.push({ method: 'lt.in', args: ids });
              return esito;
            },
          });
        },
        in: async (...args: unknown[]) => {
          deletes.push({ method: 'in', args });
          return esito;
        },
      }),
    }),
  };

  return { client, deletes };
}

/** Le cancellazioni senza nessuna restrizione sul prodotto: quelle che facevano il danno. */
function nude(deletes: DeleteCall[]): DeleteCall[] {
  return deletes.filter((c, i) => c.method === 'lt' && deletes[i + 1]?.method !== 'lt.in');
}

/** Cosa la corsa ha scritto nel registro dell'ambito. */
function scritteNelRegistro(): { productId: string; inScope: boolean; reason: string }[] {
  return vi.mocked(prisma.productScopeEntry.upsert).mock.calls.map((call) => {
    const args = call[0] as any;
    return {
      productId: args.where.shopId_shopifyProductId.shopifyProductId,
      inScope: args.create.inScope,
      reason: args.create.reason,
    };
  });
}

function prodotto(id: number, createdAt: string) {
  return { id, title: `P${id}`, created_at: createdAt, variants_complete: true, variants: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.shop.findUnique).mockResolvedValue(NEGOZIO as any);
  vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'job-1' } as any);
  vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);
  vi.mocked(prisma.productScopeEntry.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.productScopeEntry.upsert).mockImplementation(((args: unknown) => args) as any);
  vi.mocked(transformProduct).mockImplementation(
    (p: any) => [{ shopify_product_id: p.id, shopify_variant_id: p.id * 10, cost_per_item: 3, net_value: 7 }] as any,
  );
});

describe('il tetto del piano non cancella piu' + ' niente', () => {
  it('a quota raggiunta le righe oltre il tetto restano, e sono dichiarate ferme', async () => {
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: 1 } as any);

    // Due prodotti su Shopify, di tutti e due teniamo gia' delle righe. Il
    // piano ne copre uno solo.
    const { client, deletes } = supabaseFinto([1, 2]);
    vi.mocked(createSupabaseClient).mockReturnValue(client as any);
    vi.mocked(ShopifyAPIClient).mockImplementation((() => ({
      getProducts: vi.fn(async () => ({
        products: [prodotto(1, '2024-01-01'), prodotto(2, '2024-02-01')],
        nextPageInfo: null,
      })),
    })) as any);

    await processInitialBulkSync('shop-1');

    // Nessuna cancellazione senza restrizione: era quella a portare via
    // l'eccedenza.
    expect(nude(deletes)).toHaveLength(0);

    // La spazzata c'e', ma nomina solo il prodotto che stiamo ancora
    // aggiornando. Il 2 non compare: le sue righe non sono materia sua.
    const ristrette = deletes.filter((c) => c.method === 'lt.in');
    expect(ristrette).toHaveLength(1);
    expect(ristrette[0].args[1]).toEqual([1]);

    // E niente cancellazioni per id: nessun prodotto e' sparito da Shopify.
    expect(deletes.filter((c) => c.method === 'in')).toHaveLength(0);

    // Il registro dice cosa e' successo: uno si aggiorna, l'altro e' fermo per
    // il tetto del piano.
    expect(scritteNelRegistro()).toEqual([
      { productId: '1', inScope: true, reason: 'in_scope' },
      { productId: '2', inScope: false, reason: 'plan_quota' },
    ]);
  });

  it('fuori quota senza dati: niente da fermare, niente da scrivere nel registro', async () => {
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: 1 } as any);

    // Del secondo prodotto non teniamo nessuna riga: non e' fermo, e'
    // semplicemente non sincronizzato — lo dice gia' l'avviso del tetto.
    const { client } = supabaseFinto([1]);
    vi.mocked(createSupabaseClient).mockReturnValue(client as any);
    vi.mocked(ShopifyAPIClient).mockImplementation((() => ({
      getProducts: vi.fn(async () => ({
        products: [prodotto(1, '2024-01-01'), prodotto(2, '2024-02-01')],
        nextPageInfo: null,
      })),
    })) as any);

    await processInitialBulkSync('shop-1');

    expect(scritteNelRegistro()).toEqual([
      { productId: '1', inScope: true, reason: 'in_scope' },
    ]);
  });

  it('l ordine in cui arrivano le pagine non cambia chi resta dentro', async () => {
    const ambitoPerOrdine = async (pagine: number[][]) => {
      vi.clearAllMocks();
      vi.mocked(prisma.shop.findUnique).mockResolvedValue(NEGOZIO as any);
      vi.mocked(prisma.syncJob.create).mockResolvedValue({ id: 'job-1' } as any);
      vi.mocked(prisma.syncJob.update).mockResolvedValue({} as any);
      vi.mocked(prisma.productScopeEntry.findMany).mockResolvedValue([] as any);
      vi.mocked(prisma.productScopeEntry.upsert).mockImplementation(((a: unknown) => a) as any);
      vi.mocked(transformProduct).mockImplementation(
        (p: any) => [{ shopify_product_id: p.id, shopify_variant_id: p.id * 10, cost_per_item: 3, net_value: 7 }] as any,
      );
      vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: 2 } as any);

      const { client } = supabaseFinto([1, 2, 3, 4]);
      vi.mocked(createSupabaseClient).mockReturnValue(client as any);

      // Le date sono legate all'id: il prodotto 1 e' il piu' vecchio.
      const perId = (id: number) => prodotto(id, `2024-0${id}-01`);
      let indice = 0;
      vi.mocked(ShopifyAPIClient).mockImplementation((() => ({
        getProducts: vi.fn(async () => {
          const pagina = pagine[indice++];
          return {
            products: pagina.map(perId),
            nextPageInfo: indice < pagine.length ? `p${indice}` : null,
          };
        }),
      })) as any);

      await processInitialBulkSync('shop-1');
      return scritteNelRegistro()
        .filter((r) => r.inScope)
        .map((r) => r.productId)
        .sort();
    };

    const dritto = await ambitoPerOrdine([[1, 2], [3, 4]]);
    const rovescio = await ambitoPerOrdine([[4, 3], [2, 1]]);
    const mescolato = await ambitoPerOrdine([[3, 1], [4, 2]]);

    expect(dritto).toEqual(['1', '2']);
    expect(rovescio).toEqual(dritto);
    expect(mescolato).toEqual(dritto);
  });
});

describe('cancellato su Shopify e fermo per la quota sono due cose diverse', () => {
  it('un prodotto sparito perde le sue righe anche se era fuori ambito', async () => {
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: 1 } as any);

    // Teniamo righe di tre prodotti; su Shopify ne esistono due. Il 3 non c'e'
    // piu': fuori ambito nessuna corsa ci ripassa, quindi se non lo togliamo
    // adesso resta nel database del merchant per sempre.
    const { client, deletes } = supabaseFinto([1, 2, 3]);
    vi.mocked(createSupabaseClient).mockReturnValue(client as any);
    vi.mocked(ShopifyAPIClient).mockImplementation((() => ({
      getProducts: vi.fn(async () => ({
        products: [prodotto(1, '2024-01-01'), prodotto(2, '2024-02-01')],
        nextPageInfo: null,
      })),
    })) as any);

    await processInitialBulkSync('shop-1');

    const perId = deletes.filter((c) => c.method === 'in');
    expect(perId).toHaveLength(1);
    expect(perId[0].args[1]).toEqual([3]);

    // Il 2, fermo ma vivo, non e' fra quelli tolti.
    expect(perId[0].args[1]).not.toContain(2);
  });
});

describe('cambio di piano', () => {
  it('a un piano piu piccolo non si perde niente: si spazza solo dentro il nuovo ambito', async () => {
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: 1 } as any);

    const { client, deletes } = supabaseFinto([1, 2, 3]);
    vi.mocked(createSupabaseClient).mockReturnValue(client as any);
    vi.mocked(ShopifyAPIClient).mockImplementation((() => ({
      getProducts: vi.fn(async () => ({
        products: [prodotto(1, '2024-01-01'), prodotto(2, '2024-02-01'), prodotto(3, '2024-03-01')],
        nextPageInfo: null,
      })),
    })) as any);

    await processInitialBulkSync('shop-1');

    expect(nude(deletes)).toHaveLength(0);
    expect(deletes.filter((c) => c.method === 'in')).toHaveLength(0);
    const ristrette = deletes.filter((c) => c.method === 'lt.in');
    expect(ristrette[0].args[1]).toEqual([1]);

    const registro = scritteNelRegistro();
    expect(registro.filter((r) => !r.inScope).map((r) => r.productId)).toEqual(['2', '3']);
  });

  it('a un piano senza tetto l ambito si riallarga e il registro si svuota', async () => {
    // Piano senza tetto: nessuna risorsa e' piu' ferma, e la spazzata torna a
    // essere quella di sempre — una query sola, senza restrizioni.
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: null } as any);

    const { client, deletes } = supabaseFinto([1, 2, 3]);
    vi.mocked(createSupabaseClient).mockReturnValue(client as any);
    vi.mocked(ShopifyAPIClient).mockImplementation((() => ({
      getProducts: vi.fn(async () => ({
        products: [prodotto(1, '2024-01-01'), prodotto(2, '2024-02-01'), prodotto(3, '2024-03-01')],
        nextPageInfo: null,
      })),
    })) as any);

    await processInitialBulkSync('shop-1');

    // La spazzata di prima: nessuna restrizione sull'ambito, perche' non c'e'
    // piu' nessun ambito da rispettare.
    expect(nude(deletes)).toHaveLength(1);
    expect(deletes.filter((c) => c.method === 'lt.in')).toHaveLength(0);

    // Niente resta dichiarato fermo, e le classificazioni vecchie se ne vanno:
    // sono i tre prodotti che tornano ad aggiornarsi.
    expect(scritteNelRegistro()).toEqual([]);
    expect(prisma.productScopeEntry.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ shopId: 'shop-1' }) }),
    );
  });
});

describe('impaginazione interrotta', () => {
  it('la fermata di sicurezza non autorizza nessuna cancellazione', async () => {
    vi.mocked(prisma.plan.findFirst).mockResolvedValue({ maxProducts: 1 } as any);

    // Un cursore che non finisce mai. Fermarsi qui NON e' finire il catalogo:
    // quel che sta oltre non e' stato guardato, e non e' spazzabile.
    const { client, deletes } = supabaseFinto([1, 2]);
    vi.mocked(createSupabaseClient).mockReturnValue(client as any);
    const getProducts = vi.fn(async () => ({
      products: [prodotto(1, '2024-01-01')],
      nextPageInfo: 'sempre-un-altra',
    }));
    vi.mocked(ShopifyAPIClient).mockImplementation((() => ({ getProducts })) as any);

    await processInitialBulkSync('shop-1');

    expect(getProducts).toHaveBeenCalledTimes(MAX_PRODUCT_PAGES);
    expect(deletes).toHaveLength(0);
    // E nemmeno il registro si riscrive: "non l'ho trovato" qui vuol dire "non
    // l'ho cercato".
    expect(prisma.productScopeEntry.upsert).not.toHaveBeenCalled();
    expect(prisma.productScopeEntry.deleteMany).not.toHaveBeenCalled();
  });
});
