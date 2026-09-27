/**
 * Una cancellazione resta una cancellazione, provato su un Postgres vero.
 *
 * IL GUASTO. `customers/redact` toglieva dagli ordini della persona
 * identificativo, nome e paese di spedizione. Poi arrivava un `orders/updated`,
 * o il recupero dello storico con `COALESCE(o.shipping_country_code, v.cc)`, e
 * rimetteva tutto dentro, leggendolo da Shopify. Nessuna delle due scritture
 * era sbagliata presa da sola.
 *
 * IL RIMEDIO e' nel database del merchant: la cancellazione marca gli ordini
 * (`customer_redacted_at`) e il trigger `kerdon_orders_keep_redacted` tiene
 * vuote quelle colonne contro qualunque scrittura. Qui si eseguono le
 * scritture VERE — l'upsert come lo fa PostgREST con le righe di
 * `orderToRows`, l'UPDATE del recupero con un salto di versione, l'UPDATE del
 * ricalcolo — sullo schema che l'app crea davvero. PGlite e' Postgres in
 * WebAssembly, in memoria: nessun database vero viene toccato.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

vi.mock('~/db.server', () => ({ prisma: {} }));
vi.mock('~/shopify.server', () => ({ unauthenticated: { admin: vi.fn() } }));

import { buildOrdersSchemaSQL, ORDER_COLUMNS_CLEARED_ON_ERASURE } from '~/lib/supabase-schema';
import { orderToRows, orderUpsertBatches, type ShopifyOrder } from '~/lib/customers/order-rows';
import { backfillUpdateSQL, type BackfillValue } from '~/lib/shipping/shipping-method-backfill.server';
import { recomputeUpdateSQL } from '~/lib/shipping/recompute.server';
import { LOGISTICS_FACTS_VERSION } from '~/lib/shipping/order-logistics-facts';
import { ANONYMOUS_ORDER, REDACTED_MARKER } from './customer-record.server';
import type { LogisticsConfig } from '~/lib/shipping/types';

const CONFIG: LogisticsConfig = {
  zones: [
    {
      zoneName: 'Italia',
      countries: ['IT'],
      restOfWorld: false,
      rateType: 'per_package',
      rates: [{ weightFromKg: null, weightToKg: null, cost: 5 }],
      options: [],
    },
  ],
  categories: [{ name: 'Scatola M', cost: 1.2 }],
  fallbackRules: [],
  defaultWeightPerItemKg: null,
  returnCost: 6,
};

/** L'ordine come lo rilegge la sincronizzazione da Shopify, persona compresa. */
const daShopify = (over: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: 4242,
  order_number: '#4242',
  placed_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-10T00:00:00Z',
  cancelled_at: null,
  financial_status: 'paid',
  total_price: '120.00',
  currency: 'EUR',
  customer_id: 7,
  customer_first_name: 'Ada',
  customer_last_name: 'Rossi',
  lines: [],
  lines_complete: true,
  fulfillment_status: 'FULFILLED',
  shipping_country_code: 'IT',
  total_weight_grams: 3000,
  returned_at: null,
  packaging_category: 'Scatola M',
  shipping_method: 'Standard',
  package_count: 1,
  logistics_unknown: [],
  ...over,
});

let db: PGlite;

