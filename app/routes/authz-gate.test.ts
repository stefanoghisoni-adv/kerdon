import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Il rilievo, provato dov'e' nato: sulle rotte vere.
 *
 * Il difetto non era che la dashboard mostrasse troppo — era che le rotte sotto
 * rispondevano a chiunque avesse una sessione di amministratore, senza mai
 * chiedere se quel negozio potesse ancora usare l'app. Un negozio con la prova
 * finita, sospeso, o con la cancellazione GDPR gia' cominciata continuava a
 * leggersi i propri clienti — nomi, email, quanto hanno speso — digitando
 * l'indirizzo.
 *
 * La promessa che questi test tengono ferma non e' "risponde 403": e' che al
 * momento del rifiuto il database del merchant e Shopify NON SIANO ANCORA
 * STATI TOCCATI. Un controllo messo dopo la lettura nasconde una cosa che e'
 * gia' successa.
 */

const findUniqueShop = vi.fn();
const findFirstPlan = vi.fn();
const updateShop = vi.fn();
const forShop = vi.fn();
const loadCustomersReport = vi.fn();
const loadShopProfit = vi.fn();
const loadShopAverages = vi.fn();
const getCustomerStatsCache = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'negozio.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      findUnique: (...a: unknown[]) => findUniqueShop(...a),
      update: (...a: unknown[]) => updateShop(...a),
    },
    plan: { findFirst: (...a: unknown[]) => findFirstPlan(...a), findMany: async () => [] },
    planPrice: { findMany: async () => [] },
  },
}));
vi.mock('~/lib/shopify-api.server', () => ({
  ShopifyAPIClient: { forShop: (...a: unknown[]) => forShop(...a) },
}));
vi.mock('~/lib/customers/customers.server', () => ({
  loadCustomersReport: (...a: unknown[]) => loadCustomersReport(...a),
}));
vi.mock('~/lib/customers/profit.server', () => ({
  loadShopProfit: (...a: unknown[]) => loadShopProfit(...a),
  loadShopAverages: (...a: unknown[]) => loadShopAverages(...a),
}));
vi.mock('~/lib/cache/stats-cache.server', () => ({
  getCustomerStatsCache: (...a: unknown[]) => getCustomerStatsCache(...a),
  setCustomerStatsCache: async () => undefined,
  getReadinessCache: async () => null,
  setReadinessCache: async () => undefined,
}));
vi.mock('~/lib/setup/require-setup.server', () => ({
  requireSetupComplete: async () => undefined,
}));

import { loader as statsClienti } from './api.stats.customers';
import { loader as statsProfitto } from './api.stats.profit';
import { loader as paginaClienti, action as azioneClienti } from './customers';
import { it as dizionario } from '~/lib/i18n/it';

/** Un negozio che puo' usare l'app. Da qui si toglie un fatto alla volta. */
const ATTIVO = {
  id: 'negozio-1',
  shopDomain: 'negozio.myshopify.com',
  currentPlan: 'growth',
  ianaTimezone: 'Europe/Rome',
  birthdateMetafieldNamespace: null,
  birthdateMetafieldKey: null,
  lifecycleStatus: 'active',
  uninstalledAt: null,
  authorization: 'ENABLED',
  trackingAuthorization: 'ENABLED',
  scopes: 'read_products,read_customers',
  isInTrial: false,
  trialEndsAt: null,
  activeChargeId: null,
  locale: 'it',
  detectedLocale: 'it',
  supabaseConfig: { connectionVerifiedAt: new Date('2026-01-01T00:00:00.000Z') },
};

/** I tre stati in cui un negozio non deve leggere piu' niente. */
const FERMI = {
  'prova finita': {
    ...ATTIVO,
    isInTrial: true,
    trialEndsAt: new Date('2020-01-01T00:00:00.000Z'),
  },
  sospeso: { ...ATTIVO, authorization: 'DISABLED' },
  'cancellazione in corso': { ...ATTIVO, lifecycleStatus: 'erasing' },
} as const;

const chiamata = (loader: (args: never) => unknown, url: string, method = 'GET') =>
  loader({
    request: new Request(url, method === 'GET' ? undefined : { method, body: new FormData() }),
    params: {},
    context: {},
  } as never) as Promise<Response>;

