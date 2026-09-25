import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLAN_CURRENCIES, PLAN_TIERS } from '../app/lib/billing/plan-tiers';

/**
 * Il listino e' scritto in tre posti, e devono dire la stessa cosa:
 *
 *   - app/lib/billing/plan-tiers.ts, il listino deciso;
 *   - il seed di owner-bootstrap.sql (e di `0_init`, che ne e' la copia);
 *   - lo stato in cui le migrazioni portano un database che parte dai nomi di
 *     prima — Free/Pro/Business/Enterprise, oppure Free/Core/Growth/Scale.
 *
 * Non si confrontano i testi: si eseguono. Un Postgres vero in memoria (PGlite,
 * lo stesso delle prove e2e) riceve le migrazioni del repository, e si legge
 * cosa c'e' nelle tabelle alla fine.
 */

const ROOT = resolve(__dirname, '..');
const MIGRAZIONI = resolve(ROOT, 'prisma/migrations');
const PRICING_ALIGNMENT = '20260923000000_pricing_alignment';

function cartelle(): string[] {
  return readdirSync(MIGRAZIONI)
    .filter((nome) => statSync(resolve(MIGRAZIONI, nome)).isDirectory())
    .sort();
}

function sql(cartella: string): string {
  return readFileSync(resolve(MIGRAZIONI, cartella, 'migration.sql'), 'utf8');
}

async function applica(db: PGlite, elenco: string[]): Promise<void> {
  for (const cartella of elenco) {
    try {
      await db.exec(sql(cartella));
    } catch (errore) {
      throw new Error(
        `migrazione ${cartella}: ${errore instanceof Error ? errore.message : String(errore)}`,
      );
    }
  }
}

/** Il listino com'era prima del 23 settembre (stato A). */
const LISTINO_A = `
  DELETE FROM "plans" WHERE "plan_name" <> 'Lifetime';
  INSERT INTO "plans" ("id", "plan_name", "max_products", "max_customers", "max_sync_frequency_hours", "custom_fields_limit", "support_level", "customers_sync_enabled", "product_feeds_enabled", "trial_days") VALUES
    ('60b36215-e0d0-48e4-8f59-1550028a1078', 'Free',        50,  200, 168,    3, 'community', false, false, 14),
    ('316217c4-3a7b-40f8-9f7c-8d5ddc1d5daa', 'Pro',        200,  500,  96,   10, 'email',     true,  true,  14),
    ('eb31cfe0-d134-4421-a4d6-0f6e2a89f88d', 'Business',  1000, 2000,  48,   50, 'priority',  true,  true,  14),
    ('fdf4476c-ab51-44f7-ba28-a785cddb3ec9', 'Enterprise',NULL, NULL,  24, NULL, 'dedicated', true,  true,  14);
  INSERT INTO "plan_prices" ("id", "plan_name", "currency", "price_monthly", "price_yearly") VALUES
    (gen_random_uuid(), 'Free',       'USD',  0,    0),
    (gen_random_uuid(), 'Pro',        'USD', 19,  290),
    (gen_random_uuid(), 'Business',   'USD', 49,  990),
    (gen_random_uuid(), 'Enterprise', 'USD', 79, 2990);
`;

async function negozio(db: PGlite, id: string, piano: string, ultimo: string | null = null) {
  await db.query(
    `INSERT INTO "shops" ("id", "shop_domain", "access_token", "scopes", "current_plan", "last_synced_plan")
     VALUES ($1, $2, 'x', 'x', $3, $4)`,
    [id, `${id}.myshopify.com`, piano, ultimo],
  );
}

async function addebito(db: PGlite, id: string, shopId: string, piano: string) {
  await db.query(
    `INSERT INTO "billing_charges" ("id", "shop_id", "plan_type", "status")
     VALUES ($1, $2, $3, 'active')`,
    [id, shopId, piano],
  );
}

async function prezzoPartner(db: PGlite, piano: string) {
  await db.query(
    `INSERT INTO "partner_plan_prices" ("id", "partner_name", "plan_name", "price_monthly", "price_yearly")
     VALUES (gen_random_uuid()::text, 'own_partner', $1, 10, 100)`,
    [piano],
  );
}

async function pianoDi(db: PGlite, shopId: string) {
  const { rows } = await db.query<{ current_plan: string; last_synced_plan: string | null }>(
    `SELECT "current_plan", "last_synced_plan" FROM "shops" WHERE "id" = $1`,
    [shopId],
  );
  return rows[0];
}

