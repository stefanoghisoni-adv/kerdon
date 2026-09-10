import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { creaFakeWebhookStore } from './inbox-fake-store';
import {
  MAX_WEBHOOK_BODY_BYTES,
  WEBHOOK_RESPONSE_HARD_LIMIT_MS,
  WEBHOOK_RESPONSE_TARGET_MS,
  responseBudgetReport,
} from './inbox-model';

/**
 * La posta in arrivo dei webhook operativi, dalla busta all'effetto.
 *
 * COSA C'ERA PRIMA. Prodotti, clienti e ordini facevano tutto DENTRO la
 * richiesta HTTP: rilettura da Shopify, interrogazioni al database owner e a
 * quello del merchant, upsert, pulizie e registrazioni, e solo alla fine la
 * risposta. Due conseguenze, e la seconda era invisibile.
 *
 * La prima: il tempo di risposta era il tempo di due sistemi remoti in fila, e
 * un timeout faceva ritentare Shopify — cioe' rifare daccapo tutto quello che
 * era gia' riuscito, senza che niente da nessuna parte sapesse che era gia'
 * riuscito. La deduplica per `X-Shopify-Webhook-Id` per questi topic non
 * esisteva affatto.
 *
 * La seconda: le pulizie in coda al lavoro — le varianti che il prodotto non ha
 * piu', le righe legacy, il posto in graduatoria di un prodotto cancellato —
 * fallivano con un `console.warn` e la consegna risultava completata lo stesso.
 * Il lavoro non fatto non restava scritto da nessuna parte.
 *
 * Qui si prova quel che le due cose sono diventate. La posta in arrivo e i
 * processori sono quelli veri: e' l'unico modo di contare gli effetti davvero
 * prodotti da due consegne dello stesso evento.
 */

const store = creaFakeWebhookStore();
const verifyWebhook = vi.fn(() => true);
const shopFindUnique = vi.fn();
const planFindFirst = vi.fn();
const syncJobCreate = vi.fn(async () => ({}));
const scopeDeleteMany = vi.fn(async () => ({ count: 1 }));
const getProductById = vi.fn();
const createSupabaseClient = vi.fn();

