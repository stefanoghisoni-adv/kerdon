import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/lib/webhooks/verify.server', () => ({ verifyWebhook: () => true }));
vi.mock('~/lib/transformers/product.server', () => ({ transformProduct: vi.fn() }));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn() }));
vi.mock('~/lib/shopify-api.server', () => {
  const ctor = vi.fn();
  return {
    ShopifyAPIClient: Object.assign(ctor, {
      forShop: vi.fn(async (shop: string) => new (ctor as any)(shop)),
    }),
  };
});
vi.mock('~/lib/stats/inventory-cost.server', () => ({
  enrichVariantCosts: vi.fn(async (_c: unknown, p: unknown) => p),
}));
vi.mock('~/db.server', () => ({
  prisma: { shop: { findUnique: vi.fn() }, syncJob: { create: vi.fn() } },
}));

import { action } from './webhooks.products.create';
import { transformProduct } from '~/lib/transformers/product.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { enrichVariantCosts } from '~/lib/stats/inventory-cost.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { prisma } from '~/db.server';

function req(body: object) {
  return new Request('https://app/webhooks/products/create', {
    method: 'POST',
    headers: {
      'X-Shopify-Hmac-Sha256': 'sig',
      'X-Shopify-Shop-Domain': 'test-shop.myshopify.com',
    },
    body: JSON.stringify(body),
  });
}

/** Negozio collegato e pronto a scrivere. */
function mockShop() {
  (prisma.shop.findUnique as any).mockResolvedValue({
    id: 'shop-1',
    shopDomain: 'test-shop.myshopify.com',
    accessToken: 'enc',
    supabaseConfig: { connectionVerifiedAt: new Date(), tableNameProducts: 'products' },
  });
  (prisma.syncJob.create as any).mockResolvedValue({});
}

/** Il client Shopify che il webhook usa per rileggere il prodotto. */
function mockClient(product: unknown) {
  const getProductById = vi.fn(async () => product);
  (ShopifyAPIClient as any).mockImplementation(() => ({ getProductById }));
  return getProductById;
}

/**
 * Un client Supabase che registra ogni cancellazione invece di eseguirla, con
 * la catena di concatenazioni che il route percorre davvero.
 */
function mockSupabase() {
  const upserted: any[] = [];
  const deletes: { kind: string; args: any[] }[] = [];

  (createSupabaseClient as any).mockReturnValue({
    from: () => ({
      upsert: async (rows: any[]) => {
        upserted.push(...rows);
        return { error: null };
      },
      delete: () => ({
        eq: (...eqArgs: any[]) => {
          // `.delete().eq(...)` senza altro dietro = via tutto il prodotto: e'
          // un thenable, cosi' funziona sia atteso direttamente sia concatenato.
          const pending: any = {
            not: async (...a: any[]) => {
              deletes.push({ kind: 'stale-variants', args: a });
              return { error: null };
            },
            is: async (...a: any[]) => {
              deletes.push({ kind: 'legacy-null', args: a });
              return { error: null };
            },
            then: (resolve: (v: any) => unknown) => {
              deletes.push({ kind: 'whole-product', args: eqArgs });
              return Promise.resolve(resolve({ error: null }));
            },
          };
          return pending;
        },
      }),
    }),
  });

  return { upserted, deletes };
}

describe('webhook products/create — idoneità', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('arricchisce il costo e upserta solo le varianti idonee', async () => {
    mockShop();
    mockClient({ id: 1, variants_complete: true, variants: [{ id: 11 }, { id: 12 }] });
    const { upserted } = mockSupabase();

    (transformProduct as any).mockReturnValue([
      { shopify_product_id: 1, shopify_variant_id: 11, cost_per_item: 5, net_value: 5 },
      { shopify_product_id: 1, shopify_variant_id: 12, cost_per_item: null, net_value: null },
    ]);

    const res = await action({ request: req({ id: 1, variants: [{ id: 11 }, { id: 12 }] }) } as any);

    expect(enrichVariantCosts).toHaveBeenCalledTimes(1);
    expect(upserted.map((r) => r.shopify_variant_id)).toEqual([11]);
    expect(res.status).toBe(200);
  });

  it('nessuna variante idonea → rimuove tutte le righe del prodotto', async () => {
    mockShop();
    mockClient({ id: 7, variants_complete: true, variants: [{ id: 71 }] });
    const { deletes } = mockSupabase();

    (transformProduct as any).mockReturnValue([
      { shopify_product_id: 7, shopify_variant_id: 71, cost_per_item: null, net_value: null },
    ]);

    await action({ request: req({ id: 7, variants: [{ id: 71 }] }) } as any);

    const wholeProduct = deletes.find((d) => d.kind === 'whole-product');
    expect(wholeProduct?.args).toEqual(['shopify_product_id', 7]);
  });
});

