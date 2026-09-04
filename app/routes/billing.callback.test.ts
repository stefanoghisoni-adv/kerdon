// app/routes/billing.callback.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const updateShop = vi.fn();
const findPlanMock = vi.fn();
const updateManyCharges = vi.fn();
const findFirstCharge = vi.fn();
const findManyCharges = vi.fn();
const updateCharge = vi.fn();
const upsertCharge = vi.fn();

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
    billingCharge: {
      findFirst: (...a: unknown[]) => findFirstCharge(...a),
      findMany: (...a: unknown[]) => findManyCharges(...a),
      updateMany: (...a: unknown[]) => updateManyCharges(...a),
      update: (...a: unknown[]) => updateCharge(...a),
      upsert: (...a: unknown[]) => upsertCharge(...a),
    },
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
import { signBillingState } from '~/lib/billing/callback-state.server';

// Il segreto con cui lo state si firma, dichiarato prima di tutto: gli state
// dei casi in tabella si costruiscono mentre i test vengono raccolti, cioe'
// prima che qualunque beforeEach abbia girato.
process.env.SHOPIFY_API_SECRET = 'segreto-di-prova';

const SHOP_DOMAIN = 'test-shop.myshopify.com';
const NONCE = 'nonce-del-tentativo';

const SHOP = {
  id: 'shop-1',
  shopDomain: SHOP_DOMAIN,
  currentPlan: 'Free',
  activeChargeId: null as string | null,
  billingCycle: null as string | null,
  setupCompletedAt: null as Date | null,
  authorization: 'ENABLED',
  trackingAuthorization: 'ENABLED',
};

/** La riga del tentativo: quella che `billing/subscribe` ha creato "pending". */
function tentativo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'charge-row-1',
    shopId: 'shop-1',
    shopifyChargeId: 1234n,
    planType: 'Pro',
    price: 29,
    currency: 'USD',
    billingCycle: 'monthly',
    status: 'pending',
    callbackNonce: NONCE,
    callbackNonceUsedAt: null,
    ...overrides,
  };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    gid: 'gid://shopify/AppSubscription/1234',
    name: 'Pro',
    status: 'ACTIVE',
    test: false,
    trialDays: 7,
    currentPeriodEnd: '2026-09-03T10:00:00Z',
    priceAmount: 29,
    currency: 'USD',
    interval: 'monthly',
    ...overrides,
  };
}

/** Lo state firmato che `billing/subscribe` mette nella URL di ritorno. */
function state(overrides: Partial<Parameters<typeof signBillingState>[0]> = {}): string {
  return signBillingState({
    nonce: NONCE,
    shopDomain: SHOP_DOMAIN,
    planName: 'Pro',
    listPrice: 29,
    currency: 'USD',
    interval: 'monthly',
    ...overrides,
  });
}

function url(params: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    charge_id: '1234',
    shop: SHOP_DOMAIN,
    state: state(),
    ...params,
  });
  return `?${query.toString()}`;
}

function call(query = url()) {
  const request = new Request(`https://app.example.com/billing/callback${query}`);
  return loader({ request, params: {}, context: {} } as any) as Promise<Response>;
}

/** Esito e contesto embedded del rimando alla tab Piano. */
function location(res: Response): URL {
  return new URL(res.headers.get('location') ?? '', 'https://app.example.com');
}

/** La `where` con cui il tentativo e' stato speso, se lo e' stato. */
function claim(): Record<string, unknown> | null {
  const chiamata = updateManyCharges.mock.calls.find(
    (c) => (c[0] as any)?.data?.callbackNonceUsedAt != null,
  );
  return chiamata ? ((chiamata[0] as any).where as Record<string, unknown>) : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_API_SECRET = 'segreto-di-prova';
  findUniqueShop.mockResolvedValue({ ...SHOP });
  findPlanMock.mockResolvedValue({ planName: 'Pro', priceMonthly: 29, trialDays: 7 });
  findFirstCharge.mockResolvedValue(tentativo());
  // Il conteggio della compare-and-set: uno vuol dire "il tentativo era mio e
  // l'ho appena speso io".
  updateManyCharges.mockResolvedValue({ count: 1 });
  findManyCharges.mockResolvedValue([]);
  getActiveSubscriptions.mockResolvedValue([]);
});

