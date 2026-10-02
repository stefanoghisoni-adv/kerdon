import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Nessun database vero: il Prisma e la Management API sono finti, e la prova
// guarda solo quali domande partono e come le risposte diventano righe.
vi.mock('~/db.server', () => ({
  prisma: { shop: { findUnique: vi.fn() } },
}));

vi.mock('~/lib/supabase-oauth.server', () => ({
  getValidAccessToken: vi.fn(async () => 'token'),
}));

vi.mock('~/lib/supabase-management.server', () => ({
  runQuery: vi.fn(async () => []),
  runQueryRows: vi.fn(),
}));

// Quali tabelle il database finto dichiara di avere: tutte, salvo dove una
// prova dice altrimenti.
let tabelle: string[] = ['products', 'orders', 'order_lines', 'customers'];
vi.mock('~/lib/supabase/report-tables', () => ({
  existingReportTablesSQL: () => 'SELECT tables',
  missingReportTablesSQL: (existing: string[]) =>
    existing.length < 4 ? 'CREATE TABLES' : null,
  missingReportTables: () => [],
}));

// Redis finto in memoria: il ricordo delle tabelle presenti passa anche da li'.
const redisStore = new Map<string, string>();
vi.mock('ioredis', () => ({
  default: class {
    get = async (k: string) => redisStore.get(k) ?? null;
    set = async (k: string, v: string) => {
      redisStore.set(k, v);
      return 'OK';
    };
    del = async (k: string) => (redisStore.delete(k) ? 1 : 0);
  },
}));
vi.mock('~/lib/queue/connection.server', () => ({ redisConnectionOptions: () => ({}) }));

import { prisma } from '~/db.server';
import { runQuery, runQueryRows } from '~/lib/supabase-management.server';
import { ALL_TIME_START } from '~/lib/dates/ranges';
import { resetReportTablesMemory } from '~/lib/cache/report-tables-cache.server';
import { ServerTiming } from '~/lib/timing/server-timing';
import { loadCustomersReport } from './customers.server';

const shop = {
  id: 'shop-1',
  scopes: 'read_orders,read_all_orders,read_customers',
  ianaTimezone: 'Europe/Rome',
  supabaseConfig: { connectionVerifiedAt: new Date(), supabaseProjectRef: 'ref' },
};

const riga = (id: number, profit: number) => ({
  customer_id: id,
  first_name: `Nome${id}`,
  last_name: null,
  orders: 1,
  profit,
  covered_lines: 1,
  total_lines: 1,
  currency: 'EUR',
  synced: true,
  email: null,
  phone: null,
});

/**
 * Risponde a seconda della query: il controllo delle tabelle riceve l'elenco di
 * quelle presenti, la lettura una riga sola con le tre parti del report, come
 * le restituisce Postgres.
 */
function rispondi(opts: { current: any[]; previous?: any[]; lifetime: any[] }) {
  vi.mocked(runQueryRows).mockImplementation(async (_t: string, _r: string, sql: string) => {
    if (sql === 'SELECT tables') return tabelle.map((table_name) => ({ table_name })) as any;
    return [
      {
        current_rows: opts.current,
        previous_rows: opts.previous ?? [],
        lifetime_rows: opts.lifetime,
      },
    ] as any;
  });
}

const sqlInviate = () => vi.mocked(runQueryRows).mock.calls.map((call) => call[2] as string);
const controlliTabelle = () => sqlInviate().filter((sql) => sql === 'SELECT tables').length;
const letture = () => sqlInviate().filter((sql) => sql !== 'SELECT tables');

const apri = (from = '2026-08-27') =>
  loadCustomersReport({ shopDomain: 'x.myshopify.com', from, to: '2026-09-25' });

