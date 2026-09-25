import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import {
  cancelAppSubscription,
  createAppSubscription,
  getActiveSubscriptions,
  getSubscription,
  isDevelopmentStore,
  parseGidId,
  type BillingAdmin,
} from './subscription.server';

// admin.graphql restituisce una Response vera: mockarla cosi' tiene i test
// aderenti al client reale (json() asincrono, body serializzato).
function adminWith(...payloads: unknown[]): BillingAdmin & { graphql: ReturnType<typeof vi.fn> } {
  const graphql = vi.fn();
  for (const payload of payloads) {
    graphql.mockResolvedValueOnce(new Response(JSON.stringify(payload)));
  }
  return { graphql };
}

/** Le variabili passate alla n-esima chiamata di graphql. */
function variablesOf(
  admin: { graphql: ReturnType<typeof vi.fn> },
  call = 0,
): Record<string, unknown> {
  return admin.graphql.mock.calls[call][1]?.variables ?? {};
}

const SUB_GID = 'gid://shopify/AppSubscription/1234';

function rawSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: SUB_GID,
    name: 'Growth',
    status: 'ACTIVE',
    test: false,
    createdAt: '2026-08-01T10:00:00Z',
    currentPeriodEnd: '2026-08-31T10:00:00Z',
    trialDays: 7,
    lineItems: [
      {
        plan: {
          pricingDetails: {
            price: { amount: '29.00', currencyCode: 'EUR' },
            interval: 'EVERY_30_DAYS',
          },
        },
      },
    ],
    ...overrides,
  };
}

describe('parseGidId', () => {
  it('estrae la parte numerica da un gid valido', () => {
    expect(parseGidId(SUB_GID)).toBe(1234n);
  });

  it('ignora la query string finale', () => {
    expect(parseGidId('gid://shopify/AppSubscription/99?foo=bar')).toBe(99n);
  });

  it('lancia sui gid malformati', () => {
    expect(() => parseGidId('gid://shopify/AppSubscription/abc')).toThrow(/non valido/);
    expect(() => parseGidId('1234')).toThrow(/non valido/);
    expect(() => parseGidId('')).toThrow(/non valido/);
  });
});

describe('isDevelopmentStore', () => {
  it('true quando partnerDevelopment e\' true', async () => {
    const admin = adminWith({ data: { shop: { plan: { partnerDevelopment: true } } } });
    expect(await isDevelopmentStore(admin)).toBe(true);
  });

  it('false quando partnerDevelopment e\' false', async () => {
    const admin = adminWith({ data: { shop: { plan: { partnerDevelopment: false } } } });
    expect(await isDevelopmentStore(admin)).toBe(false);
  });

  it('false quando il campo manca del tutto', async () => {
    const admin = adminWith({ data: { shop: { plan: {} } } });
    expect(await isDevelopmentStore(admin)).toBe(false);
  });
});

describe('createAppSubscription', () => {
  const okPayload = {
    data: {
      appSubscriptionCreate: {
        confirmationUrl: 'https://negozio.myshopify.com/admin/charges/1234/confirm',
        appSubscription: { id: SUB_GID, status: 'PENDING' },
        userErrors: [],
      },
    },
  };

  it('costruisce le variabili della mutation e restituisce chargeId numerico', async () => {
    const admin = adminWith(okPayload);
    const result = await createAppSubscription(admin, {
      planName: 'Growth',
      price: 29,
      currency: 'EUR',
      interval: 'monthly',
      trialDays: 7,
      returnUrl: 'https://app.example.com/billing/callback?plan=Growth',
      test: false,
    });

    const variables = variablesOf(admin);
    expect(variables.name).toBe('Growth');
    expect(variables.returnUrl).toBe('https://app.example.com/billing/callback?plan=Growth');
    expect(variables.test).toBe(false);
    expect(variables.trialDays).toBe(7);
    expect(variables.lineItems).toEqual([
      {
        plan: {
          appRecurringPricingDetails: {
            price: { amount: '29.00', currencyCode: 'EUR' },
            interval: 'EVERY_30_DAYS',
          },
        },
      },
    ]);

    expect(result).toEqual({
      confirmationUrl: 'https://negozio.myshopify.com/admin/charges/1234/confirm',
      subscriptionGid: SUB_GID,
      chargeId: 1234n,
    });
  });

  it('omette trialDays quando il piano non prevede prova', async () => {
    const admin = adminWith(okPayload);
    await createAppSubscription(admin, {
      planName: 'Starter',
      price: 9.9,
      currency: 'EUR',
      interval: 'monthly',
      trialDays: null,
      returnUrl: 'https://app.example.com/billing/callback',
      test: true,
    });

    const variables = variablesOf(admin);
    expect(variables).not.toHaveProperty('trialDays');
    expect(variables.test).toBe(true);
    // I centesimi non devono perdersi: l'importo viaggia come stringa Decimal.
    expect(
      (variables.lineItems as { plan: { appRecurringPricingDetails: { price: { amount: string } } } }[])[0]
        .plan.appRecurringPricingDetails.price.amount,
    ).toBe('9.90');
  });

  it('lancia aggregando i userErrors', async () => {
    const admin = adminWith({
      data: {
        appSubscriptionCreate: {
          confirmationUrl: null,
          appSubscription: null,
          userErrors: [
            { field: ['test'], message: 'Test charges are required on development stores' },
            { field: null, message: 'Something else' },
          ],
        },
      },
    });

    await expect(
      createAppSubscription(admin, {
        planName: 'Growth',
        price: 29,
        currency: 'EUR',
        interval: 'monthly',
        trialDays: null,
        returnUrl: 'https://app.example.com/billing/callback',
        test: false,
      }),
    ).rejects.toThrow(/Test charges are required on development stores; Something else/);
  });

  it('lancia se Shopify non restituisce confirmationUrl', async () => {
    const admin = adminWith({
      data: {
        appSubscriptionCreate: {
          confirmationUrl: null,
          appSubscription: { id: SUB_GID },
          userErrors: [],
        },
      },
    });

    await expect(
      createAppSubscription(admin, {
        planName: 'Growth',
        price: 29,
        currency: 'EUR',
        interval: 'monthly',
        trialDays: null,
        returnUrl: 'https://app.example.com/billing/callback',
        test: false,
      }),
    ).rejects.toThrow(/confirmationUrl/);
  });

  it('lancia sugli errori di primo livello della risposta GraphQL', async () => {
    const admin = adminWith({ errors: [{ message: 'Access denied' }] });

    await expect(
      createAppSubscription(admin, {
        planName: 'Growth',
        price: 29,
        currency: 'EUR',
        interval: 'monthly',
        trialDays: null,
        returnUrl: 'https://app.example.com/billing/callback',
        test: false,
      }),
    ).rejects.toThrow(/Access denied/);
  });

  it('errors come stringa (token non valido) → messaggio leggibile, non un crash', async () => {
    // Su token scaduto o revocato Shopify non risponde con un array ma con
    // "errors": "[API] Invalid API key or access token". Trattarlo come array
    // trasformava la diagnosi in un TypeError, e nei log finiva quello invece
    // del motivo vero.
    const admin = adminWith({
      errors: '[API] Invalid API key or access token',
    } as never);

    await expect(
      createAppSubscription(admin, {
        planName: 'Growth',
        price: 29,
        currency: 'EUR',
        interval: 'monthly',
        trialDays: null,
        returnUrl: 'https://app.example.com/billing/callback',
        test: false,
      }),
    ).rejects.toThrow(/Invalid API key or access token/);
  });
});