async function colonna(db: PGlite, tabella: string, nome: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [tabella, nome],
  );
  return rows.length > 0;
}

/** Il listino deciso, e che il database lo rispecchi riga per riga. */
async function verificaListino(db: PGlite): Promise<void> {
  const { rows: piani } = await db.query<{
    plan_name: string;
    max_products: number | null;
    max_customers: number | null;
    customers_sync_enabled: boolean;
    product_feeds_enabled: boolean;
  }>(
    `SELECT "plan_name", "max_products", "max_customers", "customers_sync_enabled", "product_feeds_enabled"
     FROM "plans" ORDER BY "plan_name"`,
  );

  expect(piani.map((p) => p.plan_name).sort()).toEqual(
    [...PLAN_TIERS.map((t) => t.name), 'Lifetime'].sort(),
  );

  for (const tier of PLAN_TIERS) {
    const riga = piani.find((p) => p.plan_name === tier.name);
    expect(riga, tier.name).toEqual({
      plan_name: tier.name,
      max_products: tier.maxProducts,
      max_customers: tier.maxCustomers,
      customers_sync_enabled: tier.customersSyncEnabled,
      product_feeds_enabled: tier.productFeedsEnabled,
    });
  }

  const { rows: prezzi } = await db.query<{
    plan_name: string;
    currency: string;
    price_monthly: string;
    price_yearly: string;
  }>(`SELECT "plan_name", "currency", "price_monthly"::text, "price_yearly"::text FROM "plan_prices"`);

  for (const tier of PLAN_TIERS) {
    for (const valuta of PLAN_CURRENCIES) {
      const riga = prezzi.find((p) => p.plan_name === tier.name && p.currency === valuta);
      expect(riga, `${tier.name} ${valuta}`).toBeDefined();
      expect(Number(riga!.price_monthly), `${tier.name} ${valuta} mensile`).toBe(tier.priceMonthly);
      expect(Number(riga!.price_yearly), `${tier.name} ${valuta} annuale`).toBe(tier.priceYearly);
    }
  }

  // Il Lifetime resta com'era: illimitato, tutto incluso, a zero.
  const { rows: lifetime } = await db.query<{
    max_products: number | null;
    max_customers: number | null;
    support_level: string;
    customers_sync_enabled: boolean;
    product_feeds_enabled: boolean;
  }>(
    `SELECT "max_products", "max_customers", "support_level", "customers_sync_enabled", "product_feeds_enabled"
     FROM "plans" WHERE "plan_name" = 'Lifetime'`,
  );
  expect(lifetime[0]).toEqual({
    max_products: null,
    max_customers: null,
    support_level: 'dedicated',
    customers_sync_enabled: true,
    product_feeds_enabled: true,
  });

  // Gli ordini non hanno limite: la colonna non c'e'.
  expect(await colonna(db, 'plans', 'max_orders')).toBe(false);
}

