import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('~/lib/webhooks/verify.server', () => ({ verifyWebhook: vi.fn(() => true) }));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn() }));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: vi.fn(), deleteMany: vi.fn() },
    session: { deleteMany: vi.fn() },
    customerDataAccessLog: { deleteMany: vi.fn() },
    syncJob: { create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    syncJobEvent: { deleteMany: vi.fn() },
  },
}));

import { action as redactCustomer } from './webhooks.gdpr.customers-redact';
import { action as dataRequest } from './webhooks.gdpr.data-request';
import { action as redactShop } from './webhooks.gdpr.shop-redact';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SHOP = 'test-shop.myshopify.com';

function req(body: string | object, hmac: string | null = 'sig') {
  const headers: Record<string, string> = {};
  if (hmac) headers['X-Shopify-Hmac-Sha256'] = hmac;
  return new Request('https://app/webhooks/gdpr', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const customerPayload = { shop_domain: SHOP, customer: { id: 4021 } };

type Result = { data?: unknown; error?: unknown; count?: number };

interface Recorded {
  table: string;
  op: 'delete' | 'update' | 'select';
  values?: Record<string, unknown>;
}

const calls: Recorded[] = [];

function fakeSupabase(replies: Record<string, Result>) {
  const reply = (table: string): Result => replies[table] ?? { data: [], error: null, count: 0 };
  return {
    from: (table: string) => ({
      delete: () => ({
        eq: async () => {
          calls.push({ table, op: 'delete' });
          return reply(table);
        },
      }),
      update: (values: Record<string, unknown>) => ({
        eq: async () => {
          calls.push({ table, op: 'update', values });
          return reply(table);
        },
      }),
      select: () => ({
        eq: async () => {
          calls.push({ table, op: 'select' });
          return reply(table);
        },
        in: async () => {
          calls.push({ table, op: 'select' });
          return reply(table);
        },
      }),
    }),
  };
}

/** La riga di controllo scritta nel database, come l'ha vista Prisma. */
function auditRow() {
  const call = (prisma.syncJob.create as any).mock.calls[0];
  return call?.[0].data as {
    jobType: string;
    status: string;
    errors: { message?: string; gdpr: { steps: Array<{ table: string; outcome: string }> } };
  };
}

function auditTables() {
  return auditRow().errors.gdpr.steps.map((s) => s.table);
}

// `any`: la firma di spyOn su console cambia fra le versioni di vitest, e qui
// serve solo poter leggere le chiamate e ripristinare l'originale.
let logSpy: any;
let errorSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  (verifyWebhook as any).mockReturnValue(true);
  (prisma.shop.findUnique as any).mockResolvedValue({
    id: 'shop-1',
    shopDomain: SHOP,
    supabaseConfig: { tableNameCustomers: 'customers' },
  });
  (prisma.shop.deleteMany as any).mockResolvedValue({ count: 1 });
  (prisma.session.deleteMany as any).mockResolvedValue({ count: 2 });
  (prisma.customerDataAccessLog.deleteMany as any).mockResolvedValue({ count: 5 });
  (prisma.syncJob.create as any).mockResolvedValue({});
  (prisma.syncJob.findMany as any).mockResolvedValue([]);
  (prisma.syncJobEvent.deleteMany as any).mockResolvedValue({ count: 0 });
  (createSupabaseClient as any).mockReturnValue(
    fakeSupabase({ customers: { error: null, count: 1 }, orders: { error: null, count: 2 } }),
  );
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('customers/redact', () => {
  it('firma non valida → 401, nessuna cancellazione', async () => {
    (verifyWebhook as any).mockReturnValue(false);

    const res = await redactCustomer({ request: req(customerPayload) } as never);

    expect(res.status).toBe(401);
    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(prisma.syncJob.create).not.toHaveBeenCalled();
  });

  it('corpo malformato → 400, non 500', async () => {
    // Ritentare lo stesso corpo illeggibile darebbe lo stesso risultato per
    // giorni: e' una richiesta rotta, non un guasto nostro.
    const res = await redactCustomer({ request: req('{non e json') } as never);

    expect(res.status).toBe(400);
    expect(createSupabaseClient).not.toHaveBeenCalled();
  });

  it('payload senza id cliente → 400', async () => {
    const res = await redactCustomer({ request: req({ shop_domain: SHOP }) } as never);

    expect(res.status).toBe(400);
  });

  it('cancella da ogni tabella che porta un riferimento alla persona', async () => {
    const res = await redactCustomer({ request: req(customerPayload) } as never);

    expect(res.status).toBe(200);
    expect(auditTables()).toEqual([
      'customers',
      'orders',
      'order_lines',
      'sync_job_events',
      'sync_jobs',
      'customer_data_access_logs',
    ]);
    expect(auditRow().status).toBe('completed');
  });

  it('gli ordini vengono anonimizzati, non persi', async () => {
    await redactCustomer({ request: req(customerPayload) } as never);

    const ordini = calls.filter((c) => c.table === 'orders');
    expect(ordini).toEqual([
      {
        table: 'orders',
        op: 'update',
        values: {
          shopify_customer_id: null,
          customer_first_name: null,
          customer_last_name: null,
        },
      },
    ]);
  });

  it('pulisce anche il nostro database, non solo quello del merchant', async () => {
    await redactCustomer({ request: req(customerPayload) } as never);

    expect(prisma.syncJobEvent.deleteMany).toHaveBeenCalledWith({
      where: { entity: 'customer', shopifyId: 4021n, syncJob: { shopId: 'shop-1' } },
    });
    expect(prisma.syncJob.findMany).toHaveBeenCalled();
  });

  it('fallimento parziale → 500, e la traccia NON dice riuscito', async () => {
    // La tabella clienti si svuota, gli ordini no: la persona resta scritta
    // negli ordini. Chiudere con 200 vorrebbe dire dichiarare eseguita una
    // cancellazione che non e' avvenuta.
    (createSupabaseClient as any).mockReturnValue(
      fakeSupabase({
        customers: { error: null, count: 1 },
        orders: { error: { code: '08006', message: 'connection failure' } },
      }),
    );

    const res = await redactCustomer({ request: req(customerPayload) } as never);

    expect(res.status).toBe(500);
    const row = auditRow();
    expect(row.status).toBe('failed');
    expect(row.status).not.toBe('completed');
    expect(row.errors.message).toContain('orders');
    expect(row.errors.gdpr.steps.find((s) => s.table === 'orders')?.outcome).toBe('failed');
  });

  it('negozio senza progetto collegato → 200, e il nostro database si pulisce lo stesso', async () => {
    (prisma.shop.findUnique as any).mockResolvedValue({
      id: 'shop-1',
      shopDomain: SHOP,
      supabaseConfig: null,
    });

    const res = await redactCustomer({ request: req(customerPayload) } as never);

    expect(res.status).toBe(200);
    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(prisma.syncJobEvent.deleteMany).toHaveBeenCalled();
    expect(auditRow().status).toBe('completed');
  });

  it('negozio mai registrato → 200 e traccia nel log', async () => {
    (prisma.shop.findUnique as any).mockResolvedValue(null);

    const res = await redactCustomer({ request: req(customerPayload) } as never);

    expect(res.status).toBe(200);
    expect(prisma.syncJob.create).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join(' ')).toContain('[gdpr]');
  });

  it('database irraggiungibile → 500', async () => {
    (prisma.shop.findUnique as any).mockRejectedValue(new Error('database irraggiungibile'));

    const res = await redactCustomer({ request: req(customerPayload) } as never);

    expect(res.status).toBe(500);
  });

  it('la traccia non contiene dati della persona, solo la sua impronta', async () => {
    await redactCustomer({
      request: req({ shop_domain: SHOP, customer: { id: 4021, email: 'chi@esempio.it' } }),
    } as never);

    const serialized = JSON.stringify(auditRow());
    expect(serialized).not.toContain('chi@esempio.it');
    expect(serialized).not.toContain('4021');
    expect(serialized).toContain('customer_ref');
  });
});

describe('customers/data_request', () => {
  it('restituisce i dati della persona da tutte le tabelle che la riguardano', async () => {
    (createSupabaseClient as any).mockReturnValue(
      fakeSupabase({
        customers: {
          data: [{ shopify_customer_id: 4021, email_address: 'chi@esempio.it' }],
          error: null,
        },
        orders: { data: [{ shopify_order_id: 900, total_price: '12.00' }], error: null },
        order_lines: {
          data: [{ shopify_line_id: 1, shopify_order_id: 900, title: 'Tazza' }],
          error: null,
        },
      }),
    );

    const res = await dataRequest({ request: req(customerPayload) } as never);
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.data.customer.email_address).toBe('chi@esempio.it');
    expect(body.data.orders).toHaveLength(1);
    expect(body.data.order_lines).toEqual([
      { shopify_line_id: 1, shopify_order_id: 900, title: 'Tazza' },
    ]);
    expect(auditRow().status).toBe('completed');
  });

  it('persona mai sincronizzata → 200 con esportazione vuota', async () => {
    // Con .single() questo caso rispondeva 500 e Shopify ritentava per giorni
    // una richiesta a cui la risposta giusta era "non teniamo nulla".
    (createSupabaseClient as any).mockReturnValue(
      fakeSupabase({ customers: { data: [], error: null }, orders: { data: [], error: null } }),
    );

    const res = await dataRequest({ request: req(customerPayload) } as never);
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ customer: null, orders: [], order_lines: [] });
  });

  it('negozio non configurato → 200, nessuna lettura tentata', async () => {
    (prisma.shop.findUnique as any).mockResolvedValue({ id: 'shop-1', supabaseConfig: null });

    const res = await dataRequest({ request: req(customerPayload) } as never);

    expect(res.status).toBe(200);
    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(auditRow().status).toBe('completed');
  });

  it('raccolta incompleta → 500, traccia fallita', async () => {
    (createSupabaseClient as any).mockReturnValue(
      fakeSupabase({
        customers: { data: [{ shopify_customer_id: 4021 }], error: null },
        orders: { error: { code: '57014', message: 'statement timeout' } },
      }),
    );

    const res = await dataRequest({ request: req(customerPayload) } as never);

    expect(res.status).toBe(500);
    expect(auditRow().status).toBe('failed');
  });

  it('la traccia registra i conteggi, mai i dati letti', async () => {
    (createSupabaseClient as any).mockReturnValue(
      fakeSupabase({
        customers: { data: [{ shopify_customer_id: 4021, email_address: 'chi@esempio.it' }], error: null },
        orders: { data: [], error: null },
      }),
    );

    await dataRequest({ request: req(customerPayload) } as never);

    expect(JSON.stringify(auditRow())).not.toContain('chi@esempio.it');
  });

  it('firma non valida → 401; corpo malformato → 400', async () => {
    (verifyWebhook as any).mockReturnValue(false);
    expect((await dataRequest({ request: req(customerPayload) } as never)).status).toBe(401);

    (verifyWebhook as any).mockReturnValue(true);
    expect((await dataRequest({ request: req('{rotto') } as never)).status).toBe(400);
  });
});

