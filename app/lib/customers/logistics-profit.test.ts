/**
 * Il costo logistico nel profitto, provato su un Postgres vero.
 *
 * Perche' eseguito e non solo letto: l'errore da cui ci si difende e' un errore
 * di MOLTIPLICAZIONE, non di testo. Le query uniscono `orders` a `order_lines`,
 * quindi un ordine con quattro righe compare quattro volte, e un costo scritto
 * sull'ordine sommato "normalmente" verrebbe tolto quattro volte. Una query
 * che contiene la parola giusta puo' ancora sommare quattro volte: solo
 * eseguirla lo dice.
 *
 * PGlite e' Postgres in WebAssembly, in memoria e usa e getta: nessun database
 * vero viene toccato. Lo schema e' quello che l'app crea nel database del
 * merchant, non una copia scritta a mano.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  buildCustomersSchemaSQL,
  buildOrdersSchemaSQL,
  buildProductsSchemaSQL,
} from '~/lib/supabase-schema';
import {
  averagesSQL,
  customersInRangeSQL,
  lifetimeProfitSQL,
  shopProfitSQL,
} from './customers-query';

const RANGE = { from: '2026-08-01', to: '2026-08-31', timeZone: 'Europe/Rome' } as const;

let db: PGlite;

/** Una riga: netto 20, costo 5, un pezzo → contributo 15. */
function line(id: number, order: number, currency = 'EUR'): string {
  return `(${id}, ${order}, 1, 20, 1, '${currency}')`;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(buildProductsSchemaSQL() + buildCustomersSchemaSQL() + buildOrdersSchemaSQL());

  await db.exec(`
INSERT INTO products (shopify_product_id, product_title, price, shopify_variant_id, cost_per_item)
VALUES (1, 'Maglia', 20, 1, 5);

INSERT INTO orders (shopify_order_id, shopify_customer_id, currency, placed_at, cancelled_at, logistics_cost) VALUES
  -- A: quattro righe, costo logistico 10 → 60 - 10 = 50 (non 60 - 40 = 20).
  (1, 100, 'EUR', '2026-08-10 12:00', NULL, 10),
  -- B: scritto prima della funzione, costo logistico NULL → vale 0, profitto 15.
  (2, 100, 'EUR', '2026-08-11 12:00', NULL, NULL),
  -- C: annullato → non e' una vendita, non sottrae niente.
  (3, 100, 'EUR', '2026-08-12 12:00', '2026-08-13 12:00', 7),
  -- D: valute discordi → fuori dal conto, non sottrae niente.
  (4, 200, 'EUR', '2026-08-14 12:00', NULL, 9),
  -- E: due righe, costo logistico 3 → 30 - 3 = 27.
  (5, 200, 'EUR', '2026-08-15 12:00', NULL, 3),
  -- F: fuori periodo (luglio), costo 4 → conta solo nel lifetime: 15 - 4 = 11.
  (6, 200, 'EUR', '2026-07-01 12:00', NULL, 4);

INSERT INTO order_lines (shopify_line_id, shopify_order_id, shopify_variant_id, line_net_total, current_quantity, line_currency) VALUES
  ${[
    line(11, 1), line(12, 1), line(13, 1), line(14, 1),
    line(21, 2),
    line(31, 3), line(32, 3),
    line(41, 4), line(42, 4, 'USD'),
    line(51, 5), line(52, 5),
    line(61, 6),
  ].join(',\n  ')};
`);
});

afterAll(async () => {
  await db?.close();
});

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  const res = await db.query<Record<string, unknown>>(sql);
  return res.rows;
}

describe('il costo logistico si sottrae una volta per ordine', () => {
  it('per cliente nel periodo: 4 righe e costo 10 tolgono 10, non 40', async () => {
    const result = await rows(customersInRangeSQL(RANGE));
    const byCustomer = new Map(result.map((r) => [Number(r.customer_id), Number(r.profit)]));

    // Cliente 100: A (60 - 10) + B (15 - 0), l'annullato C non c'e'.
    expect(byCustomer.get(100)).toBe(65);
    // Cliente 200: solo E (30 - 3); D ha valute discordi, F e' fuori periodo.
    expect(byCustomer.get(200)).toBe(27);
  });

  it('il profitto di sempre: stesso conto, senza periodo', async () => {
    const result = await rows(lifetimeProfitSQL());
    const byCustomer = new Map(result.map((r) => [Number(r.customer_id), Number(r.profit)]));

    expect(byCustomer.get(100)).toBe(65);
    // E (27) + F (15 - 4 = 11).
    expect(byCustomer.get(200)).toBe(38);
  });

  it('il totale del negozio nel periodo', async () => {
    const [row] = await rows(shopProfitSQL(RANGE));
    expect(Number(row.profit)).toBe(92);
  });

  it('le medie: il profitto si abbassa, il ricavo no', async () => {
    const [row] = await rows(averagesSQL(RANGE));
    expect(Number(row.profit)).toBe(92);
    // Ricavo: A 80 + B 20 + E 40. Il costo logistico non e' un mancato incasso.
    expect(Number(row.revenue)).toBe(140);
  });

  it('un costo logistico NULL non rende NULL il profitto', async () => {
    // Solo l'ordine B, che il costo non ce l'ha: il profitto resta 15.
    const [row] = await rows(
      shopProfitSQL({ from: '2026-08-11', to: '2026-08-11', timeZone: 'Europe/Rome' }),
    );
    expect(row.profit).not.toBeNull();
    expect(Number(row.profit)).toBe(15);
  });

  it('un ordine annullato non sottrae niente', async () => {
    // Solo l'ordine C nel giorno scelto: annullato, quindi niente vendita e
    // niente costo logistico — zero, non -7.
    const [row] = await rows(
      shopProfitSQL({ from: '2026-08-12', to: '2026-08-12', timeZone: 'Europe/Rome' }),
    );
    expect(Number(row.profit)).toBe(0);
  });
});
