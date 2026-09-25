import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creaFakeWebhookStore } from '~/lib/webhooks/inbox-fake-store';

/**
 * La rotta dei prodotti dopo che il lavoro e' uscito dalla richiesta HTTP.
 *
 * COSA E' CAMBIATO. Prima la rotta rileggeva da Shopify, scriveva nel database
 * del merchant e ripuliva, tutto PRIMA di rispondere: una scrittura fallita
 * diventava un 500 e Shopify ritentava rifacendo tutto daccapo. Adesso la
 * risposta e' la sola ricevuta, e cosa e' successo davvero si legge sulla riga
 * dell'evento — e' li' che questi test guardano quando prima guardavano il
 * codice di stato.
 */
const store = creaFakeWebhookStore();

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
  prisma: {
    // La posta in arrivo vera, non un mock che dice sempre di si': l'indice
    // unico su `webhook_id` e la presa condizionata sullo stato sono cio' che
    // rende un evento consegnato due volte un effetto solo, e provarli con dei
    // mock compiacenti vorrebbe dire non provarli affatto.
    get webhookEvent() {
      return store;
    },
    shop: { findUnique: vi.fn() },
    plan: { findFirst: vi.fn() },
    syncJob: { create: vi.fn() },
    // Serve all'import: la posta in arrivo conosce tutti i processori, e quelli
    // che parlano con Shopify si portano dietro il magazzino delle sessioni.
    session: { count: async () => 0, findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
  },
}));

import { action as rotta } from './webhooks.products.create';
import { settleWebhookWork } from '~/lib/webhooks/receive.server';

/** La rotta piu' il lavoro che parte dopo la risposta. */
async function action(args: { request: Request }) {
  const res = await rotta(args as never);
  await settleWebhookWork();
  return res;
}

/** Com'e' finito l'unico evento che questi test producono. */
function evento() {
  return store.righe[0];
}
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

/**
 * Negozio collegato e pronto a scrivere.
 *
 * `authorization` e `uninstalledAt` sono comparsi qui quando il webhook ha
 * smesso di guardare il solo collegamento: prima un negozio sospeso passava, e
 * questa riga finta non aveva modo di dirlo. Ora il negozio di prova deve
 * dichiararsi in regola, e chi vuole provare il contrario lo scrive.
 */
