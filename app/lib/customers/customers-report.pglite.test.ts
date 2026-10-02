/**
 * La lettura unica della tab Clienti, provata su un Postgres vero.
 *
 * `customersReportSQL` mette in una sola istruzione le tre query di prima
 * (periodo, periodo precedente, profitto di sempre). La promessa e' che il
 * risultato sia lo STESSO, riga per riga, di quello delle tre lanciate da
 * sole — e questo si dimostra eseguendole, non leggendone il testo.
 *
 * PGlite e' Postgres in WebAssembly, in memoria e usa e getta. Lo schema e'
 * quello che l'app crea nel database del merchant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  buildCustomersSchemaSQL,
  buildOrdersSchemaSQL,
  buildProductsSchemaSQL,
} from '~/lib/supabase-schema';
import { customersInRangeSQL, customersReportSQL, lifetimeProfitSQL } from './customers-query';

const RANGE = { from: '2026-08-01', to: '2026-08-31', timeZone: 'Europe/Rome' } as const;
const PREVIOUS = { from: '2026-07-02', to: '2026-07-31', timeZone: 'Europe/Rome' } as const;

let db: PGlite;

/** Dal JSON i numeri arrivano come numeri, dalle query sole a volte come testo. */
function normalize(rows: Record<string, unknown>[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [
        k,
        typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v,
      ]),
    ),
  );
}

const byCustomer = (rows: Record<string, unknown>[]) =>
  normalize(rows).sort((a, b) => Number(a.customer_id) - Number(b.customer_id));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(buildProductsSchemaSQL() + buildCustomersSchemaSQL() + buildOrdersSchemaSQL());
  await db.exec(`
INSERT INTO products (shopify_product_id, product_title, price, shopify_variant_id, cost_per_item)
VALUES (1, 'Maglia', 20, 11, 5), (2, 'Felpa', 30, 22, NULL);
INSERT INTO customers (shopify_customer_id, email_address, first_name) VALUES (7001, 'a@x.it', 'Anna');
`);
  // Sei date, tre clienti ciascuna: due che tornano sempre e uno nuovo ogni
  // volta. Righe con e senza costo, per avere coperture diverse.
  const dates = ['2026-06-10', '2026-07-15', '2026-08-05', '2026-08-20', '2026-08-25', '2025-01-01'];
  let order = 100;
  let line = 1000;
  for (const [i, day] of dates.entries()) {
    for (const customer of [7001, 7002, 7003 + i]) {
      order += 1;
      await db.exec(`
INSERT INTO orders (shopify_order_id, shopify_customer_id, customer_first_name, currency, placed_at)
VALUES (${order}, ${customer}, 'C${customer}', 'EUR', '${day} 10:00');
INSERT INTO order_lines (shopify_line_id, shopify_order_id, shopify_variant_id, line_net_total, current_quantity, line_currency)
VALUES (${++line}, ${order}, 11, 40, 2, 'EUR'), (${++line}, ${order}, ${customer % 2 ? 22 : 11}, 30, 1, 'EUR');
`);
    }
  }
});

afterAll(async () => {
  await db.close();
});

describe('customersReportSQL su Postgres', () => {
  it('restituisce le stesse righe delle tre query lanciate da sole', async () => {
    const current = (await db.query(customersInRangeSQL(RANGE))).rows as Record<string, unknown>[];
    const previous = (await db.query(customersInRangeSQL(PREVIOUS))).rows as Record<string, unknown>[];
    const lifetime = (await db.query(lifetimeProfitSQL())).rows as Record<string, unknown>[];
    expect(current.length).toBeGreaterThan(1);
    expect(previous.length).toBeGreaterThan(0);

    const { rows } = await db.query<Record<string, Record<string, unknown>[]>>(
      customersReportSQL({ current: RANGE, previous: PREVIOUS }),
    );

    expect(rows).toHaveLength(1);
    // Il periodo nello stesso ordine: e' quello in cui la tabella lo mostra.
    expect(normalize(rows[0].current_rows)).toEqual(normalize(current));
    expect(byCustomer(rows[0].previous_rows)).toEqual(byCustomer(previous));
    expect(byCustomer(rows[0].lifetime_rows)).toEqual(byCustomer(lifetime));
  });

  it('senza periodo precedente quella parte e\' vuota', async () => {
    const { rows } = await db.query<Record<string, unknown[]>>(
      customersReportSQL({ current: RANGE, previous: null }),
    );
    expect(rows[0].previous_rows).toEqual([]);
  });

  it('un periodo senza ordini da\' un elenco vuoto, non null', async () => {
    const { rows } = await db.query<Record<string, unknown[]>>(
      customersReportSQL({
        current: { from: '2030-01-01', to: '2030-01-02', timeZone: 'Europe/Rome' },
        previous: null,
      }),
    );
    expect(rows[0].current_rows).toEqual([]);
  });
});