/** Il letterale SQL di un valore JS, per rifare a mano l'upsert di PostgREST. */
function letterale(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * L'upsert come lo esegue PostgREST con `onConflict: 'shopify_order_id'`:
 * INSERT ... ON CONFLICT DO UPDATE sulle sole colonne presenti nella riga.
 */
async function upsert(order: ShopifyOrder): Promise<void> {
  const rows = orderToRows(order, new Date('2026-09-01T00:00:00Z'), CONFIG)!;
  for (const gruppo of orderUpsertBatches([rows])) {
    for (const riga of gruppo) {
      const colonne = Object.keys(riga);
      const valori = colonne.map((c) => letterale((riga as Record<string, unknown>)[c]));
      const aggiorna = colonne
        .filter((c) => c !== 'shopify_order_id')
        .map((c) => `${c} = EXCLUDED.${c}`)
        .join(', ');
      await db.exec(
        `INSERT INTO orders (${colonne.join(', ')}) VALUES (${valori.join(', ')})
         ON CONFLICT (shopify_order_id) DO UPDATE SET ${aggiorna};`,
      );
    }
  }
}

/** La cancellazione, con gli stessi valori che manda eraseCustomerFromMerchant. */
async function cancella(customerId: number): Promise<void> {
  const set = [
    ...Object.keys(ANONYMOUS_ORDER).map((c) => `${c} = NULL`),
    `${REDACTED_MARKER} = '2026-09-02T00:00:00Z'`,
  ].join(', ');
  await db.exec(`UPDATE orders SET ${set} WHERE shopify_customer_id = ${customerId};`);
}

async function ordine(id = 4242): Promise<Record<string, unknown>> {
  const r = await db.query<Record<string, unknown>>(
    `SELECT shopify_customer_id, customer_first_name, customer_last_name, shipping_country_code,
            customer_redacted_at, logistics_cost::text AS logistics_cost, package_count,
            fulfillment_status, logistics_facts_version
     FROM orders WHERE shopify_order_id = ${id};`,
  );
  return r.rows[0];
}

function cancellato(riga: Record<string, unknown>): void {
  for (const colonna of ORDER_COLUMNS_CLEARED_ON_ERASURE) {
    expect(riga[colonna], colonna).toBeNull();
  }
  expect(riga.customer_redacted_at).not.toBeNull();
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(buildOrdersSchemaSQL());
  // Due volte: la DDL si riapplica a ogni aggiornamento dello schema, e il
  // trigger deve sopravvivere alla seconda passata senza errori ne' doppioni.
  await db.exec(buildOrdersSchemaSQL());
  await upsert(daShopify());
});

describe('un ordine cancellato resta cancellato', () => {
  it('la cancellazione toglie persona e paese, e marca la riga', async () => {
    const prima = await ordine();
    expect(prima.shopify_customer_id).not.toBeNull();
    expect(prima.shipping_country_code).toBe('IT');

    await cancella(7);

    cancellato(await ordine());
  });

  it('dopo un orders/updated che riporta la persona da Shopify', async () => {
    await cancella(7);

    // Shopify rimanda l'ordine con cliente, nome e paese ancora dentro.
    await upsert(daShopify({ package_count: 2 }));

    const dopo = await ordine();
    cancellato(dopo);
    // Il resto dell'ordine si aggiorna come sempre: e' solo la persona a non tornare.
    expect(dopo.package_count).toBe(2);
  });

  it('dopo un recupero dello storico con un salto di versione', async () => {
    await db.exec(`UPDATE orders SET logistics_facts_version = 0;`);
    await cancella(7);

    const valore: BackfillValue = {
      id: '4242',
      found: true,
      method: 'Standard',
      packageCount: 3,
      returnedAt: null,
      returnsKnown: true,
      fulfillmentStatus: 'FULFILLED',
      countryCode: 'IT',
      countryKnown: true,
    };
    await db.exec(backfillUpdateSQL([valore]));

    const dopo = await ordine();
    cancellato(dopo);
    // Il recupero ha lavorato davvero: pacchi e versione sono quelli nuovi.
    expect(dopo.package_count).toBe(3);
    expect(dopo.logistics_facts_version).toBe(LOGISTICS_FACTS_VERSION);
  });

  it('la marcatura non si toglie con una scrittura qualsiasi', async () => {
    await cancella(7);
    await db.exec(`UPDATE orders SET customer_redacted_at = NULL, shopify_customer_id = 7;`);
    cancellato(await ordine());
  });

  it('un ordine mai cancellato si aggiorna come prima', async () => {
    await upsert(daShopify({ customer_first_name: 'Adele', shipping_country_code: 'FR' }));
    const dopo = await ordine();
    expect(dopo.customer_first_name).toBe('Adele');
    expect(dopo.shipping_country_code).toBe('FR');
    expect(dopo.customer_redacted_at).toBeNull();
  });
});

describe('il costo logistico di un ordine cancellato', () => {
  it('il ricalcolo senza paese non riporta spedizione e imballo a zero', async () => {
    const prima = (await ordine()).logistics_cost;
    // 5 di spedizione (un pacco) + 1,20 di imballo.
    expect(prima).toBe('6.20');

    await cancella(7);
    // Il ricalcolo rilegge l'ordine senza paese e calcola 0: senza guardia,
    // il profitto di quell'ordine salirebbe di 6,20 senza che niente sia cambiato.
    await db.exec(recomputeUpdateSQL([{ id: '4242', cost: 0 }]));

    expect((await ordine()).logistics_cost).toBe('6.20');
  });

  it('un ordine non cancellato si ricalcola come sempre', async () => {
    await db.exec(recomputeUpdateSQL([{ id: '4242', cost: 9 }]));
    expect((await ordine()).logistics_cost).toBe('9.00');
  });
});