describe('webhook products/create — il payload non e una fotografia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignora le varianti del payload e rilegge il prodotto per id', async () => {
    mockShop();
    // Il webhook annuncia una sola variante; su Shopify ce ne sono tre.
    const getProductById = mockClient({
      id: 42,
      variants_complete: true,
      variants: [{ id: 421 }, { id: 422 }, { id: 423 }],
    });
    const { upserted } = mockSupabase();

    (transformProduct as any).mockImplementation((p: any) =>
      p.variants.map((v: any) => ({
        shopify_product_id: 42,
        shopify_variant_id: v.id,
        cost_per_item: 3,
        net_value: 3,
      })),
    );

    await action({ request: req({ id: 42, variants: [{ id: 421 }] }) } as any);

    expect(getProductById).toHaveBeenCalledWith(42);
    // Sono state scritte le tre varianti vere, non l'unica che il payload citava.
    expect(upserted.map((r) => r.shopify_variant_id)).toEqual([421, 422, 423]);
  });

  it('payload parziale ed elenco incompleto: si aggiorna, non si cancella nulla', async () => {
    mockShop();
    // La rilettura si e' fermata a meta' (una pagina annidata non e' arrivata).
    mockClient({ id: 42, variants_complete: false, variants: [{ id: 421 }] });
    const { upserted, deletes } = mockSupabase();

    (transformProduct as any).mockReturnValue([
      { shopify_product_id: 42, shopify_variant_id: 421, cost_per_item: 3, net_value: 3 },
    ]);

    await action({ request: req({ id: 42, variants: [{ id: 421 }] }) } as any);

    // Le varianti lette si aggiornano lo stesso: un elenco monco non e' un
    // motivo per non scrivere quel che si e' letto.
    expect(upserted.map((r) => r.shopify_variant_id)).toEqual([421]);
    // Ma nessuna riga se ne va per differenza.
    expect(deletes.filter((d) => d.kind === 'stale-variants')).toEqual([]);
    expect(deletes.filter((d) => d.kind === 'whole-product')).toEqual([]);
  });

  it('elenco incompleto e nessuna variante idonea: il prodotto NON viene svuotato', async () => {
    mockShop();
    mockClient({ id: 42, variants_complete: false, variants: [{ id: 421 }] });
    const { deletes } = mockSupabase();

    // Nella parte letta nessuna variante ha il costo: sull'elenco completo
    // sarebbe la cancellazione di tutto il prodotto, qui non deve esserlo.
    (transformProduct as any).mockReturnValue([
      { shopify_product_id: 42, shopify_variant_id: 421, cost_per_item: null, net_value: null },
    ]);

    const res = await action({ request: req({ id: 42, variants: [{ id: 421 }] }) } as any);

    expect(deletes).toEqual([]);
    expect(res.status).toBe(200);
  });

  it('prodotto non piu leggibile: nessuna scrittura e nessuna cancellazione', async () => {
    mockShop();
    mockClient(null);
    const { upserted, deletes } = mockSupabase();

    const res = await action({ request: req({ id: 42 }) } as any);

    expect(upserted).toEqual([]);
    expect(deletes).toEqual([]);
    expect(transformProduct).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it('payload senza id: si acknowledgia senza toccare nulla', async () => {
    mockShop();
    const getProductById = mockClient({ id: 1, variants_complete: true, variants: [] });

    const res = await action({ request: req({ title: 'senza id' }) } as any);

    expect(getProductById).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