beforeEach(() => {
  tabelle = ['products', 'orders', 'order_lines', 'customers'];
  redisStore.clear();
  resetReportTablesMemory();
  vi.mocked(runQueryRows).mockReset();
  vi.mocked(prisma.shop.findUnique).mockResolvedValue(shop as any);
  vi.mocked(runQuery).mockReset();
  vi.mocked(runQuery).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadCustomersReport', () => {
  it('dice quanti clienti hanno comprato da sempre, per poterlo confrontare col periodo', async () => {
    rispondi(
      {
        current: [riga(1, 30)],
        lifetime: [
          { customer_id: 1, orders: 3, profit: 90 },
          { customer_id: 2, orders: 2, profit: 40 },
        ],
      },
    );

    const report = await loadCustomersReport({
      shopDomain: 'x.myshopify.com',
      from: '2026-08-27',
      to: '2026-09-25',
    });

    expect(report.rows.map((r) => r.customerId)).toEqual([1]);
    expect(report.rows[0].lifetimeProfit).toBe(90);
    expect(report.lifetimeCustomers).toBe(2);
  });

  it('"da sempre" mostra anche chi ha ordinato mesi fa, con il suo profitto di sempre', async () => {
    rispondi(
      {
        current: [riga(1, 90), riga(2, 40)],
        lifetime: [
          { customer_id: 1, orders: 3, profit: 90 },
          { customer_id: 2, orders: 2, profit: 40 },
        ],
      },
    );

    const report = await loadCustomersReport({
      shopDomain: 'x.myshopify.com',
      from: ALL_TIME_START,
      to: '2026-09-25',
    });

    expect(report.rows.map((r) => r.customerId)).toEqual([1, 2]);
    expect(report.rows.map((r) => r.lifetimeProfit)).toEqual([90, 40]);
    // Prima di "da sempre" non c'e' niente: nessuna variazione da mostrare.
    expect(report.rows.every((r) => r.profitChange === null)).toBe(true);
    expect(report.lifetimeCustomers).toBe(2);
  });

  it('"da sempre" non chiede il periodo precedente: non esiste', async () => {
    rispondi({ current: [riga(1, 90)], lifetime: [] });

    await loadCustomersReport({
      shopDomain: 'x.myshopify.com',
      from: ALL_TIME_START,
      to: '2026-09-25',
    });

    expect(letture()).toHaveLength(1);
    expect(letture()[0]).toMatch(/'\[\]'::json AS previous_rows/);
  });

  it('le tre parti viaggiano in una sola richiesta, e la variazione si calcola sul prima', async () => {
    rispondi({
      current: [riga(1, 30)],
      previous: [{ ...riga(1, 20), profit: '20.00' }],
      lifetime: [{ customer_id: 1, orders: 3, profit: 90 }],
    });

    const report = await apri();

    expect(letture()).toHaveLength(1);
    expect(letture()[0]).toMatch(/AS current_rows[\s\S]*AS previous_rows[\s\S]*AS lifetime_rows/);
    expect(report.rows[0].profitChange).toBe(50);
  });

  it('accetta le parti anche come testo JSON', async () => {
    vi.mocked(runQueryRows).mockImplementation(async (_t: string, _r: string, sql: string) => {
      if (sql === 'SELECT tables') return tabelle.map((table_name) => ({ table_name })) as any;
      return [
        {
          current_rows: JSON.stringify([riga(1, 30)]),
          previous_rows: '[]',
          lifetime_rows: JSON.stringify([{ customer_id: 1, orders: 1, profit: 30 }]),
        },
      ] as any;
    });

    const report = await apri();
    expect(report.rows.map((r) => r.customerId)).toEqual([1]);
    expect(report.lifetimeCustomers).toBe(1);
  });
});

describe('loadCustomersReport — controllo delle tabelle', () => {
  it('alla seconda apertura non richiede se le tabelle esistono', async () => {
    rispondi({ current: [riga(1, 30)], lifetime: [] });

    await apri();
    await apri();

    expect(controlliTabelle()).toBe(1);
    // La seconda apertura e' una richiesta sola: il report.
    expect(sqlInviate().slice(-1)[0]).not.toBe('SELECT tables');
    expect(letture()).toHaveLength(2);
  });

  it('dopo un "relation does not exist" ricontrolla, provvede e rilegge', async () => {
    rispondi({ current: [riga(1, 30)], lifetime: [] });
    await apri();
    expect(controlliTabelle()).toBe(1);

    // La tabella sparisce dopo che la si era vista: la lettura fallisce una
    // volta, il controllo la trova mancante, la DDL la rifa' e si rilegge.
    tabelle = ['products', 'orders', 'order_lines'];
    const ok = vi.mocked(runQueryRows).getMockImplementation()!;
    vi.mocked(runQueryRows).mockImplementationOnce(async () => {
      throw new Error(
        'Supabase query error: 400 \u2014 {"message":"ERROR:  42P01: relation \\"customers\\" does not exist"}',
      );
    });
    vi.mocked(runQueryRows).mockImplementation(ok);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const report = await apri();

    expect(controlliTabelle()).toBe(2);
    expect(runQuery).toHaveBeenCalledWith('token', 'ref', 'CREATE TABLES');
    expect(report.rows.map((r) => r.customerId)).toEqual([1]);
  });

  it('un errore diverso non fa ricontrollare: arriva a chi chiama', async () => {
    rispondi({ current: [], lifetime: [] });
    await apri();
    vi.mocked(runQueryRows).mockImplementationOnce(async () => {
      throw new Error('Supabase query error: 500');
    });

    await expect(apri()).rejects.toThrow('500');
    expect(controlliTabelle()).toBe(1);
  });

  it('tabelle mancanti e DDL non riuscita: alla prossima apertura si ricontrolla', async () => {
    tabelle = ['products'];
    vi.mocked(runQuery).mockRejectedValue(new Error('permesso negato'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rispondi({ current: [], lifetime: [] });

    await apri();
    await apri();

    expect(controlliTabelle()).toBe(2);
  });

  it('tabelle mancanti e DDL riuscita: dopo non si ricontrolla piu', async () => {
    tabelle = ['products'];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rispondi({ current: [], lifetime: [] });

    await apri();
    await apri();

    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(controlliTabelle()).toBe(1);
  });

  it('scrive i tempi di ogni fase', async () => {
    rispondi({ current: [riga(1, 30)], lifetime: [] });
    const timing = new ServerTiming();

    await loadCustomersReport({
      shopDomain: 'x.myshopify.com',
      from: '2026-08-27',
      to: '2026-09-25',
      timing,
    });

    const fasi = timing.header().split(', ').map((p) => p.split(';')[0]);
    expect(fasi).toEqual(expect.arrayContaining(['shop', 'token', 'ensure', 'report']));
  });
});