describe('il listino e\' lo stesso in codice, bootstrap e migrazioni', () => {
  it('owner-bootstrap.sql semina esattamente plan-tiers.ts', async () => {
    const db = new PGlite();
    await db.exec(readFileSync(resolve(ROOT, 'prisma/owner-bootstrap.sql'), 'utf8'));
    await verificaListino(db);
    await db.close();
  }, 60_000);

  it('tutte le migrazioni su un database vuoto arrivano allo stesso listino', async () => {
    const db = new PGlite();
    await applica(db, cartelle());
    await verificaListino(db);
    await db.close();
  }, 60_000);

  it('dallo stato A (Free/Pro/Business/Enterprise) con tutte le migrazioni in coda', async () => {
    const db = new PGlite();
    const [init, ...resto] = cartelle();
    await applica(db, [init]);
    await db.exec(LISTINO_A);
    await negozio(db, 'a1', 'Pro', 'Free');
    await negozio(db, 'a2', 'Enterprise', 'Business');
    await negozio(db, 'a3', 'Free');
    await addebito(db, 'c1', 'a1', 'Pro');
    await prezzoPartner(db, 'Pro');

    await applica(db, resto);

    await verificaListino(db);
    expect(await pianoDi(db, 'a1')).toEqual({ current_plan: 'Growth', last_synced_plan: 'Basic' });
    expect(await pianoDi(db, 'a2')).toEqual({ current_plan: 'Core', last_synced_plan: 'Scale' });
    expect(await pianoDi(db, 'a3')).toEqual({ current_plan: 'Basic', last_synced_plan: null });
    const { rows: addebiti } = await db.query(`SELECT "plan_type" FROM "billing_charges"`);
    expect(addebiti).toEqual([{ plan_type: 'Growth' }]);
    const { rows: partner } = await db.query(`SELECT "plan_name" FROM "partner_plan_prices"`);
    expect(partner).toEqual([{ plan_name: 'Growth' }]);
    await db.close();
  }, 60_000);

  it('dallo stato A senza pricing_alignment (segnata applicata a mano, mai eseguita)', async () => {
    const db = new PGlite();
    const [init, ...resto] = cartelle();
    await applica(db, [init]);
    await db.exec(LISTINO_A);
    await negozio(db, 'a1', 'Pro');
    await negozio(db, 'a2', 'Business');

    await applica(db, resto.filter((c) => c !== PRICING_ALIGNMENT));

    await verificaListino(db);
    expect((await pianoDi(db, 'a1')).current_plan).toBe('Growth');
    expect((await pianoDi(db, 'a2')).current_plan).toBe('Scale');
    await db.close();
  }, 60_000);

  it('dallo stato B (Free/Core/Growth/Scale, Core da 29): Core diventa Growth, non resta Core', async () => {
    const db = new PGlite();
    const tutte = cartelle();
    const finoAlB = tutte.filter((c) => c <= PRICING_ALIGNMENT && !c.endsWith('_pricing_alignment_guard'));
    const [init, ...primaDelB] = finoAlB;
    const dopo = tutte.filter((c) => c > PRICING_ALIGNMENT);

    await applica(db, [init]);
    await db.exec(LISTINO_A);
    // Un negozio dell'era A: la migrazione del 23 lo porta su Core (da 29).
    await negozio(db, 'b1', 'Pro', 'Pro');
    await addebito(db, 'c-a', 'b1', 'Pro');
    await applica(db, primaDelB);
    expect((await pianoDi(db, 'b1')).current_plan).toBe('Core');

    // Negozi e addebiti nati nello stato B.
    await negozio(db, 'b2', 'Scale', 'Growth');
    await negozio(db, 'b3', 'Free');
    await addebito(db, 'c-b', 'b1', 'Core');

    await applica(db, dopo);

    await verificaListino(db);
    expect(await pianoDi(db, 'b1')).toEqual({ current_plan: 'Growth', last_synced_plan: 'Growth' });
    expect(await pianoDi(db, 'b2')).toEqual({ current_plan: 'Core', last_synced_plan: 'Scale' });
    expect((await pianoDi(db, 'b3')).current_plan).toBe('Basic');
    const { rows: addebiti } = await db.query(
      `SELECT "id", "plan_type" FROM "billing_charges" ORDER BY "id"`,
    );
    expect(addebiti).toEqual([
      { id: 'c-a', plan_type: 'Growth' },
      { id: 'c-b', plan_type: 'Growth' },
    ]);
    await db.close();
  }, 60_000);

  it('dallo stato B senza le chiavi esterne sul nome: i negozi seguono comunque', async () => {
    const db = new PGlite();
    const tutte = cartelle();
    const [init, ...primaDelB] = tutte.filter(
      (c) => c <= PRICING_ALIGNMENT && !c.endsWith('_pricing_alignment_guard'),
    );
    await applica(db, [init]);
    await db.exec(LISTINO_A);
    await applica(db, primaDelB);
    await db.exec(`
      ALTER TABLE "shops" DROP CONSTRAINT "shops_current_plan_fkey";
      ALTER TABLE "shops" DROP CONSTRAINT "shops_last_synced_plan_fkey";
    `);
    await negozio(db, 'b1', 'Core', 'Scale');

    await applica(db, tutte.filter((c) => c > PRICING_ALIGNMENT));

    expect(await pianoDi(db, 'b1')).toEqual({ current_plan: 'Growth', last_synced_plan: 'Core' });
    await db.close();
  }, 60_000);

  it('rilanciata sul listino finale non cambia niente', async () => {
    const db = new PGlite();
    const tutte = cartelle();
    await applica(db, tutte);
    await negozio(db, 'f1', 'Core', 'Growth');
    const prima = await db.query(`SELECT * FROM "plans" ORDER BY "id"`);

    await applica(db, [tutte.find((c) => c.endsWith('_plans_basic_growth_scale_core'))!]);

    expect((await db.query(`SELECT * FROM "plans" ORDER BY "id"`)).rows).toEqual(prima.rows);
    expect(await pianoDi(db, 'f1')).toEqual({ current_plan: 'Core', last_synced_plan: 'Growth' });
    await verificaListino(db);
    await db.close();
  }, 60_000);
});
