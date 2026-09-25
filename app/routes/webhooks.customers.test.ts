import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creaFakeWebhookStore } from '~/lib/webhooks/inbox-fake-store';

/**
 * La rotta dei clienti dopo che il lavoro e' uscito dalla richiesta HTTP.
 *
 * DUE COSE SONO CAMBIATE, E LA SECONDA SI VEDE IN OGNI TEST. La prima: la
 * risposta e' la sola ricevuta, quindi una scrittura fallita non e' piu' un 500
 * ma una riga che torna in attesa. La seconda: della busta si conserva il solo
 * identificativo, e l'anagrafica si RILEGGE da Shopify — cosi' due modifiche
 * ravvicinate non possono piu' scriversi sopra in ordine sbagliato, e nel
 * database owner non resta per una settimana il nome di una persona.
 *
 * Per questo `req()` dichiara anche cosa Shopify restituira' rileggendo: sono
 * la stessa cosa detta due volte, e separarle proverebbe una strada che non
 * esiste piu'.
 */
const store = creaFakeWebhookStore();
const getCustomerById = vi.fn();

vi.mock('~/lib/webhooks/verify.server', () => ({ verifyWebhook: () => true }));
vi.mock('~/lib/transformers/customer.server', () => ({
  transformCustomer: vi.fn((c: any) => ({
    shopify_customer_id: c.id,
    email: c.email,
    first_name: c.first_name,
    accepts_marketing: c.email_marketing_consent?.state === 'subscribed',
  })),
}));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn() }));
vi.mock('~/lib/shopify-api.server', () => ({
  ShopifyAPIClient: { forShop: vi.fn(async () => ({ getCustomerById })) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    // La posta in arrivo vera: l'indice unico e la presa condizionata sullo
    // stato sono cio' che rende un evento consegnato due volte un effetto solo.
    get webhookEvent() {
      return store;
    },
    shop: { findUnique: vi.fn() },
    plan: { findFirst: vi.fn() },
    syncJob: { create: vi.fn() },
    session: { count: async () => 0, findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
  },
}));

import { action as rotta } from './webhooks.customers.create';
import { settleWebhookWork } from '~/lib/webhooks/receive.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';

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

/**
 * La busta del webhook, e il cliente che Shopify restituira' rileggendolo.
 *
 * Sono la stessa anagrafica: della busta si conserva l'id, e tutto il resto
 * torna dalla rilettura. Dichiararli insieme e' l'unico modo di provare la
 * strada vera senza ripetere due volte gli stessi campi in ogni test.
 */
function req(body: Record<string, unknown>) {
  getCustomerById.mockResolvedValue(body?.id ? body : null);
  return new Request('https://app/webhooks/customers/create', {
    method: 'POST',
    headers: {
      'X-Shopify-Hmac-Sha256': 'sig',
      'X-Shopify-Shop-Domain': 'test-shop.myshopify.com',
    },
    body: JSON.stringify(body),
  });
}

describe('webhook customers/create — consenso', () => {
  beforeEach(() => {
    store.reset();
    vi.clearAllMocks();
    // `authorization` e `uninstalledAt` servono da quando il webhook chiede la
    // capacita' invece di ricomporre le condizioni sul posto: un negozio di
    // prova deve dichiararsi installato e autorizzato, non esserlo per
    // omissione.
    (prisma.shop.findUnique as any).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      uninstalledAt: null,
      authorization: 'ENABLED',
      trackingAuthorization: 'ENABLED',
      scopes: 'read_products,read_customers',
      currentPlan: 'growth',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameCustomers: 'customers',
      },
    });
    (prisma.plan.findFirst as any).mockResolvedValue({
      planName: 'growth',
      customersSyncEnabled: true,
    });
    (prisma.syncJob.create as any).mockResolvedValue({});
  });

  it('cliente subscribed → chiama upsert, non update', async () => {
    const upserted: any[] = [];
    let updateCalled = false;
    (createSupabaseClient as any).mockReturnValue({
      from: (_table: string) => ({
        upsert: async (rows: any) => {
          upserted.push(rows);
          return { error: null };
        },
        update: () => {
          updateCalled = true;
          return { eq: async () => ({ error: null }) };
        },
      }),
    });

    const res = await action({
      request: req({
        id: 1,
        email: 'opt-in@example.com',
        first_name: 'Alice',
        email_marketing_consent: { state: 'subscribed' },
      }),
    } as any);

    expect(upserted).toHaveLength(1);
    expect(upserted[0].shopify_customer_id).toBe(1);
    expect(updateCalled).toBe(false);
    expect(res.status).toBe(200);
  });

  it('cliente unsubscribed → si marca il consenso, e non si cancella niente', async () => {
    let upsertCalled = false;
    const updates: Array<{ table: string; payload: any; id: any }> = [];
    (createSupabaseClient as any).mockReturnValue({
      from: (table: string) => ({
        upsert: async () => {
          upsertCalled = true;
          return { error: null };
        },
        update: (payload: any) => ({
          eq: async (_col: string, id: any) => {
            updates.push({ table, payload, id });
            return { error: null, count: 1 };
          },
        }),
      }),
    });

    const res = await action({
      request: req({
        id: 2,
        email: 'opt-out@example.com',
        first_name: 'Bob',
        email_marketing_consent: { state: 'unsubscribed' },
      }),
    } as any);

    expect(upsertCalled).toBe(false);
    expect(res.status).toBe(200);

    // Una sola scrittura, su una sola tabella e una sola colonna: chi si
    // disiscrive dalle comunicazioni non ha chiesto di sparire dagli archivi
    // del negozio. A impedire che il dato venga usato e' il rifiuto del proxy,
    // non la cancellazione.
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe('customers');
    expect(updates[0].id).toBe(2);
    expect(updates[0].payload).toEqual({ accepts_marketing: false });
  });


  it('entrambi i casi restituiscono 200', async () => {
    (createSupabaseClient as any).mockReturnValue({
      from: () => ({
        upsert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
    });

    const res1 = await action({
      request: req({
        id: 1,
        email_marketing_consent: { state: 'subscribed' },
      }),
    } as any);
    expect(res1.status).toBe(200);

    const res2 = await action({
      request: req({
        id: 2,
        email_marketing_consent: { state: 'unsubscribed' },
      }),
    } as any);
    expect(res2.status).toBe(200);
  });
});