describe('getActiveSubscriptions', () => {
  it('mappa gli abbonamenti attivi con il prezzo come numero', async () => {
    const admin = adminWith({
      data: { currentAppInstallation: { activeSubscriptions: [rawSubscription()] } },
    });

    expect(await getActiveSubscriptions(admin)).toEqual([
      {
        gid: SUB_GID,
        name: 'Growth',
        status: 'ACTIVE',
        test: false,
        trialDays: 7,
        currentPeriodEnd: '2026-08-31T10:00:00Z',
        priceAmount: 29,
        // Valuta e intervallo si rileggono da Shopify perche' la callback deve
        // poterli confrontare con quello che il tentativo aveva promesso: senza,
        // un piano mensile potrebbe tornare come annuale e nessuno se ne
        // accorgerebbe.
        currency: 'EUR',
        interval: 'monthly',
      },
    ]);
  });

  it('lista vuota quando non c\'e\' nessun abbonamento', async () => {
    const admin = adminWith({ data: { currentAppInstallation: { activeSubscriptions: [] } } });
    expect(await getActiveSubscriptions(admin)).toEqual([]);
  });

  it('priceAmount null se il pricing non arriva', async () => {
    const admin = adminWith({
      data: {
        currentAppInstallation: {
          activeSubscriptions: [rawSubscription({ lineItems: [] })],
        },
      },
    });
    const [sub] = await getActiveSubscriptions(admin);
    expect(sub.priceAmount).toBeNull();
  });
});

describe('getSubscription', () => {
  it('passa il gid come variabile e restituisce il riepilogo', async () => {
    const admin = adminWith({ data: { node: rawSubscription({ status: 'PENDING' }) } });
    const sub = await getSubscription(admin, SUB_GID);

    expect(variablesOf(admin)).toEqual({ id: SUB_GID });
    expect(sub?.status).toBe('PENDING');
    expect(sub?.gid).toBe(SUB_GID);
  });

  it('null quando node e\' null', async () => {
    const admin = adminWith({ data: { node: null } });
    expect(await getSubscription(admin, SUB_GID)).toBeNull();
  });
});

describe('cancelAppSubscription', () => {
  // In vitest 3 `MockInstance` prende la firma intera, non piu' argomenti e
  // ritorno separati.
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('non lancia quando la cancellazione riesce', async () => {
    const admin = adminWith({
      data: {
        appSubscriptionCancel: {
          appSubscription: { id: SUB_GID, status: 'CANCELLED' },
          userErrors: [],
        },
      },
    });

    await expect(cancelAppSubscription(admin, SUB_GID)).resolves.toBeUndefined();
    expect(variablesOf(admin)).toEqual({ id: SUB_GID });
    expect(warn).not.toHaveBeenCalled();
  });

  it('non lancia se l\'abbonamento risulta gia\' cancellato', async () => {
    const admin = adminWith({
      data: {
        appSubscriptionCancel: {
          appSubscription: null,
          userErrors: [{ field: ['id'], message: 'Subscription has already been cancelled' }],
        },
      },
    });

    await expect(cancelAppSubscription(admin, SUB_GID)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('non lancia se l\'abbonamento non esiste piu\'', async () => {
    const admin = adminWith({
      data: {
        appSubscriptionCancel: {
          appSubscription: null,
          userErrors: [{ field: ['id'], message: 'App subscription not found' }],
        },
      },
    });

    await expect(cancelAppSubscription(admin, SUB_GID)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('lancia sugli altri userErrors', async () => {
    const admin = adminWith({
      data: {
        appSubscriptionCancel: {
          appSubscription: null,
          userErrors: [{ field: null, message: 'Access denied for appSubscriptionCancel' }],
        },
      },
    });

    await expect(cancelAppSubscription(admin, SUB_GID)).rejects.toThrow(/Access denied/);
    expect(warn).not.toHaveBeenCalled();
  });
});