describe('shop/redact', () => {
  const shopPayload = { shop_domain: SHOP };

  it('toglie il negozio, le sessioni e il registro degli accessi', async () => {
    const res = await redactShop({ request: req(shopPayload) } as never);

    expect(res.status).toBe(200);
    expect(prisma.customerDataAccessLog.deleteMany).toHaveBeenCalledWith({
      where: { shopId: 'shop-1' },
    });
    // Le sessioni non sono in cascata: si legano al dominio, e dentro hanno
    // token e dati di chi ha installato l'app.
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({ where: { shop: SHOP } });
    expect(prisma.shop.deleteMany).toHaveBeenCalledWith({ where: { shopDomain: SHOP } });
  });

  it('la traccia finisce nel log: nel database non ci sarebbe piu nulla a cui legarla', async () => {
    await redactShop({ request: req(shopPayload) } as never);

    const line = logSpy.mock.calls.flat().join(' ');
    expect(line).toContain('[gdpr]');
    expect(line).toContain('gdpr_shop_redact');
    expect(line).toContain('sessions');
    expect(prisma.syncJob.create).not.toHaveBeenCalled();
  });

  it('negozio mai registrato → 200 lo stesso', async () => {
    (prisma.shop.findUnique as any).mockResolvedValue(null);
    (prisma.shop.deleteMany as any).mockResolvedValue({ count: 0 });

    const res = await redactShop({ request: req(shopPayload) } as never);

    expect(res.status).toBe(200);
  });

  it('cancellazione parziale → 500 e traccia fallita, non riuscita', async () => {
    // Le sessioni restano: dentro ci sono un access token e i dati di una
    // persona. Rispondere 200 vorrebbe dire tenerseli per sempre.
    (prisma.session.deleteMany as any).mockRejectedValue(new Error('database irraggiungibile'));

    const res = await redactShop({ request: req(shopPayload) } as never);

    expect(res.status).toBe(500);
    const row = auditRow();
    expect(row.jobType).toBe('gdpr_shop_redact');
    expect(row.status).toBe('failed');
    expect(row.errors.message).toContain('sessions');
  });

  it('senza dominio del negozio → 400; corpo malformato → 400', async () => {
    expect((await redactShop({ request: req({}) } as never)).status).toBe(400);
    expect((await redactShop({ request: req('{rotto') } as never)).status).toBe(400);
    expect(prisma.shop.deleteMany).not.toHaveBeenCalled();
  });

  it('firma non valida → 401, niente viene cancellato', async () => {
    (verifyWebhook as any).mockReturnValue(false);

    const res = await redactShop({ request: req(shopPayload) } as never);

    expect(res.status).toBe(401);
    expect(prisma.shop.deleteMany).not.toHaveBeenCalled();
    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
  });
});