/**
 * La stessa porta, per i clienti.
 *
 * Il piano lo si guardava gia'. L'autorizzazione e la disinstallazione no, ed
 * erano proprio le due che il merchant non puo' cambiare da se': un negozio
 * sospeso continuava a vedersi scrivere dentro un cliente a ogni ordine.
 */
describe('webhook customers/create — chi non ha diritto non scrive', () => {
  function shopCon(over: Record<string, unknown>) {
    (prisma.shop.findUnique as any).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      uninstalledAt: null,
      authorization: 'ENABLED',
      trackingAuthorization: 'ENABLED',
      scopes: 'read_products,read_customers',
      currentPlan: 'growth',
      supabaseConfig: { connectionVerifiedAt: new Date(), tableNameCustomers: 'customers' },
      ...over,
    });
  }

  const nonSiScrive = async () => {
    const from = vi.fn();
    (createSupabaseClient as any).mockReturnValue({ from });

    const res = await action({
      request: req({ id: 7, email_marketing_consent: { state: 'subscribed' } }),
    } as any);

    expect(res.status).toBe(200);
    expect(from).not.toHaveBeenCalled();
  };

  it("uso dell'app sospeso: nessun cliente scritto", async () => {
    shopCon({ authorization: 'DISABLED' });
    await nonSiScrive();
  });

  it('app disinstallata: nessun cliente scritto', async () => {
    shopCon({ uninstalledAt: new Date('2026-05-01T00:00:00Z') });
    await nonSiScrive();
  });

  it('piano senza clienti: nessun cliente scritto (come prima)', async () => {
    (prisma.plan.findFirst as any).mockResolvedValue({
      planName: 'basic',
      customersSyncEnabled: false,
    });
    shopCon({ currentPlan: 'basic' });
    await nonSiScrive();
  });

  it('progetto scollegato: nessun cliente scritto', async () => {
    shopCon({ supabaseConfig: { connectionVerifiedAt: null, tableNameCustomers: 'customers' } });
    await nonSiScrive();
  });
});

// Un webhook che risponde 200 dice a Shopify "ricevuto e a posto", e Shopify non
// lo ripete piu'. Dirlo su una scrittura fallita significa perdere quel cliente
// fino alla corsa periodica — o per sempre, se la corsa non copre quel caso.
describe('webhook customers/create — una scrittura fallita non si dichiara riuscita', () => {
  beforeEach(() => {
    store.reset();
    vi.clearAllMocks();
    (prisma.shop.findUnique as any).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      uninstalledAt: null,
      authorization: 'ENABLED',
      trackingAuthorization: 'ENABLED',
      scopes: 'read_products,read_customers',
      currentPlan: 'growth',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameCustomers: 'customers',
      },
    });
    (prisma.plan.findFirst as any).mockResolvedValue({
      planName: 'growth',
      customersSyncEnabled: true,
    });
    (prisma.syncJob.create as any).mockResolvedValue({});
  });

  it('upsert rifiutato → l evento resta da lavorare, e la traccia c e', async () => {
    (createSupabaseClient as any).mockReturnValue({
      from: () => ({
        upsert: async () => ({ error: { message: 'permission denied', code: '42501' } }),
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
    });

    const res = await action({
      request: req({
        id: 7,
        email: 'chi@esempio.it',
        email_marketing_consent: { state: 'subscribed' },
      }),
    } as any);

    // 200 perche' la ricevuta e' scritta: rifiutare adesso un evento gia'
    // accettato non rimetterebbe a posto niente. Che la scrittura non sia
    // riuscita si legge sulla riga, che torna in attesa con un tentativo speso.
    expect(res.status).toBe(200);
    expect(evento().status).toBe('queued');
    expect(evento().attempts).toBe(1);
    // Il fallimento resta scritto anche nel registro dei job, non solo nel log.
    const job = (prisma.syncJob.create as any).mock.calls[0][0].data;
    expect(job).toMatchObject({ shopId: 'shop-1', status: 'failed' });
    expect(job.errors.message).toContain('permission denied');
  });

  it('scrittura riuscita → 200, e l evento e concluso', async () => {
    (createSupabaseClient as any).mockReturnValue({
      from: () => ({
        upsert: async () => ({ error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
    });

    const res = await action({
      request: req({
        id: 7,
        email: 'chi@esempio.it',
        email_marketing_consent: { state: 'subscribed' },
      }),
    } as any);

    expect(res.status).toBe(200);
    expect(evento().status).toBe('completed');
  });
});
