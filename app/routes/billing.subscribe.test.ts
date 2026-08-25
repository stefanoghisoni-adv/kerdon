// app/routes/billing.subscribe.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const updateShop = vi.fn();
const findPlanMock = vi.fn();
const findManyPlans = vi.fn();
const findManyPlanPrices = vi.fn();

/** La riga di listino in valuta base: senza, un piano non ha prezzo. */
const USD_PRO = { planName: 'Pro', currency: 'USD', priceMonthly: 29, priceYearly: 290 };
const createCharge = vi.fn();
const updateManyCharges = vi.fn();

const isDevelopmentStore = vi.fn();
const createAppSubscription = vi.fn();
const cancelAppSubscription = vi.fn();

const admin = { graphql: vi.fn() };

vi.mock('~/shopify.server', () => ({
  authenticate: {
    admin: async () => ({ session: { shop: 'test-shop.myshopify.com' }, admin }),
  },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      findUnique: (...a: unknown[]) => findUniqueShop(...a),
      update: (...a: unknown[]) => updateShop(...a),
    },
    plan: {
      findFirst: (...a: unknown[]) => findPlanMock(...a),
      findMany: (...a: unknown[]) => findManyPlans(...a),
    },
    planPrice: { findMany: (...a: unknown[]) => findManyPlanPrices(...a) },
    billingCharge: {
      create: (...a: unknown[]) => createCharge(...a),
      updateMany: (...a: unknown[]) => updateManyCharges(...a),
    },
  },
}));
vi.mock('~/lib/billing/subscription.server', () => ({
  isDevelopmentStore: (...a: unknown[]) => isDevelopmentStore(...a),
  createAppSubscription: (...a: unknown[]) => createAppSubscription(...a),
  cancelAppSubscription: (...a: unknown[]) => cancelAppSubscription(...a),
}));

import { action } from './billing.subscribe';

const SHOP = {
  id: 'shop-1',
  shopDomain: 'test-shop.myshopify.com',
  currentPlan: 'Free',
  activeChargeId: null as string | null,
  authorization: 'ENABLED',
  trackingAuthorization: 'ENABLED',
  // I messaggi d'errore escono nella lingua del negozio: qui l'italiano, cosi'
  // i test leggono quello che leggerebbe questo merchant.
  locale: 'it',
  detectedLocale: null,
};

function call(plan: string | null, opts: { method?: string; url?: string } = {}) {
  const body = new URLSearchParams();
  if (plan !== null) body.set('plan', plan);
  const request = new Request(opts.url ?? 'https://app.example.com/billing/subscribe', {
    method: opts.method ?? 'POST',
    body: opts.method && opts.method !== 'POST' ? undefined : body,
  });
  return action({ request, params: {}, context: {} } as any);
}

