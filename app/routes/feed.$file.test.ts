import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * La porta di servizio dei feed.
 *
 * Questa rotta e' l'unica dell'app che risponde senza sessione: chi la chiama e'
 * Meta, di notte, con in mano un indirizzo e nient'altro. Per questo per molto
 * tempo l'unico controllo e' stato "il feed e' acceso?" — e per questo era la
 * porta piu' larga che ci fosse. Un token non scade, e lo spegnimento del feed
 * vive su una riga che nessuno tocca quando il piano cambia o il negozio viene
 * sospeso.
 *
 * I test qui sotto provano soprattutto cio' che NON deve uscire.
 */

const findUniqueFeed = vi.fn();
const findUniqueShop = vi.fn();
const findFirstPlan = vi.fn();
vi.mock('~/db.server', () => ({
  prisma: {
    productFeed: { findUnique: (...a: unknown[]) => findUniqueFeed(...a) },
    shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) },
    plan: { findFirst: (...a: unknown[]) => findFirstPlan(...a) },
  },
}));

const loadFeedSource = vi.fn();
const recordFetch = vi.fn();
vi.mock('~/lib/feeds/feed.server', async () => {
  const actual =
    await vi.importActual<typeof import('~/lib/feeds/feed.server')>('~/lib/feeds/feed.server');
  return {
    ...actual,
    loadFeedSource: (...a: unknown[]) => loadFeedSource(...a),
    recordFetch: (...a: unknown[]) => recordFetch(...a),
  };
});

vi.mock('~/lib/feeds/mapping.server', () => ({
  loadMapping: vi.fn(async () => ({})),
  variablesOf: vi.fn(() => ({})),
}));

import { loader } from './feed.$file';

const call = (file = 'tok123.csv') =>
  loader({
    request: new Request(`https://api.kerdon.io/feed/${file}`),
    params: { file },
    context: {},
  } as never);