const rifiuto = async (promessa: Promise<Response>): Promise<Response> =>
  (await promessa.catch((e) => e)) as Response;

beforeEach(() => {
  vi.clearAllMocks();
  findFirstPlan.mockResolvedValue({
    planName: 'growth',
    customersSyncEnabled: true,
    productFeedsEnabled: true,
  });
  getCustomerStatsCache.mockResolvedValue({ totalCustomers: 3, optIn: 2, optOut: 1 });
  loadCustomersReport.mockResolvedValue({ rows: [], currency: 'EUR' });
  loadShopProfit.mockResolvedValue({ profit: 1, orders: 1, change: null });
  loadShopAverages.mockResolvedValue({ aov: 1 });
  forShop.mockResolvedValue({
    getCustomers: async () => ({ customers: [], nextPageInfo: null }),
    listCustomerMetafieldDefinitions: async () => [],
  });
});

describe.each(Object.entries(FERMI))('negozio con %s', (_stato, negozio) => {
  beforeEach(() => findUniqueShop.mockResolvedValue(negozio));

  it('le statistiche dei clienti rifiutano, e Shopify non viene chiamata', async () => {
    const risposta = await rifiuto(
      chiamata(statsClienti, 'https://app/api/stats/customers'),
    );

    expect(risposta.status).toBe(403);
    expect(forShop).not.toHaveBeenCalled();
    // Nemmeno la cache: anche l'ultimo numero noto e' un dato del negozio.
    expect(getCustomerStatsCache).not.toHaveBeenCalled();
  });

  it('il profitto rifiuta senza aprire il database del merchant', async () => {
    const risposta = await rifiuto(
      chiamata(statsProfitto, 'https://app/api/stats/profit?from=2026-01-01&to=2026-01-31'),
    );

    expect(risposta.status).toBe(403);
    expect(loadShopProfit).not.toHaveBeenCalled();
    expect(loadShopAverages).not.toHaveBeenCalled();
  });

  it('la pagina Clienti non legge nessuna riga e riporta alla dashboard', async () => {
    const risposta = await rifiuto(chiamata(paginaClienti, 'https://app/customers'));

    expect(risposta.status).toBe(302);
    expect(risposta.headers.get('Location')).toBe('/');
    expect(loadCustomersReport).not.toHaveBeenCalled();
    expect(forShop).not.toHaveBeenCalled();
  });

  it('la data di nascita non si puo piu riconfigurare', async () => {
    const risposta = await rifiuto(
      chiamata(azioneClienti, 'https://app/customers', 'POST'),
    );

    expect(risposta.status).toBe(403);
    expect(updateShop).not.toHaveBeenCalled();
    expect(forShop).not.toHaveBeenCalled();
  });
});

describe('che cosa legge il merchant', () => {
  it('prova finita: gli si dice di aggiornare il piano, non un errore tecnico', async () => {
    findUniqueShop.mockResolvedValue(FERMI['prova finita']);

    const risposta = await rifiuto(
      chiamata(statsClienti, 'https://app/api/stats/customers'),
    );

    expect(await risposta.json()).toEqual({
      error: dizionario.errors.trialEnded,
      code: 'trial_expired',
    });
  });

  it('cancellazione in corso: la frase e sua, e non parla di sospensione', async () => {
    findUniqueShop.mockResolvedValue(FERMI['cancellazione in corso']);

    const risposta = await rifiuto(
      chiamata(statsClienti, 'https://app/api/stats/customers'),
    );

    expect(await risposta.json()).toEqual({
      error: dizionario.errors.erasureInProgress,
      code: 'erasing',
    });
  });
});

describe('negozio attivo', () => {
  beforeEach(() => findUniqueShop.mockResolvedValue(ATTIVO));

  it('le statistiche dei clienti rispondono', async () => {
    const risposta = await chiamata(statsClienti, 'https://app/api/stats/customers');

    expect(risposta.status).toBe(200);
    expect(await risposta.json()).toMatchObject({ enabled: true, totalCustomers: 3 });
  });

  it('la pagina Clienti legge le righe', async () => {
    const risposta = await chiamata(paginaClienti, 'https://app/customers');

    expect(risposta.status).toBe(200);
    expect(loadCustomersReport).toHaveBeenCalled();
  });
});