describe('/billing/callback', () => {
  it('senza charge_id valido non interroga Shopify e torna con esito negativo', async () => {
    const res = await call(`?shop=${SHOP_DOMAIN}`);
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

    const res = await call(url({ charge_id: '999999' }));

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
    findManyCharges.mockResolvedValue([{ id: 'row-9876', shopifyChargeId: 9876n }]);

    const res = await call();

    expect(claim()).toMatchObject({
      shopId: 'shop-1',
      shopifyChargeId: 1234n,
      status: 'pending',
      callbackNonce: NONCE,
      callbackNonceUsedAt: null,
    });
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
    expect(updateCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'row-9876' },
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    );
    expect(location(res).searchParams.get('billing')).toBe('ok');
  });

  it('la conferma del piano viaggia con il piano, non in una scrittura a parte', async () => {
    getSubscription.mockResolvedValue(subscription());

    await call();

    expect(updateShop).toHaveBeenCalledTimes(1);
    expect(updateShop.mock.calls[0][0].data).toHaveProperty('planConfirmedAt');
  });

  it('si rientra dall admin, non dall indirizzo dell app', async () => {
    // Al ritorno dal pagamento il browser e' di primo livello: mandarlo su una
    // rotta dell'app significa chiedergli di rientrare da solo nel riquadro, ed
    // e' quel giro che lasciava una pagina bianca dopo aver pagato.
    process.env.SHOPIFY_API_KEY = 'chiave-app';
    getSubscription.mockResolvedValue(subscription());

    const res = await call(url({ return_to: 'dashboard' }));

    expect(location(res).origin).toBe('https://admin.shopify.com');
    expect(location(res).pathname).toBe('/store/test-shop/apps/chiave-app');
    expect(location(res).searchParams.get('billing')).toBe('ok');
    delete process.env.SHOPIFY_API_KEY;
  });

  it('si torna sempre in dashboard, senza sotto-percorso dopo l id dell app', async () => {
    // Con /plan in coda il riquadro si apriva vuoto: niente contenuto, nemmeno
    // il menu, e l'unico modo di uscirne era ricaricare la pagina intera. Dopo
    // aver pagato. Senza sotto-percorso l'indirizzo e' quello canonico con cui
    // l'admin apre un'app.
    process.env.SHOPIFY_API_KEY = 'chiave-app';
    getSubscription.mockResolvedValue(subscription());

    const res = await call();

    expect(location(res).pathname).toBe('/store/test-shop/apps/chiave-app');
    expect(location(res).searchParams.get('billing')).toBe('ok');
    delete process.env.SHOPIFY_API_KEY;
  });

  it('senza la chiave dell app resta la via diretta, con il contesto embedded', async () => {
    getSubscription.mockResolvedValue(subscription());

    const res = await call();
    const u = location(res);

    expect(u.pathname).toBe('/');
    expect(u.searchParams.get('shop')).toBe(SHOP_DOMAIN);
    expect(u.searchParams.get('embedded')).toBe('1');
    expect(Buffer.from(u.searchParams.get('host') ?? '', 'base64').toString('utf8')).toBe(
      'admin.shopify.com/store/test-shop',
    );
  });

  it('un return_to inventato non sposta la destinazione', async () => {
    // La destinazione la decide questo file: un indirizzo preso dalla
    // querystring sarebbe un rimando aperto.
    getSubscription.mockResolvedValue(subscription());

    const u = location(await call(url({ return_to: 'https://evil.example' })));

    expect(u.pathname).toBe('/');
    expect(u.origin).not.toBe('https://evil.example');
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

describe('il tentativo si spende una volta sola', () => {
  /**
   * Il buco da cui nasce tutto questo blocco: bastava un abbonamento attivo
   * perche' il piano venisse riapplicato. Un F5 sulla pagina di ritorno
   * riscriveva `planStartedAt` e `trialEndsAt` — cioe' allungava la prova — e
   * rimandava a Shopify le cancellazioni dei vecchi abbonamenti.
   */
  beforeEach(() => {
    getSubscription.mockResolvedValue(subscription());
  });

  it("verifica e spesa sono la stessa scrittura: le condizioni stanno nella where", async () => {
    await call();

    // Se fossero due passaggi — leggo, controllo, scrivo — due callback
    // ravvicinate passerebbero tutte e due il controllo prima che una scriva.
    expect(claim()).toEqual({
      shopId: 'shop-1',
      shopifyChargeId: 1234n,
      status: 'pending',
      callbackNonce: NONCE,
      callbackNonceUsedAt: null,
    });
  });

  it('tentativo gia speso e negozio gia sul piano: successo, ma nessuna scrittura', async () => {
    // E' la ricarica della pagina. Il conteggio zero dice che qualcun altro ha
    // gia' chiuso questo tentativo.
    updateManyCharges.mockResolvedValue({ count: 0 });
    findFirstCharge.mockResolvedValue(
      tentativo({ status: 'active', callbackNonceUsedAt: new Date() }),
    );
    findUniqueShop.mockResolvedValue({
      ...SHOP,
      currentPlan: 'Pro',
      activeChargeId: '1234',
      billingCycle: 'monthly',
    });

    const res = await call();

    expect(location(res).searchParams.get('billing')).toBe('ok');
    // Niente timestamp riscritti: e' esattamente cosi' che una ricarica
    // allungava il periodo di prova.
    expect(updateShop).not.toHaveBeenCalled();
    // E niente abbonamenti ri-cancellati su Shopify.
    expect(cancelAppSubscription).not.toHaveBeenCalled();
    expect(getActiveSubscriptions).not.toHaveBeenCalled();
  });

  it('tentativo gia speso ma il negozio e su un altro addebito: non e andata', async () => {
    // Qui non c'e' niente da confermare: rispondere "ok" direbbe al merchant
    // che il piano e' cambiato quando non lo e'.
    updateManyCharges.mockResolvedValue({ count: 0 });
    findFirstCharge.mockResolvedValue(tentativo({ status: 'active' }));
    findUniqueShop.mockResolvedValue({ ...SHOP, activeChargeId: '5555' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await call();

    expect(location(res).searchParams.get('billing')).toBe('ko');
    expect(updateShop).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('la cadenza deve coincidere perche il replay valga', async () => {
    updateManyCharges.mockResolvedValue({ count: 0 });
    findFirstCharge.mockResolvedValue(tentativo({ status: 'active' }));
    findUniqueShop.mockResolvedValue({
      ...SHOP,
      currentPlan: 'Pro',
      activeChargeId: '1234',
      billingCycle: 'yearly',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await call();

    expect(location(res).searchParams.get('billing')).toBe('ko');
    warnSpy.mockRestore();
  });
});

describe('lo state e la condizione di ogni attivazione nuova', () => {
  beforeEach(() => {
    getSubscription.mockResolvedValue(subscription());
  });

  /** I casi in cui la callback non riconosce il tentativo che dice di chiudere. */
  const nonRiconosciuti: Array<[string, string]> = [
    ['senza state', `?charge_id=1234&shop=${SHOP_DOMAIN}`],
    ['con uno state che non abbiamo firmato noi', url({ state: 'roba.inventata' })],
    [
      'con uno state di un altro negozio',
      url({ state: state({ shopDomain: 'altro-negozio.myshopify.com' }) }),
    ],
    ['con un piano diverso da quello confermato', url({ state: state({ planName: 'Business' }) })],
    ['con un importo diverso da quello confermato', url({ state: state({ listPrice: 9 }) })],
    ['con una valuta diversa da quella confermata', url({ state: state({ currency: 'GBP' }) })],
    ['con una cadenza diversa da quella confermata', url({ state: state({ interval: 'yearly' }) })],
    ['con un nonce che non e quello del tentativo', url({ state: state({ nonce: 'altro' }) })],
  ];

  for (const [caso, query] of nonRiconosciuti) {
    it(`${caso}: nessuna attivazione`, async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await call(query);

      expect(updateShop).not.toHaveBeenCalled();
      expect(claim()).toBeNull();
      expect(location(res).searchParams.get('billing')).toBe('ko');
      warnSpy.mockRestore();
    });
  }

  it('senza riga di tentativo non si attiva niente', async () => {
    // Un charge_id che Shopify conferma ma di cui qui non c'e' traccia: non e'
    // un tentativo nostro da chiudere.
    findFirstCharge.mockResolvedValue(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await call();

    expect(updateShop).not.toHaveBeenCalled();
    expect(location(res).searchParams.get('billing')).toBe('ko');
    warnSpy.mockRestore();
  });

  it('una callback vecchia senza state conferma un piano gia applicato, e basta', async () => {
    // Riconciliazione in sola lettura: risponde che e' andata perche' e'
    // andata davvero, ma non riapplica niente.
    findFirstCharge.mockResolvedValue(tentativo({ status: 'active' }));
    findUniqueShop.mockResolvedValue({
      ...SHOP,
      currentPlan: 'Pro',
      activeChargeId: '1234',
      billingCycle: 'monthly',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await call(`?charge_id=1234&shop=${SHOP_DOMAIN}`);

    expect(location(res).searchParams.get('billing')).toBe('ok');
    expect(updateShop).not.toHaveBeenCalled();
    expect(claim()).toBeNull();
    warnSpy.mockRestore();
  });

  it('il prezzo scontato del tentativo sta sotto il listino, e va bene cosi', async () => {
    // Lo state porta il LISTINO (e' quello che Shopify rilegge), la riga porta
    // la cifra che il merchant paga davvero. Confrontarle per uguaglianza
    // farebbe suonare l'allarme a ogni negozio con un prezzo concordato.
    findFirstCharge.mockResolvedValue(tentativo({ price: 19 }));

    const res = await call();

    expect(location(res).searchParams.get('billing')).toBe('ok');
    expect(updateShop).toHaveBeenCalled();
  });

  it('un tentativo che costa piu del listino non e uno sconto', async () => {
    findFirstCharge.mockResolvedValue(tentativo({ price: 39 }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await call();

    expect(updateShop).not.toHaveBeenCalled();
    expect(location(res).searchParams.get('billing')).toBe('ko');
    warnSpy.mockRestore();
  });

  it('lo state si verifica prima di toccare qualunque dato', async () => {
    // Uno state di un altro negozio non deve nemmeno arrivare a spendere un
    // tentativo: il controllo viene prima delle scritture, non in mezzo.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await call(url({ state: state({ shopDomain: 'altro.myshopify.com' }) }));

    expect(claim()).toBeNull();
    expect(updateShop).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('la cadenza arriva da Shopify, non da una costante', () => {
  it('abbonamento annuale: annuale sul negozio e sulla riga dell addebito', async () => {
    // Prima qui c'era 'monthly' scritto a mano: un abbonamento annuale
    // risultava mensile sulla colonna da cui si racconta il piano al merchant.
    getSubscription.mockResolvedValue(subscription({ interval: 'yearly', priceAmount: 290 }));
    findFirstCharge.mockResolvedValue(tentativo({ billingCycle: 'yearly', price: 290 }));

    const res = await call(url({ state: state({ interval: 'yearly', listPrice: 290 }) }));

    expect(location(res).searchParams.get('billing')).toBe('ok');
    expect(updateShop.mock.calls[0][0].data).toMatchObject({ billingCycle: 'yearly' });
    const speso = updateManyCharges.mock.calls.find(
      (c) => (c[0] as any)?.data?.callbackNonceUsedAt != null,
    );
    expect((speso?.[0] as any).data).toMatchObject({ billingCycle: 'yearly' });
  });
});

describe('la chiusura dei vecchi abbonamenti non si perde per strada', () => {
  beforeEach(() => {
    getSubscription.mockResolvedValue(subscription());
  });

  it("l'intenzione si scrive nella transazione, prima di chiamare Shopify", async () => {
    await call();

    // Le righe degli abbonamenti precedenti passano a `superseded` dentro la
    // stessa transazione che attiva il piano: da li' in poi il lavoro c'e'
    // scritto, e un errore di rete non lo cancella.
    expect(updateManyCharges).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shopId: 'shop-1',
          status: { in: ['active', 'pending'] },
          NOT: { shopifyChargeId: 1234n },
        }),
        data: { status: 'superseded' },
      }),
    );
  });

  it('la chiusura fallita lascia la riga in coda e non annulla l attivazione', async () => {
    findManyCharges.mockResolvedValue([{ id: 'row-9876', shopifyChargeId: 9876n }]);
    cancelAppSubscription.mockRejectedValue(new Error('rete'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await call();

    // Il piano e' applicato...
    expect(updateShop).toHaveBeenCalled();
    expect(location(res).searchParams.get('billing')).toBe('ok');
    // ...e la riga NON e' stata segnata come chiusa: resta li' per il giro dopo.
    expect(updateCharge).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("l'elenco degli abbonamenti attivi non letto non annulla l attivazione", async () => {
    getActiveSubscriptions.mockRejectedValue(new Error('rete'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await call();

    expect(updateShop).toHaveBeenCalled();
    expect(location(res).searchParams.get('billing')).toBe('ok');
    warnSpy.mockRestore();
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

    await call();

    expect(findUniqueShop).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopDomain: SHOP_DOMAIN } }),
    );
  });
});