describe('/billing/subscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_APP_URL = 'https://app.example.com';
    delete process.env.SHOPIFY_BILLING_TEST;
    findUniqueShop.mockResolvedValue({ ...SHOP });
    isDevelopmentStore.mockResolvedValue(false);
    // Senza listino in altre valute si addebita nella valuta base, che e'
    // quella della scheda dell'App Store: e' il caso normale, e quello che
    // quasi tutti i test qui sotto raccontano.
    findManyPlans.mockResolvedValue([{ planName: 'Pro' }]);
    // Il listino sta tutto qui dentro, dollaro compreso: sul piano i prezzi non
    // ci sono piu'.
    findManyPlanPrices.mockResolvedValue([USD_PRO]);
  });

  it('il messaggio arriva nella lingua del merchant', async () => {
    // Stesso errore, negozio con l'admin in inglese: e' un testo che finisce in
    // un banner davanti a lui, non un log.
    findUniqueShop.mockResolvedValue({ ...SHOP, locale: null, detectedLocale: 'en' });
    findPlanMock.mockResolvedValue(null);

    const res = await call('Inesistente');

    expect(await res.json()).toEqual({ error: 'The plan you picked isn’t available.' });
  });

  it('metodo diverso da POST → 405', async () => {
    const res = await call(null, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('negozio bloccato dall owner → 403 e nessun addebito', async () => {
    findUniqueShop.mockResolvedValue({ ...SHOP, authorization: 'DISABLED' });
    const res = await call('Pro');
    expect(res.status).toBe(403);
    expect(createAppSubscription).not.toHaveBeenCalled();
  });

  it('piano interno senza acquisti (lifetime) → 403', async () => {
    findUniqueShop.mockResolvedValue({ ...SHOP, currentPlan: 'lifetime' });
    const res = await call('Pro');
    expect(res.status).toBe(403);
    expect(findPlanMock).not.toHaveBeenCalled();
  });

  it('piano inesistente → 400 con messaggio per il merchant', async () => {
    findPlanMock.mockResolvedValue(null);
    const res = await call('Inventato');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Il piano scelto non è disponibile.' });
  });

  it('piano non acquistabile → 400', async () => {
    findPlanMock.mockResolvedValue({ planName: 'lifetime', priceMonthly: 0, trialDays: null });
    const res = await call('lifetime');
    expect(res.status).toBe(400);
    expect(createAppSubscription).not.toHaveBeenCalled();
  });

  it('piano gia attuale → 400', async () => {
    findPlanMock.mockResolvedValue({ planName: 'Free', priceMonthly: 0, trialDays: 7 });
    const res = await call('Free');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Stai già usando questo piano.' });
  });

  it('piano gratuito: cancella l abbonamento in corso e applica subito il piano', async () => {
    findUniqueShop.mockResolvedValue({ ...SHOP, currentPlan: 'Pro', activeChargeId: '9876' });
    findPlanMock.mockResolvedValue({ planName: 'Free', priceMonthly: 0, trialDays: null });
    // Free sta nel listino come tutti gli altri, con la sua riga a zero: e' da
    // li' che si sa quanto costa, e zero e' un prezzo scritto, non un'assenza.
    findManyPlans.mockResolvedValue([{ planName: 'Pro' }, { planName: 'Free' }]);
    findManyPlanPrices.mockResolvedValue([
      USD_PRO,
      { planName: 'Free', currency: 'USD', priceMonthly: 0, priceYearly: 0 },
    ]);

    const res = await call('Free');

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
    expect(updateShop).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'shop-1' },
        data: expect.objectContaining({ currentPlan: 'Free', activeChargeId: null }),
      }),
    );
    expect(createAppSubscription).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ ok: true });
  });

  it('piano a pagamento: restituisce confirmationUrl e registra l addebito in attesa', async () => {
    findPlanMock.mockResolvedValue({ planName: 'Pro', priceMonthly: 29, trialDays: 7 });
    createAppSubscription.mockResolvedValue({
      confirmationUrl: 'https://shopify/confirm/1',
      subscriptionGid: 'gid://shopify/AppSubscription/1234',
      chargeId: 1234n,
    });

    const res = await call('Pro');

    expect(await res.json()).toEqual({ confirmationUrl: 'https://shopify/confirm/1' });
    expect(createCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shopId: 'shop-1',
          shopifyChargeId: 1234n,
          planType: 'Pro',
          status: 'pending',
          billingCycle: 'monthly',
          trialDays: 7,
          confirmationUrl: 'https://shopify/confirm/1',
        }),
      }),
    );
    // Il piano NON si applica qui: l'addebito e' solo proposto.
    expect(updateShop).not.toHaveBeenCalled();
  });

  it('l URL di ritorno rientra nel contesto embedded', async () => {
    findPlanMock.mockResolvedValue({ planName: 'Pro', priceMonthly: 29, trialDays: 7 });
    createAppSubscription.mockResolvedValue({
      confirmationUrl: 'https://shopify/confirm/1',
      subscriptionGid: 'gid://shopify/AppSubscription/1234',
      chargeId: 1234n,
    });

    await call('Pro');

    const returnUrl = new URL(createAppSubscription.mock.calls[0][1].returnUrl);
    expect(returnUrl.origin).toBe('https://app.example.com');
    expect(returnUrl.pathname).toBe('/billing/callback');
    expect(returnUrl.searchParams.get('shop')).toBe('test-shop.myshopify.com');
    expect(returnUrl.searchParams.get('embedded')).toBe('1');
    expect(
      Buffer.from(returnUrl.searchParams.get('host') ?? '', 'base64').toString('utf8'),
    ).toBe('admin.shopify.com/store/test-shop');
  });

  it('il negozio paga nella valuta che ha scelto, se il listino esiste', async () => {
    // La valuta segue il mercato scelto nel selettore in alto: lingua e valuta
    // sono la stessa scelta.
    findUniqueShop.mockResolvedValue({ ...SHOP, locale: 'en-GB' });
    findPlanMock.mockResolvedValue({ planName: 'Pro', priceMonthly: 29, trialDays: 7 });
    findManyPlanPrices.mockResolvedValue([
      USD_PRO,
      { planName: 'Pro', currency: 'GBP', priceMonthly: 32, priceYearly: 320 },
    ]);
    createAppSubscription.mockResolvedValue({
      confirmationUrl: 'https://shopify/confirm/1',
      subscriptionGid: 'gid://shopify/AppSubscription/1234',
      chargeId: 1234n,
    });

    await call('Pro');

    // Prezzo e valuta insieme: e' la coppia che il merchant ha letto sulla card.
    expect(createAppSubscription.mock.calls[0][1].currency).toBe('GBP');
    expect(createAppSubscription.mock.calls[0][1].price).toBe(32);
  });

  it('senza listino nella sua valuta si addebita nella valuta base, non un prezzo inventato', async () => {
    findUniqueShop.mockResolvedValue({ ...SHOP, locale: 'en-GB' });
    findPlanMock.mockResolvedValue({ planName: 'Pro', priceMonthly: 29, trialDays: 7 });
    findManyPlanPrices.mockResolvedValue([USD_PRO]);
    createAppSubscription.mockResolvedValue({
      confirmationUrl: 'https://shopify/confirm/1',
      subscriptionGid: 'gid://shopify/AppSubscription/1234',
      chargeId: 1234n,
    });

    await call('Pro');

    expect(createAppSubscription.mock.calls[0][1].currency).toBe('USD');
    expect(createAppSubscription.mock.calls[0][1].price).toBe(29);
  });

  it('negozio di sviluppo: addebito di prova', async () => {
    isDevelopmentStore.mockResolvedValue(true);
    findPlanMock.mockResolvedValue({ planName: 'Pro', priceMonthly: 29, trialDays: 7 });
    createAppSubscription.mockResolvedValue({
      confirmationUrl: 'https://shopify/confirm/1',
      subscriptionGid: 'gid://shopify/AppSubscription/1234',
      chargeId: 1234n,
    });

    await call('Pro');

    expect(createAppSubscription.mock.calls[0][1].test).toBe(true);
  });

  it('SHOPIFY_BILLING_TEST=true: addebito di prova anche fuori dai negozi di sviluppo', async () => {
    process.env.SHOPIFY_BILLING_TEST = 'true';
    isDevelopmentStore.mockResolvedValue(false);
    findPlanMock.mockResolvedValue({ planName: 'Pro', priceMonthly: 29, trialDays: 7 });
    createAppSubscription.mockResolvedValue({
      confirmationUrl: 'https://shopify/confirm/1',
      subscriptionGid: 'gid://shopify/AppSubscription/1234',
      chargeId: 1234n,
    });

    await call('Pro');

    expect(createAppSubscription.mock.calls[0][1].test).toBe(true);
    // Interruttore acceso: non serve nemmeno chiedere a Shopify che negozio e'.
    expect(isDevelopmentStore).not.toHaveBeenCalled();
  });

  it('SHOPIFY_BILLING_TEST con un valore diverso da true: addebito reale', async () => {
    process.env.SHOPIFY_BILLING_TEST = '1';
    isDevelopmentStore.mockResolvedValue(false);
    findPlanMock.mockResolvedValue({ planName: 'Pro', priceMonthly: 29, trialDays: 7 });
    createAppSubscription.mockResolvedValue({
      confirmationUrl: 'https://shopify/confirm/1',
      subscriptionGid: 'gid://shopify/AppSubscription/1234',
      chargeId: 1234n,
    });

    await call('Pro');

    expect(createAppSubscription.mock.calls[0][1].test).toBe(false);
  });

  it('stesso piano scritto con altre maiuscole → nessun cambio da fare', async () => {
    // Il listino e' stato rinominato dopo l'attivazione: shops.current_plan dice
    // "Free", il merchant chiede "free". E' lo stesso piano.
    findPlanMock.mockResolvedValue({ planName: 'Free', priceMonthly: 0, trialDays: null });

    const res = await call('free');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Stai già usando questo piano.' });
    expect(createAppSubscription).not.toHaveBeenCalled();
  });

  it('guasto su Shopify → 500 senza dettagli tecnici', async () => {
    findPlanMock.mockResolvedValue({ planName: 'Pro', priceMonthly: 29, trialDays: 7 });
    createAppSubscription.mockRejectedValue(new Error('appSubscriptionCreate: boom'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await call('Pro');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'Non è stato possibile avviare il cambio di piano. Riprova.',
    });
    errorSpy.mockRestore();
  });
});
