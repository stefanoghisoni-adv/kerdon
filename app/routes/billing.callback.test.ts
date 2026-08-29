// app/routes/billing.callback.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const updateShop = vi.fn();
const findPlanMock = vi.fn();
const updateManyCharges = vi.fn();

const getSubscription = vi.fn();
const getActiveSubscriptions = vi.fn();
const cancelAppSubscription = vi.fn();

const admin = { graphql: vi.fn() };

// La sessione offline, come la usa la rotta: nessun token embedded, perche' al
// ritorno dal pagamento il browser e' di primo livello e non ne ha uno.
vi.mock('~/shopify.server', () => ({
  unauthenticated: {
    admin: async (shop: string) => ({ session: { shop }, admin }),
  },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      findUnique: (...a: unknown[]) => findUniqueShop(...a),
      update: (...a: unknown[]) => updateShop(...a),
    },
    plan: { findFirst: (...a: unknown[]) => findPlanMock(...a) },
    billingCharge: { updateMany: (...a: unknown[]) => updateManyCharges(...a) },
    // Le scritture della callback vivono in una transazione: il finto
    // `$transaction` consegna un client che punta agli stessi spy, cosi' le
    // verifiche vedono cosa e' stato scritto senza dover sapere per quale
    // strada ci e' arrivato.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        shop: {
          // `applyPlanToShop` rilegge il negozio dentro la transazione prima di
          // scriverlo: senza questa, la transazione lanciava e la callback
          // finiva nel catch, rispondendo 'ko' a un pagamento andato a buon fine.
          findUnique: (...a: unknown[]) => findUniqueShop(...a),
          update: (...a: unknown[]) => updateShop(...a),
        },
        billingCharge: { updateMany: (...a: unknown[]) => updateManyCharges(...a) },
      }),
  },
}));
vi.mock('~/lib/billing/subscription.server', async () => {
  const actual = await vi.importActual<typeof import('~/lib/billing/subscription.server')>(
    '~/lib/billing/subscription.server',
  );
  return {
    // parseGidId resta quello vero: e' pura conversione di formato.
    parseGidId: actual.parseGidId,
    getSubscription: (...a: unknown[]) => getSubscription(...a),
    getActiveSubscriptions: (...a: unknown[]) => getActiveSubscriptions(...a),
    cancelAppSubscription: (...a: unknown[]) => cancelAppSubscription(...a),
  };
});

import { loader } from './billing.callback';

const SHOP = {
  id: 'shop-1',
  shopDomain: 'test-shop.myshopify.com',
  currentPlan: 'Free',
  activeChargeId: null as string | null,
  authorization: 'ENABLED',
  trackingAuthorization: 'ENABLED',
};

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    gid: 'gid://shopify/AppSubscription/1234',
    name: 'Pro',
    status: 'ACTIVE',
    test: false,
    trialDays: 7,
    currentPeriodEnd: '2026-09-03T10:00:00Z',
    priceAmount: 29,
    ...overrides,
  };
}

function call(query = '?charge_id=1234&shop=test-shop.myshopify.com') {
  const request = new Request(`https://app.example.com/billing/callback${query}`);
  return loader({ request, params: {}, context: {} } as any) as Promise<Response>;
}

/** Esito e contesto embedded del rimando alla tab Piano. */
function location(res: Response): URL {
  return new URL(res.headers.get('location') ?? '', 'https://app.example.com');
}

