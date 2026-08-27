import { describe, it, expect, vi, beforeEach } from 'vitest';

const deleteManyEvents = vi.fn();
const findManyJobs = vi.fn();
const updateJob = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    syncJobEvent: { deleteMany: (...a: unknown[]) => deleteManyEvents(...a) },
    syncJob: {
      findMany: (...a: unknown[]) => findManyJobs(...a),
      update: (...a: unknown[]) => updateJob(...a),
    },
  },
}));

import {
  collectCustomerData,
  eraseCustomerFromAppDatabase,
  eraseCustomerFromMerchant,
  stepsFailed,
  type GdprStep,
} from './customer-record.server';

type Result = { data?: unknown; error?: unknown; count?: number };

interface Recorded {
  table: string;
  op: 'delete' | 'update' | 'select';
  values?: Record<string, unknown>;
  filter?: unknown;
}

/**
 * Un finto client Supabase che registra cosa gli e' stato chiesto: e' l'unico
 * modo per dimostrare che gli ordini vengono aggiornati e non cancellati.
 */
function fakeClient(replies: Record<string, Result>, calls: Recorded[]) {
  const reply = (table: string): Result => replies[table] ?? { data: [], error: null, count: 0 };

  return {
    from: (table: string) => ({
      delete: () => ({
        eq: async (_col: string, value: unknown) => {
          calls.push({ table, op: 'delete', filter: value });
          return reply(table);
        },
      }),
      update: (values: Record<string, unknown>) => ({
        eq: async (_col: string, value: unknown) => {
          calls.push({ table, op: 'update', values, filter: value });
          return reply(table);
        },
      }),
      select: () => ({
        eq: async (_col: string, value: unknown) => {
          calls.push({ table, op: 'select', filter: value });
          return reply(table);
        },
        in: async (_col: string, values: unknown) => {
          calls.push({ table, op: 'select', filter: values });
          return reply(table);
        },
      }),
    }),
  } as never;
}

const step = (steps: GdprStep[], table: string) => steps.find((s) => s.table === table);

describe('cancellazione nel database del merchant', () => {
  it('tocca tutte le tabelle che riportano alla persona', async () => {
    const calls: Recorded[] = [];
    const steps = await eraseCustomerFromMerchant(
      fakeClient(
        {
          customers: { error: null, count: 1 },
          orders: { error: null, count: 3 },
        },
        calls,
      ),
      'customers',
      '4021',
    );

    expect(steps.map((s) => s.table)).toEqual(['customers', 'orders', 'order_lines']);
    expect(stepsFailed(steps)).toBe(false);
  });

  it('i clienti si cancellano davvero', async () => {
    const calls: Recorded[] = [];
    const steps = await eraseCustomerFromMerchant(
      fakeClient({ customers: { error: null, count: 1 } }, calls),
      'customers',
      '4021',
    );

    const del = calls.find((c) => c.table === 'customers');
    expect(del?.op).toBe('delete');
    expect(del?.filter).toBe('4021');
    expect(step(steps, 'customers')).toMatchObject({ outcome: 'deleted', rows: 1 });
  });

  it('gli ordini si anonimizzano: restano, senza piu la persona dentro', async () => {
    // E' la decisione di fondo: cancellarli distruggerebbe la contabilita' del
    // merchant, che ha l'obbligo di conservarla. Si stacca il riferimento.
    const calls: Recorded[] = [];
    const steps = await eraseCustomerFromMerchant(
      fakeClient({ orders: { error: null, count: 3 } }, calls),
      'customers',
      '4021',
    );

    const ordini = calls.filter((c) => c.table === 'orders');
    expect(ordini).toHaveLength(1);
    expect(ordini[0].op).toBe('update');
    expect(ordini[0].op).not.toBe('delete');
    expect(ordini[0].values).toEqual({
      shopify_customer_id: null,
      customer_first_name: null,
      customer_last_name: null,
    });
    expect(step(steps, 'orders')).toMatchObject({ outcome: 'anonymized', rows: 3 });
  });

  it('le righe d ordine restano dichiarate, con il perche', async () => {
    const calls: Recorded[] = [];
    const steps = await eraseCustomerFromMerchant(fakeClient({}, calls), 'customers', '4021');

    expect(calls.some((c) => c.table === 'order_lines')).toBe(false);
    expect(step(steps, 'order_lines')).toMatchObject({ outcome: 'skipped' });
    expect(step(steps, 'order_lines')?.detail).toMatch(/nessun riferimento alla persona/);
  });

  it('tabella assente → saltata, non fallita', async () => {
    // Gli ordini esistono solo dove il negozio ci ha dato il permesso: una
    // tabella mai creata non contiene dati di nessuno.
    const steps = await eraseCustomerFromMerchant(
      fakeClient(
        {
          customers: { error: null, count: 1 },
          orders: {
            error: { code: 'PGRST205', message: "Could not find the table 'public.orders'" },
          },
        },
        [],
      ),
      'customers',
      '4021',
    );

    expect(step(steps, 'orders')).toMatchObject({ outcome: 'skipped' });
    expect(stepsFailed(steps)).toBe(false);
  });

  it('un errore vero su una sola tabella rende fallita tutta la richiesta', async () => {
    const steps = await eraseCustomerFromMerchant(
      fakeClient(
        {
          customers: { error: null, count: 1 },
          orders: { error: { code: '08006', message: 'connection failure' } },
        },
        [],
      ),
      'customers',
      '4021',
    );

    expect(step(steps, 'customers')).toMatchObject({ outcome: 'deleted' });
    expect(step(steps, 'orders')).toMatchObject({ outcome: 'failed' });
    expect(stepsFailed(steps)).toBe(true);
  });

  it('usa il nome della tabella clienti configurato per quel negozio', async () => {
    const calls: Recorded[] = [];
    await eraseCustomerFromMerchant(fakeClient({}, calls), 'clienti_shop', '4021');

    expect(calls[0].table).toBe('clienti_shop');
  });
});