vi.mock('~/lib/webhooks/verify.server', () => ({
  verifyWebhook: (...a: unknown[]) => verifyWebhook(...(a as [])),
}));
vi.mock('~/lib/supabase.server', () => ({
  createSupabaseClient: (...a: unknown[]) => createSupabaseClient(...(a as [])),
}));
vi.mock('~/lib/shopify-api.server', () => ({
  ShopifyAPIClient: { forShop: vi.fn(async () => ({ getProductById, getCustomerById: vi.fn() })) },
}));
vi.mock('~/lib/transformers/product.server', () => ({
  transformProduct: (p: { id: number }) => [
    { shopify_product_id: p.id, shopify_variant_id: p.id * 10 + 1, cost_per_item: 5 },
  ],
}));
vi.mock('~/lib/eligibility/product-eligibility', () => ({
  filterEligibleProductRows: (rows: unknown[]) => rows,
}));
vi.mock('~/lib/stats/inventory-cost.server', () => ({
  enrichVariantCosts: vi.fn(async () => undefined),
}));
vi.mock('~/db.server', () => ({
  prisma: {
    get webhookEvent() {
      return store;
    },
    shop: { findUnique: (...a: unknown[]) => shopFindUnique(...a) },
    plan: { findFirst: (...a: unknown[]) => planFindFirst(...a) },
    syncJob: { create: (...a: unknown[]) => syncJobCreate(...(a as [])) },
    productScopeEntry: { deleteMany: (...a: unknown[]) => scopeDeleteMany(...(a as [])) },
    session: { count: async () => 0, findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
  },
}));

import { receiveShopifyWebhook, settleWebhookWork } from './receive.server';

const DOMINIO = 'negozio.myshopify.com';

function richiesta(
  topic: string,
  corpo: unknown,
  over: { consegna?: string | null; contentLength?: string } = {},
) {
  const headers: Record<string, string> = {
    'X-Shopify-Hmac-Sha256': 'firma-valida',
    'X-Shopify-Shop-Domain': DOMINIO,
  };
  if (over.consegna !== null) headers['X-Shopify-Webhook-Id'] = over.consegna ?? 'consegna-1';
  if (over.contentLength) headers['Content-Length'] = over.contentLength;

  return new Request(`https://app/webhooks/${topic}`, {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

/** Un negozio installato, autorizzato, collegato e con i permessi in regola. */
function negozioInRegola(over: Record<string, unknown> = {}) {
  shopFindUnique.mockResolvedValue({
    id: 'shop-1',
    shopDomain: DOMINIO,
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products,read_customers,read_orders,read_all_orders',
    currentPlan: 'pro',
    supabaseConfig: {
      connectionVerifiedAt: new Date(),
      tableNameProducts: 'products',
      tableNameCustomers: 'customers',
    },
    ...over,
  });
  planFindFirst.mockResolvedValue({
    planName: 'pro',
    customersSyncEnabled: true,
    productFeedsEnabled: true,
  });
}

/**
 * Il database del merchant, con la possibilita' di far fallire un passo
 * preciso.
 *
 * I passi si distinguono perche' le tre cancellazioni in coda al lavoro sono
 * cose diverse: via tutto il prodotto, via le varianti obsolete, via le righe
 * senza id variante. Un mock che le confondesse non saprebbe provare che una
 * pulizia fallita tiene l'evento vivo.
 */
function databaseDelMerchant(
  guasti: {
    upsert?: { message: string; code?: string };
    varianti?: { message: string };
    legacy?: { message: string };
    delete?: { message: string };
  } = {},
) {
  const upserted: unknown[][] = [];
  const passi: string[] = [];

  createSupabaseClient.mockReturnValue({
    from: () => ({
      upsert: async (rows: unknown[]) => {
        passi.push('upsert');
        if (guasti.upsert) return { error: guasti.upsert };
        upserted.push(rows);
        return { error: null };
      },
      delete: () => {
        const builder: Record<string, unknown> = {
          not: async () => {
            passi.push('varianti-obsolete');
            return { error: guasti.varianti ?? null };
          },
          is: async () => {
            passi.push('righe-legacy');
            return { error: guasti.legacy ?? null };
          },
          // `.delete().eq(...)` senza altro dietro: e' un thenable, cosi'
          // funziona sia atteso direttamente sia concatenato.
          then: (resolve: (v: unknown) => unknown) => {
            passi.push('cancellazione');
            return Promise.resolve(resolve({ error: guasti.delete ?? null }));
          },
        };
        builder.eq = () => builder;
        return builder;
      },
    }),
  });

  return { upserted, passi };
}

/** Un prodotto come lo consegna la rilettura, con l'elenco varianti completo. */
function prodotto(id: number) {
  return { id, variants_complete: true, variants: [{ id: id * 10 + 1 }] };
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  verifyWebhook.mockReturnValue(true);
  syncJobCreate.mockResolvedValue({});
  scopeDeleteMany.mockResolvedValue({ count: 1 });
  negozioInRegola();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('prima della ricevuta', () => {
  it('corpo oltre il limite → rifiutato prima del parse, e nessuna riga', async () => {
    // Il corpo NON e' JSON valido: se qualcuno lo passasse a `JSON.parse` il
    // test lo saprebbe, perche' la risposta sarebbe 400 e non 413. E' il modo
    // di provare che il tetto viene prima, senza spiare la chiamata.
    const enorme = '[' + 'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1024);

    const res = await receiveShopifyWebhook(richiesta('products/create', enorme), 'products/create');

    expect(res.status).toBe(413);
    expect(store.righe).toHaveLength(0);
    expect(verifyWebhook).not.toHaveBeenCalled();
  });

  it('la lunghezza dichiarata basta a fermarlo, senza leggere un byte', async () => {
    const res = await receiveShopifyWebhook(
      richiesta('orders/create', { id: 1 }, { contentLength: String(MAX_WEBHOOK_BODY_BYTES + 1) }),
      'orders/create',
    );

    expect(res.status).toBe(413);
    expect(store.righe).toHaveLength(0);
  });

  it('un corpo che sta nel limite passa, anche se e grosso', async () => {
    // Il tetto e' largo per quel che Shopify manda davvero: un prodotto con
    // molte varianti o un ordine con molte righe ci sta dentro comodamente.
    getProductById.mockResolvedValue(prodotto(1));
    databaseDelMerchant();

    const res = await receiveShopifyWebhook(
      richiesta('products/create', { id: 1, note: 'y'.repeat(100_000) }),
      'products/create',
    );

    expect(res.status).toBe(200);
    expect(store.righe).toHaveLength(1);
  });

  it('firma non valida → nessuna ricevuta, e niente si muove', async () => {
    verifyWebhook.mockReturnValue(false);
    const { passi } = databaseDelMerchant();

    const res = await receiveShopifyWebhook(
      richiesta('customers/update', { id: 7 }),
      'customers/update',
    );

    expect(res.status).toBe(401);
    expect(store.righe).toHaveLength(0);
    expect(passi).toEqual([]);
    expect(shopFindUnique).not.toHaveBeenCalled();
  });
});

describe('la ricevuta non riesce', () => {
  it('database owner non disponibile → 5xx, e nessun successo falso', async () => {
    // E' l'unico caso in cui serve che Shopify ritenti, ed e' anche l'unico in
    // cui il ritentativo cambia qualcosa: la riga non c'e', quindi
    // quell'evento non lo lavorerebbe mai nessuno.
    vi.spyOn(store, 'create').mockRejectedValueOnce(new Error('database irraggiungibile'));
    const { passi } = databaseDelMerchant();

    const res = await receiveShopifyWebhook(
      richiesta('products/create', { id: 1 }),
      'products/create',
    );

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await res.json()).not.toHaveProperty('ok');
    expect(passi).toEqual([]);
  });

  it('non lascia trapelare il corpo del webhook nel log', async () => {
    vi.spyOn(store, 'create').mockRejectedValueOnce(new Error('database irraggiungibile'));

    await receiveShopifyWebhook(
      richiesta('customers/create', { id: 7, email: 'anna@esempio.it' }),
      'customers/create',
    );

    const scritto = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => c.join(' '))
      .join('\n');
    expect(scritto).toContain(DOMINIO);
    expect(scritto).not.toContain('anna@esempio.it');
  });
});

describe('la stessa consegna due volte', () => {
  it('un solo effetto, e la seconda lo dichiara', async () => {
    getProductById.mockResolvedValue(prodotto(42));
    const { upserted } = databaseDelMerchant();

    await receiveShopifyWebhook(richiesta('products/update', { id: 42 }), 'products/update');
    await settleWebhookWork();
    const seconda = await receiveShopifyWebhook(
      richiesta('products/update', { id: 42 }),
      'products/update',
    );
    await settleWebhookWork();

    expect(seconda.status).toBe(200);
    expect(await seconda.json()).toMatchObject({ duplicate: true });
    expect(store.righe).toHaveLength(1);
    expect(upserted).toHaveLength(1);
    expect(getProductById).toHaveBeenCalledTimes(1);
  });

  it('una consegna ripetuta riprende il lavoro rimasto in sospeso', async () => {
    // La prima ha scritto la ricevuta e poi e' caduta: la seconda non deve
    // limitarsi a dire "gia' vista", deve finire quel che era rimasto.
    getProductById.mockRejectedValueOnce(new Error('Shopify API error: 503'));
    getProductById.mockResolvedValue(prodotto(42));
    const { upserted } = databaseDelMerchant();

    await receiveShopifyWebhook(richiesta('products/update', { id: 42 }), 'products/update');
    await settleWebhookWork();
    expect(store.righe[0].status).toBe('queued');
    expect(upserted).toHaveLength(0);

    await receiveShopifyWebhook(richiesta('products/update', { id: 42 }), 'products/update');
    await settleWebhookWork();

    expect(store.righe).toHaveLength(1);
    expect(store.righe[0].status).toBe('completed');
    expect(store.righe[0].attempts).toBe(2);
    expect(upserted).toHaveLength(1);
  });

  it('un ritentativo rilegge da Shopify e non duplica niente', async () => {
    // Due consegne DISTINTE dello stesso prodotto — quel che succede quando
    // Shopify rimanda la notifica. Ognuna rilegge, e le righe scritte sono le
    // stesse: sono upsert sulla chiave della variante.
    getProductById.mockResolvedValue(prodotto(42));
    const { upserted } = databaseDelMerchant();

    await receiveShopifyWebhook(
      richiesta('products/create', { id: 42 }, { consegna: 'consegna-1' }),
      'products/create',
    );
    await settleWebhookWork();
    await receiveShopifyWebhook(
      richiesta('products/create', { id: 42 }, { consegna: 'consegna-2' }),
      'products/create',
    );
    await settleWebhookWork();

    expect(store.righe).toHaveLength(2);
    expect(getProductById).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(upserted[0])).toBe(JSON.stringify(upserted[1]));
  });
});

describe('le cancellazioni non rileggono niente', () => {
  it('la risorsa non e piu leggibile su Shopify, e si cancella lo stesso', async () => {
    // E' il punto della cancellazione: su Shopify il prodotto non esiste piu',
    // quindi non c'e' niente da rileggere. L'identificativo conservato alla
    // ricevuta e' l'unica cosa che resta, e basta a togliere le righe.
    getProductById.mockResolvedValue(null);
    const { passi } = databaseDelMerchant();

    const res = await receiveShopifyWebhook(
      richiesta('products/delete', { id: 99 }),
      'products/delete',
    );
    await settleWebhookWork();

    expect(res.status).toBe(200);
    expect(getProductById).not.toHaveBeenCalled();
    expect(passi).toEqual(['cancellazione']);
    expect(store.righe[0].status).toBe('completed');
  });

  it('sopravvive al ritentativo: cancellare due volte non fa danni', async () => {
    databaseDelMerchant();

    await receiveShopifyWebhook(
      richiesta('products/delete', { id: 99 }, { consegna: 'consegna-1' }),
      'products/delete',
    );
    await settleWebhookWork();
    await receiveShopifyWebhook(
      richiesta('products/delete', { id: 99 }, { consegna: 'consegna-2' }),
      'products/delete',
    );
    await settleWebhookWork();

    expect(store.righe.map((r) => r.status)).toEqual(['completed', 'completed']);
  });
});

describe('le pulizie sono passi del lavoro, non avvisi nel log', () => {
  it('varianti obsolete non rimosse → l evento resta da lavorare', async () => {
    // Prima: `console.warn` e consegna completata. Le righe di varianti che il
    // prodotto non ha piu' restavano nel database del merchant, e nessuno
    // sarebbe tornato a toglierle — il webhook non si ripete, e la corsa
    // periodica legge cio' che c'e' e non sa cosa e' di troppo.
    getProductById.mockResolvedValue(prodotto(42));
    const { upserted, passi } = databaseDelMerchant({ varianti: { message: 'permission denied' } });

    const res = await receiveShopifyWebhook(
      richiesta('products/update', { id: 42 }),
      'products/update',
    );
    await settleWebhookWork();

    expect(res.status).toBe(200);
    // La scrittura principale e' andata: non si disfa niente, si ritenta tutto.
    expect(upserted).toHaveLength(1);
    expect(passi).toContain('varianti-obsolete');
    expect(store.righe[0].status).toBe('queued');
    expect(store.righe[0].completedAt).toBeNull();
    expect(store.righe[0].attempts).toBe(1);
  });

  it('righe senza id variante non rimosse → stesso trattamento', async () => {
    getProductById.mockResolvedValue(prodotto(42));
    databaseDelMerchant({ legacy: { message: 'permission denied' } });

    await receiveShopifyWebhook(richiesta('products/update', { id: 42 }), 'products/update');
    await settleWebhookWork();

    expect(store.righe[0].status).toBe('queued');
  });

  it('registro dell ambito non aggiornato → l evento resta da lavorare', async () => {
    // Era best effort con un avviso, e non poteva restarlo: un prodotto
    // cancellato che resta in graduatoria occupa un posto del tetto, e quel
    // posto e' un prodotto vivo tenuto fuori dalla sincronizzazione per sempre.
    scopeDeleteMany.mockRejectedValueOnce(new Error('connection refused'));
    databaseDelMerchant();

    const res = await receiveShopifyWebhook(
      richiesta('products/delete', { id: 99 }),
      'products/delete',
    );
    await settleWebhookWork();

    expect(res.status).toBe(200);
    expect(store.righe[0].status).toBe('queued');
    expect(store.righe[0].completedAt).toBeNull();
  });

  it('quando le pulizie riescono, l evento e concluso', async () => {
    getProductById.mockResolvedValue(prodotto(42));
    const { passi } = databaseDelMerchant();

    await receiveShopifyWebhook(richiesta('products/update', { id: 42 }), 'products/update');
    await settleWebhookWork();

    expect(passi).toEqual(['upsert', 'varianti-obsolete', 'righe-legacy']);
    expect(store.righe[0].status).toBe('completed');
  });
});

/**
 * Il budget di risposta.
 *
 * E' la ragione per cui il lavoro non sta piu' dentro la richiesta, quindi va
 * misurato e non dichiarato. Qui la rilettura da Shopify e la scrittura sul
 * database del merchant costano un tempo VERO — non un mock istantaneo — cosi'
 * il test fallirebbe subito se qualcuno rimettesse il lavoro remoto davanti
 * alla risposta.
 */
describe('il budget di risposta', () => {
  const RITARDO_REMOTO_MS = 30;

  function remotoLento() {
    getProductById.mockImplementation(
      (id: number) =>
        new Promise((resolve) => setTimeout(() => resolve(prodotto(id)), RITARDO_REMOTO_MS)),
    );
  }

  it('una raffica di consegne distinte non si pesta i piedi', async () => {
    remotoLento();
    const { upserted } = databaseDelMerchant();

    const durate: number[] = [];
    const risposte = await Promise.all(
      Array.from({ length: 50 }, async (_v, i) => {
        const inizio = Date.now();
        const res = await receiveShopifyWebhook(
          richiesta('products/update', { id: 100 + i }, { consegna: `consegna-${i}` }),
          'products/update',
        );
        durate.push(Date.now() - inizio);
        return res;
      }),
    );

    // Tutte accettate, cinquanta righe distinte, nessuna dichiarata doppione.
    expect(risposte.every((r) => r.status === 200)).toBe(true);
    expect(store.righe).toHaveLength(50);
    expect(new Set(store.righe.map((r) => r.webhookId)).size).toBe(50);

    const budget = responseBudgetReport(durate);
    expect(budget.withinTarget).toBe(true);
    expect(budget.withinHardLimit).toBe(true);
    expect(budget.p95Ms).toBeLessThan(WEBHOOK_RESPONSE_TARGET_MS);
    expect(budget.maxMs).toBeLessThan(WEBHOOK_RESPONSE_HARD_LIMIT_MS);

    // La prova che la risposta non aspetta il lavoro: quando l'ultima e' gia'
    // partita, il remoto lento non ha ancora finito nemmeno una scrittura.
    expect(upserted.length).toBeLessThan(50);

    await settleWebhookWork();
    expect(store.righe.every((r) => r.status === 'completed')).toBe(true);
    expect(upserted).toHaveLength(50);
  });

  it('una raffica di duplicati resta un evento solo, e un effetto solo', async () => {
    remotoLento();
    const { upserted } = databaseDelMerchant();

    const durate: number[] = [];
    const risposte = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const inizio = Date.now();
        const res = await receiveShopifyWebhook(
          richiesta('products/update', { id: 42 }, { consegna: 'la-stessa' }),
          'products/update',
        );
        durate.push(Date.now() - inizio);
        return res;
      }),
    );

    expect(risposte.every((r) => r.status === 200)).toBe(true);
    expect(store.righe).toHaveLength(1);

    await settleWebhookWork();

    // Venti consegne, una rilettura e una scrittura: la presa condizionata
    // sullo stato ferma le altre diciannove prima che tocchino qualcosa.
    expect(getProductById).toHaveBeenCalledTimes(1);
    expect(upserted).toHaveLength(1);
    expect(store.righe[0].attempts).toBe(1);

    const budget = responseBudgetReport(durate);
    expect(budget.withinTarget).toBe(true);
    expect(budget.withinHardLimit).toBe(true);
  });
});
