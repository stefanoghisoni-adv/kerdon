import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: vi.fn() },
    plan: { findFirst: vi.fn() },
    syncJob: { create: vi.fn() },
  },
}));

import { action } from './webhooks.customers.create';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';

function req(body: object) {
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
      currentPlan: 'pro',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameCustomers: 'customers',
      },
    });
    (prisma.plan.findFirst as any).mockResolvedValue({
      planName: 'pro',
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

  it('cliente unsubscribed → svuota cio che lo identifica, e non lo inserisce', async () => {
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

    const cliente = updates.find((u) => u.table === 'customers')!;
    expect(cliente.id).toBe(2);

    // Il consenso a false, che e' cio' su cui il proxy nega la lettura...
    expect(cliente.payload.accepts_marketing).toBe(false);
    // ...e con lui tutto quello che diceva chi fosse: restava li' per sempre,
    // leggibile da chiunque avesse le credenziali del database del merchant.
    for (const colonna of [
      'email_address',
      'phone_number',
      'first_name',
      'last_name',
      'country',
      'country_code',
      'address',
      'city',
      'zipcode',
      'region',
      'date_of_birth',
      'external_id',
      'fb_login_id',
      'google_login_id',
      'note',
    ]) {
      expect(cliente.payload[colonna]).toBeNull();
    }
    // I numeri del negozio non si toccano: sono fatti suoi, non della persona.
    expect(cliente.payload).not.toHaveProperty('total_spent');
    expect(cliente.payload).not.toHaveProperty('total_profit');
    expect(cliente.payload).not.toHaveProperty('orders_count');
    expect(cliente.payload).not.toHaveProperty('shopify_customer_id');

    // E il legame col browser si scioglie: svuotare la riga del cliente e
    // lasciarlo intatto avrebbe lasciato la persona ricollegabile dall'altro
    // lato.
    const browser = updates.find((u) => u.table === 'users')!;
    expect(browser).toBeDefined();
    expect(browser.payload).toEqual({ shopify_customer_id: null });
  });

  // Le tabelle del merchant nascono al collegamento e non cambiano da sole: una
  // creata da una versione precedente puo' non avere tutte le colonne, e
  // PostgREST rifiuta l'intera update per una sola che non conosce. Perdere
  // anche la marcatura del consenso sarebbe peggio del ritardo.
  it('tabella senza tutte le colonne: il consenso viene marcato lo stesso', async () => {
    const updates: Array<{ table: string; payload: any; id: any }> = [];
    (createSupabaseClient as any).mockReturnValue({
      from: (table: string) => ({
        upsert: async () => ({ error: null }),
        update: (payload: any) => ({
          eq: async (_col: string, id: any) => {
            updates.push({ table, payload, id });
            return updates.length === 1
              ? {
                  error: {
                    code: 'PGRST204',
                    message: "Could not find the 'external_id' column of 'customers'",
                  },
                }
              : { error: null, count: 1 };
          },
        }),
      }),
    });

    const res = await action({
      request: req({
        id: 3,
        email: 'opt-out@example.com',
        email_marketing_consent: { state: 'unsubscribed' },
      }),
    } as any);

    expect(res.status).toBe(200);
    // Primo tentativo rifiutato, secondo con la sola marcatura, poi il browser.
    expect(updates.map((u) => u.table)).toEqual(['customers', 'customers', 'users']);
    expect(updates[1].payload).toEqual({ accepts_marketing: false });
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
      currentPlan: 'pro',
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
      planName: 'free',
      customersSyncEnabled: false,
    });
    shopCon({ currentPlan: 'free' });
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
    vi.clearAllMocks();
    (prisma.shop.findUnique as any).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      uninstalledAt: null,
      authorization: 'ENABLED',
      trackingAuthorization: 'ENABLED',
      scopes: 'read_products,read_customers',
      currentPlan: 'pro',
      supabaseConfig: {
        connectionVerifiedAt: new Date(),
        tableNameCustomers: 'customers',
      },
    });
    (prisma.plan.findFirst as any).mockResolvedValue({
      planName: 'pro',
      customersSyncEnabled: true,
    });
    (prisma.syncJob.create as any).mockResolvedValue({});
  });

  it('upsert rifiutato → 500, cosi Shopify riprova', async () => {
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

    expect(res.status).toBe(500);
    // Il fallimento resta scritto anche nel registro dei job, non solo nel log.
    const job = (prisma.syncJob.create as any).mock.calls[0][0].data;
    expect(job).toMatchObject({ shopId: 'shop-1', status: 'failed' });
    expect(job.errors.message).toContain('permission denied');
  });

  it('scrittura riuscita → 200, e nessun tentativo in piu', async () => {
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
  });
});