describe('raccolta dei dati per la richiesta di accesso', () => {
  it('consegna cliente, ordini e righe degli ordini', async () => {
    const calls: Recorded[] = [];
    const { data, steps } = await collectCustomerData(
      fakeClient(
        {
          customers: {
            data: [{ shopify_customer_id: 4021, email_address: 'chi@esempio.it' }],
            error: null,
          },
          orders: {
            data: [
              { shopify_order_id: 900, total_price: '12.00' },
              { shopify_order_id: 901, total_price: '8.00' },
            ],
            error: null,
          },
          order_lines: {
            data: [{ shopify_line_id: 1, shopify_order_id: 900, title: 'Tazza' }],
            error: null,
          },
        },
        calls,
      ),
      'customers',
      '4021',
    );

    expect(data.customer).toEqual({ shopify_customer_id: 4021, email_address: 'chi@esempio.it' });
    expect(data.orders).toHaveLength(2);
    expect(data.order_lines).toEqual([
      { shopify_line_id: 1, shopify_order_id: 900, title: 'Tazza' },
    ]);
    // Le righe si raggiungono partendo dagli id degli ordini trovati.
    expect(calls.find((c) => c.table === 'order_lines')?.filter).toEqual([900, 901]);
    expect(stepsFailed(steps)).toBe(false);
  });

  it('persona mai sincronizzata → esportazione vuota, non un errore', async () => {
    const { data, steps } = await collectCustomerData(
      fakeClient({ customers: { data: [], error: null }, orders: { data: [], error: null } }, []),
      'customers',
      '4021',
    );

    expect(data).toEqual({ customer: null, orders: [], order_lines: [] });
    expect(stepsFailed(steps)).toBe(false);
    expect(step(steps, 'order_lines')).toMatchObject({ outcome: 'skipped' });
  });

  it('una tabella che non risponde rende incompleta la raccolta', async () => {
    const { steps } = await collectCustomerData(
      fakeClient(
        {
          customers: { data: [{ shopify_customer_id: 4021 }], error: null },
          orders: { error: { code: '57014', message: 'statement timeout' } },
        },
        [],
      ),
      'customers',
      '4021',
    );

    expect(stepsFailed(steps)).toBe(true);
  });
});

describe('cancellazione nel nostro database', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteManyEvents.mockResolvedValue({ count: 2 });
    findManyJobs.mockResolvedValue([]);
    updateJob.mockResolvedValue({});
  });

  it('toglie le righe di dettaglio che portano l id della persona', async () => {
    const steps = await eraseCustomerFromAppDatabase('shop-1', '4021', 'impronta');

    expect(deleteManyEvents).toHaveBeenCalledWith({
      where: { entity: 'customer', shopifyId: 4021n, syncJob: { shopId: 'shop-1' } },
    });
    expect(step(steps, 'sync_job_events')).toMatchObject({ outcome: 'deleted', rows: 2 });
  });

  it('sostituisce il customer_id in chiaro con l impronta, senza perdere la riga', async () => {
    findManyJobs.mockResolvedValue([
      { id: 'job-1', errors: { message: 'timeout', customer_id: 4021 } },
    ]);

    const steps = await eraseCustomerFromAppDatabase('shop-1', '4021', 'impronta');

    expect(updateJob).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: { errors: { message: 'timeout', customer_ref: 'impronta' } },
    });
    expect(step(steps, 'sync_jobs')).toMatchObject({ outcome: 'anonymized', rows: 1 });
  });

  it('il registro degli accessi non ha identificatori da togliere', async () => {
    const steps = await eraseCustomerFromAppDatabase('shop-1', '4021', 'impronta');

    expect(step(steps, 'customer_data_access_logs')).toMatchObject({ outcome: 'skipped' });
    expect(stepsFailed(steps)).toBe(false);
  });

  it('database che non risponde → passo fallito, non silenzio', async () => {
    deleteManyEvents.mockRejectedValue(new Error('database irraggiungibile'));

    const steps = await eraseCustomerFromAppDatabase('shop-1', '4021', 'impronta');

    expect(step(steps, 'sync_job_events')).toMatchObject({
      outcome: 'failed',
      detail: 'database irraggiungibile',
    });
    expect(stepsFailed(steps)).toBe(true);
  });
});
