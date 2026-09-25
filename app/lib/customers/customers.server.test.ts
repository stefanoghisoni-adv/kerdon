import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('~/lib/supabase/report-tables', () => ({
  existingReportTablesSQL: () => 'SELECT tables',
  missingReportTablesSQL: () => '',
  missingReportTables: () => [],
}));

import { prisma } from '~/db.server';
import { runQueryRows } from '~/lib/supabase-management.server';
import { ALL_TIME_START } from '~/lib/dates/ranges';
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
 * Risponde a seconda della query: la lettura di sempre non ha periodo; fra le
 * due con il periodo la prima a partire e' quella chiesta, la seconda il
 * periodo precedente (e' l'ordine in cui le lancia `Promise.all`).
 */
function rispondi(opts: { current: any[]; previous?: any[]; lifetime: any[] }) {
  let conPeriodo = 0;
  vi.mocked(runQueryRows).mockImplementation(async (_t: string, _r: string, sql: string) => {
    if (sql === 'SELECT tables') return [{ table_name: 'orders' }] as any;
    if (!sql.includes('placed_at')) return opts.lifetime as any;
    conPeriodo += 1;
    return (conPeriodo === 1 ? opts.current : (opts.previous ?? [])) as any;
  });
}

beforeEach(() => {
  vi.mocked(runQueryRows).mockReset();
  vi.mocked(prisma.shop.findUnique).mockResolvedValue(shop as any);
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

    const conPeriodo = vi
      .mocked(runQueryRows)
      .mock.calls.map((call) => call[2] as string)
      .filter((sql) => sql.includes('placed_at'));
    expect(conPeriodo).toHaveLength(1);
  });
});
