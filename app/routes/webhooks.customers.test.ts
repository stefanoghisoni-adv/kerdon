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