function mockShop(over: Record<string, unknown> = {}) {
  (prisma.shop.findUnique as any).mockResolvedValue({
    id: 'shop-1',
    shopDomain: 'test-shop.myshopify.com',
    accessToken: 'enc',
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products',
    currentPlan: 'growth',
    supabaseConfig: { connectionVerifiedAt: new Date(), tableNameProducts: 'products' },
    ...over,
  });
  (prisma.plan.findFirst as any).mockResolvedValue({
    planName: 'growth',
    customersSyncEnabled: true,
    productFeedsEnabled: true,
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
function mockSupabase(upsertError: { message: string; code?: string } | null = null) {
  const upserted: any[] = [];
  const deletes: { kind: string; args: any[] }[] = [];

  (createSupabaseClient as any).mockReturnValue({
    from: () => ({
      upsert: async (rows: any[]) => {
        upserted.push(...rows);
        return { error: upsertError };
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
    store.reset();
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
    store.reset();
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

  it('payload senza id: si acknowledgia, ma l evento non sparisce in silenzio', async () => {
    // Prima si scriveva un avviso nel log e si rispondeva "ricevuto": una busta
    // che non nomina nessun prodotto non la ritrovava piu' nessuno. Adesso la
    // riga si scrive lo stesso e va in lettera morta, che e' l'unico modo di
    // accorgersi che qualcosa a monte manda buste illeggibili.
    mockShop();
    const getProductById = mockClient({ id: 1, variants_complete: true, variants: [] });

    const res = await action({ request: req({ title: 'senza id' }) } as any);

    expect(getProductById).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(evento().status).toBe('dead_letter');
  });
});

/**
 * La porta di servizio dei prodotti.
 *
 * Le notifiche di Shopify arrivano da sole: il merchant non deve premere
 * niente, e nessuna schermata dell'app sta in mezzo. Per questo qui il
 * controllo pesa piu' che altrove — era l'unico punto in cui un negozio
 * sospeso poteva continuare a farsi scrivere nel database senza fare nulla.
 *
 * Si acknowledgia sempre 200: non c'e' niente da riprovare, e insistere per due
 * giorni finirebbe solo per far spegnere la sottoscrizione a Shopify.
 */
describe('webhook products/create — chi non ha diritto non scrive', () => {
  const nonSiScrive = async () => {
    const { upserted, deletes } = mockSupabase();
    const getProductById = mockClient({ id: 42, variants_complete: true, variants: [] });

    const res = await action({ request: req({ id: 42 }) } as any);

    expect(res.status).toBe(200);
    expect(upserted).toEqual([]);
    expect(deletes).toEqual([]);
    // Non si tocca nemmeno Shopify: rileggere il prodotto per poi buttarlo via
    // sarebbe una chiamata pagata per niente.
    expect(getProductById).not.toHaveBeenCalled();
  };

  it("uso dell'app sospeso (DISABLED): niente scritture", async () => {
    mockShop({ authorization: 'DISABLED' });
    await nonSiScrive();
  });

  it('trial finito (PENDING): niente scritture', async () => {
    mockShop({ authorization: 'PENDING' });
    await nonSiScrive();
  });

  it('app disinstallata: niente scritture', async () => {
    // Le tabelle restano al merchant, ed e' giusto cosi'. Ma restare non vuol
    // dire continuare ad aggiornarsi.
    mockShop({ uninstalledAt: new Date('2026-05-01T00:00:00Z') });
    await nonSiScrive();
  });

  it('valore inatteso nella colonna: in dubbio non si scrive', async () => {
    mockShop({ authorization: 'DISABLD' });
    await nonSiScrive();
  });

  it('progetto scollegato: niente scritture', async () => {
    mockShop({ supabaseConfig: { connectionVerifiedAt: null, tableNameProducts: 'products' } });
    await nonSiScrive();
  });
});

// Rispondere 200 a Shopify vuol dire "ricevuto e a posto", e Shopify non ripete
// piu' quella consegna. Dirlo su una scrittura fallita significa che quella
// modifica del prodotto non arriva mai — il merchant vede nei suoi conti un
// prezzo o un costo che nel negozio e' gia' cambiato.
describe('webhook products/create — una scrittura fallita non si dichiara riuscita', () => {
  beforeEach(() => {
    store.reset();
    vi.clearAllMocks();
  });

  it('upsert rifiutato → l evento resta da lavorare, e la traccia c e', async () => {
    mockShop();
    mockClient({ id: 1, variants_complete: true, variants: [{ id: 11 }] });
    mockSupabase({ message: 'permission denied for table products', code: '42501' });

    (transformProduct as any).mockReturnValue([
      { shopify_product_id: 1, shopify_variant_id: 11, cost_per_item: 5, net_value: 5 },
    ]);

    const res = await action({ request: req({ id: 1, variants: [{ id: 11 }] }) } as any);

    // 200 perche' la ricevuta e' scritta, e rifiutare adesso un evento gia'
    // accettato non rimetterebbe a posto niente. Che la scrittura NON sia
    // riuscita si legge sulla riga: torna in attesa, con un tentativo speso.
    expect(res.status).toBe(200);
    expect(evento().status).toBe('queued');
    expect(evento().attempts).toBe(1);
    expect(evento().completedAt).toBeNull();
    const job = (prisma.syncJob.create as any).mock.calls[0][0].data;
    expect(job).toMatchObject({ shopId: 'shop-1', status: 'failed' });
    expect(job.errors.message).toContain('permission denied');
  });
});
