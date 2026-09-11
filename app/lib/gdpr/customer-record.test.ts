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
  eraseCustomerFromAppDatabase,
  eraseCustomerFromMerchant,
  stepsFailed,
  type GdprStep,
} from './customer-record.server';

type Result = { data?: unknown; error?: unknown; count?: number; maxRows?: number };

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

  /**
   * Una lettura come la restituisce PostgREST, impaginata per chiave: si
   * filtra, si dice da quale chiave ripartire (`.gt`), si ordina e si limita.
   * Il conteggio e' quello vero della tabella finta, non quello della pagina —
   * e' esattamente la differenza che permette di accorgersi di una lettura
   * fermata a meta'.
   */
  function selectChain(table: string, filter: unknown) {
    calls.push({ table, op: 'select', filter });
    const result = reply(table);
    const rows = (result.data ?? []) as Record<string, unknown>[];
    const count = result.error ? undefined : result.count ?? rows.length;

    // `maxRows` e' il tetto per risposta del progetto: se e' piu' basso della
    // pagina richiesta, il database ne serve meno di quante gliene si chiedono.
    const cap = result.maxRows ?? Infinity;

    let after: string | null = null;
    let chiave = 'id';

    const chain: any = {
      gt: (col: string, valore: unknown) => {
        chiave = col;
        after = String(valore);
        return chain;
      },
      order: (col: string) => {
        chiave = col;
        return chain;
      },
      limit: (quante: number) => {
        if (result.error) {
          const rotto = { ...result, count };
          return {
            ...rotto,
            then: (ok: (v: Result) => unknown, ko?: (e: unknown) => unknown) =>
              Promise.resolve(rotto).then(ok, ko),
          };
        }

        const ordinate = [...rows].sort((a, b) =>
          String(a[chiave]).localeCompare(String(b[chiave])),
        );
        const dopo =
          after === null
            ? ordinate
            : ordinate.filter((r) => String(r[chiave]) > (after as string));
        const base = { ...result, count, data: dopo.slice(0, Math.min(quante, cap)) };

        return {
          ...base,
          then: (ok: (v: Result) => unknown, ko?: (e: unknown) => unknown) =>
            Promise.resolve(base).then(ok, ko),
        };
      },
      then: (ok: (v: Result) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve({ ...result, count }).then(ok, ko),
    };

    return chain;
  }

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
        eq: (_col: string, value: unknown) => selectChain(table, value),
        in: (_col: string, values: unknown) => selectChain(table, values),
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

    // `users` sta in fondo e non e' un dettaglio: e' la tabella dei browser da
    // cui la persona e' stata riconosciuta, e finche' non compariva qui una
    // cancellazione dichiarata completa lasciava indietro righe che puntavano
    // ancora al suo id Shopify.
    expect(steps.map((s) => s.table)).toEqual(['customers', 'orders', 'order_lines', 'users']);
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

// LA RACCOLTA PER LA RICHIESTA DI ACCESSO E' PROVATA IN
// `subject-snapshot.test.ts`, insieme alla fotografia sotto lucchetto che
// adesso la precede: leggere per consegnare non e' piu' la stessa cosa che
// leggere per cancellare, e le due prove non stanno piu' nello stesso file.

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