describe('/billing/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueShop.mockResolvedValue({ ...SHOP });
    findPlanMock.mockResolvedValue({ planName: 'Pro', priceMonthly: 29, trialDays: 7 });
    getActiveSubscriptions.mockResolvedValue([]);
  });

  it('senza charge_id valido non interroga Shopify e torna con esito negativo', async () => {
    const res = await call('?shop=test-shop.myshopify.com');
    expect(getSubscription).not.toHaveBeenCalled();
    expect(updateShop).not.toHaveBeenCalled();
    expect(location(res).searchParams.get('billing')).toBe('ko');
  });

  it('abbonamento rifiutato: addebito segnato e piano invariato', async () => {
    getSubscription.mockResolvedValue(subscription({ status: 'DECLINED' }));

    const res = await call();

    expect(updateManyCharges).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: 'shop-1', shopifyChargeId: 1234n },
        data: expect.objectContaining({ status: 'declined' }),
      }),
    );
    expect(updateShop).not.toHaveBeenCalled();
    expect(location(res).searchParams.get('billing')).toBe('ko');
  });

  it('abbonamento ancora in attesa: non cambia nulla', async () => {
    getSubscription.mockResolvedValue(subscription({ status: 'PENDING' }));

    const res = await call();

    expect(updateManyCharges).not.toHaveBeenCalled();
    expect(updateShop).not.toHaveBeenCalled();
    expect(location(res).searchParams.get('billing')).toBe('ko');
  });

  it('abbonamento sconosciuto a Shopify: nessuna attivazione', async () => {
    getSubscription.mockResolvedValue(null);

    const res = await call('?charge_id=999999&shop=test-shop.myshopify.com');

    expect(updateShop).not.toHaveBeenCalled();
    expect(location(res).searchParams.get('billing')).toBe('ko');
  });

  it('abbonamento attivo con un nome fuori dal listino: nessuna attivazione', async () => {
    getSubscription.mockResolvedValue(subscription({ name: 'Piano Altrui' }));
    findPlanMock.mockResolvedValue(null);

    const res = await call();

    expect(updateShop).not.toHaveBeenCalled();
    expect(location(res).searchParams.get('billing')).toBe('ko');
  });

  it('abbonamento attivo: aggiorna addebito e piano, e chiude il precedente', async () => {
    getSubscription.mockResolvedValue(subscription());
    getActiveSubscriptions.mockResolvedValue([
      subscription(),
      subscription({ gid: 'gid://shopify/AppSubscription/9876', name: 'Business' }),
    ]);

    const res = await call();

    expect(updateManyCharges).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: 'shop-1', shopifyChargeId: 1234n },
        data: expect.objectContaining({ status: 'active', trialDays: 7 }),
      }),
    );
    expect(updateShop).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'shop-1' },
        data: expect.objectContaining({
          currentPlan: 'Pro',
          activeChargeId: '1234',
          billingCycle: 'monthly',
          isInTrial: true,
        }),
      }),
    );
    // Solo il precedente viene chiuso: quello appena confermato resta.
    expect(cancelAppSubscription).toHaveBeenCalledTimes(1);
    expect(cancelAppSubscription).toHaveBeenCalledWith(
      admin,
      'gid://shopify/AppSubscription/9876',
    );
    expect(updateManyCharges).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: 'shop-1', shopifyChargeId: 9876n },
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    );
    expect(location(res).searchParams.get('billing')).toBe('ok');
  });

  it('si rientra dall admin, non dall indirizzo dell app', async () => {
    // Al ritorno dal pagamento il browser e' di primo livello: mandarlo su una
    // rotta dell'app significa chiedergli di rientrare da solo nel riquadro, ed
    // e' quel giro che lasciava una pagina bianca dopo aver pagato.
    process.env.SHOPIFY_API_KEY = 'chiave-app';
    getSubscription.mockResolvedValue(subscription());

    const url = location(
      await call('?charge_id=1234&shop=test-shop.myshopify.com&return_to=dashboard'),
    );

    expect(url.origin).toBe('https://admin.shopify.com');
    expect(url.pathname).toBe('/store/test-shop/apps/chiave-app');
    expect(url.searchParams.get('billing')).toBe('ok');
    delete process.env.SHOPIFY_API_KEY;
  });

  it('si torna sempre in dashboard, senza sotto-percorso dopo l id dell app', async () => {
    // Con /plan in coda il riquadro si apriva vuoto: niente contenuto, nemmeno
    // il menu, e l'unico modo di uscirne era ricaricare la pagina intera. Dopo
    // aver pagato. Senza sotto-percorso l'indirizzo e' quello canonico con cui
    // l'admin apre un'app.
    process.env.SHOPIFY_API_KEY = 'chiave-app';
    getSubscription.mockResolvedValue(subscription());

    const url = location(await call());

    expect(url.pathname).toBe('/store/test-shop/apps/chiave-app');
    expect(url.searchParams.get('billing')).toBe('ok');
    delete process.env.SHOPIFY_API_KEY;
  });

  it('senza la chiave dell app resta la via diretta, con il contesto embedded', async () => {
    getSubscription.mockResolvedValue(subscription());

    const url = location(await call());

    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('shop')).toBe('test-shop.myshopify.com');
    expect(url.searchParams.get('embedded')).toBe('1');
    expect(
      Buffer.from(url.searchParams.get('host') ?? '', 'base64').toString('utf8'),
    ).toBe('admin.shopify.com/store/test-shop');
  });

  it('un return_to inventato non sposta la destinazione', async () => {
    // La destinazione la decide questo file: un indirizzo preso dalla
    // querystring sarebbe un rimando aperto.
    getSubscription.mockResolvedValue(subscription());

    const url = location(
      await call('?charge_id=1234&shop=test-shop.myshopify.com&return_to=https://evil.example'),
    );

    expect(url.pathname).toBe('/');
    expect(url.origin).not.toBe('https://evil.example');
  });

  it('la chiusura del precedente non annulla l attivazione appena registrata', async () => {
    getSubscription.mockResolvedValue(subscription());
    getActiveSubscriptions.mockRejectedValue(new Error('rete'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await call();

    expect(updateShop).toHaveBeenCalled();
    expect(location(res).searchParams.get('billing')).toBe('ok');
    warnSpy.mockRestore();
  });

  it('guasto nella verifica: piano invariato ed esito negativo', async () => {
    getSubscription.mockRejectedValue(new Error('boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await call();

    expect(updateShop).not.toHaveBeenCalled();
    expect(location(res).searchParams.get('billing')).toBe('ko');
    errorSpy.mockRestore();
  });
});

describe('il ritorno dal pagamento non passa da una sessione embedded', () => {
  it('senza un negozio valido nella querystring non si costruisce nessun client', async () => {
    // Il negozio arriva dalla URL, quindi da fuori: quello che non e' un
    // dominio myshopify non deve nemmeno arrivare a Shopify.
    for (const shop of ['', 'non-un-dominio', 'evil.example.com', '../x.myshopify.com']) {
      const res = await call(`?charge_id=1234&shop=${encodeURIComponent(shop)}`);
      expect(location(res).searchParams.get('billing')).toBe('ko');
    }
  });

  it('il negozio su cui si lavora e quello scritto nella querystring', async () => {
    // Prima veniva dalla sessione embedded. Ora arriva dalla URL, ed e' il
    // valore su cui si apre la sessione offline: se i due divergessero, si
    // attiverebbe un piano sul negozio sbagliato.
    getSubscription.mockResolvedValue(subscription());
    updateShop.mockClear();

    await call('?charge_id=1234&shop=test-shop.myshopify.com');

    expect(findUniqueShop).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopDomain: 'test-shop.myshopify.com' } }),
    );
  });
});