/** Un negozio a posto: installato, autorizzato, collegato, con i feed nel piano. */
function negozioSano(over: Record<string, unknown> = {}) {
  findUniqueShop.mockResolvedValue({
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products',
    currentPlan: 'growth',
    supabaseConfig: { connectionVerifiedAt: new Date('2026-01-01T00:00:00Z') },
    ...over,
  });
  findFirstPlan.mockResolvedValue({
    planName: 'growth',
    customersSyncEnabled: true,
    productFeedsEnabled: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueFeed.mockResolvedValue({ shopId: 'shop-1', enabled: true, platform: 'meta' });
  negozioSano();
  loadFeedSource.mockResolvedValue({
    domain: 'negozio.myshopify.com',
    currency: 'EUR',
    products: [],
  });
});

describe('feed pubblico — quando il catalogo esce', () => {
  it('negozio in regola e feed acceso: il file si serve', async () => {
    const res = await call();
    expect(res.status).toBe(200);
  });

  it('il feed non ha un tetto di prodotti: il limite del piano non lo tocca', async () => {
    // I feed sono inclusi o no, mai con una quantita': un piano con 20 prodotti
    // a listino serve comunque tutte le righe che ci sono.
    findFirstPlan.mockResolvedValue({
      planName: 'growth',
      maxProducts: 20,
      customersSyncEnabled: true,
      productFeedsEnabled: true,
    });
    const products = Array.from({ length: 250 }, (_, i) => ({
      shopify_product_id: 1000 + i,
      shopify_variant_id: 5000 + i,
      product_title: `Prodotto ${i}`,
      product_description: 'Descrizione',
      vendor: 'Acme',
      product_type: 'Abbigliamento',
      handle: `prodotto-${i}`,
      product_status: 'active',
      variant_title: null,
      sku: `SKU-${i}`,
      barcode: null,
      price: 19.9,
      compare_at_price: null,
      inventory_quantity: 5,
      inventory_tracked: true,
      inventory_policy: 'deny',
      image_url: `https://cdn.example.com/${i}.jpg`,
    }));
    loadFeedSource.mockResolvedValue({ domain: 'negozio.it', currency: 'EUR', products });

    const res = await call();

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Feed-Items')).toBe('250');
    expect(res.headers.get('X-Feed-Truncated')).toBeNull();
    // La lettura del catalogo non riceve nessun limite dal piano.
    expect(loadFeedSource).toHaveBeenCalledWith('shop-1');
  });
});

describe('feed pubblico — quando il catalogo NON deve uscire', () => {
  /**
   * Il 404 e' sempre lo stesso, di proposito: un token sbagliato, un feed spento
   * e un negozio che non ha piu' diritto rispondono identici. Questa rotta non
   * conferma niente a nessuno.
   */
  const nonSiServe = async () => {
    const res = await call();
    expect(res.status).toBe(404);
    // Il controllo arriva PRIMA della lettura: non si tocca il database del
    // merchant per un catalogo che poi non si spedisce.
    expect(loadFeedSource).not.toHaveBeenCalled();
    expect(recordFetch).not.toHaveBeenCalled();
  };

  it("piano senza feed: il feed acceso ieri non serve piu' nulla oggi", async () => {
    // Il caso che il vecchio codice non vedeva affatto: qui non si guardava
    // nemmeno il piano. Chi scendeva di piano continuava a farsi servire il
    // catalogo a tempo indeterminato.
    findFirstPlan.mockResolvedValue({
      planName: 'basic',
      customersSyncEnabled: false,
      productFeedsEnabled: false,
    });
    await nonSiServe();
  });

  it("uso dell'app sospeso: il catalogo non esce", async () => {
    negozioSano({ authorization: 'DISABLED' });
    await nonSiServe();
  });

  it('trial finito (PENDING): il catalogo non esce', async () => {
    negozioSano({ authorization: 'PENDING' });
    await nonSiServe();
  });

  it('app disinstallata: il catalogo non esce', async () => {
    // Il piu' grave dei tre. Chi disinstalla non revoca il token del feed —
    // quel token non lo vede nemmeno — e l'indirizzo restava vivo per sempre.
    negozioSano({ uninstalledAt: new Date('2026-05-01T00:00:00Z') });
    await nonSiServe();
  });

  it('progetto scollegato: il catalogo non esce', async () => {
    negozioSano({ supabaseConfig: null });
    await nonSiServe();
  });

  it('valore inatteso nella colonna: in dubbio si nega', async () => {
    // La colonna la scrive l'owner a mano. Un refuso non deve regalare il
    // catalogo proprio al negozio che si voleva fermare.
    negozioSano({ authorization: 'DISABLD' });
    await nonSiServe();
  });

  it('negozio sparito dal database: il catalogo non esce', async () => {
    findUniqueShop.mockResolvedValue(null);
    await nonSiServe();
  });

  it('feed spento: come prima', async () => {
    findUniqueFeed.mockResolvedValue({ shopId: 'shop-1', enabled: false, platform: 'meta' });
    await nonSiServe();
  });

  it('token che non corrisponde a nessun feed: come prima', async () => {
    findUniqueFeed.mockResolvedValue(null);
    await nonSiServe();
  });
});

describe('feed — nessun legame con il tetto dei prodotti', () => {
  it('il codice che genera i feed non legge maxProducts', async () => {
    // Il tetto del piano vale per la sincronizzazione dei prodotti, non per i
    // feed: se un giorno qualcuno lo portasse qui, un merchant con i feed inclusi
    // si vedrebbe servire meta' catalogo senza che niente lo dica.
    const { readFileSync, readdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const root = resolve(__dirname, '..');
    const files = [
      ...readdirSync(resolve(root, 'lib/feeds'))
        .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
        .map((f) => resolve(root, 'lib/feeds', f)),
      resolve(root, 'routes/feed.$file.tsx'),
      ...readdirSync(resolve(root, 'routes'))
        .filter((f) => f.startsWith('catalogs') && !f.includes('.test.'))
        .map((f) => resolve(root, 'routes', f)),
    ];
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      expect(code, file).not.toMatch(/maxProducts|max_products|limitProducts|product-limit/);
    }
  });
});
