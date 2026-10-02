/**
 * Le quattro tabelle per le integrazioni con altri provider (Klaviyo): unicita,
 * cascata e RLS provate su Postgres in memoria.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();

  // Tabella shops minimale: serve solo l'id per le chiavi esterne.
  await db.exec(`
    CREATE TABLE shops (
      id TEXT PRIMARY KEY
    );
  `);
});

// PGlite carica il suo WASM al primo uso: 30s bastano anche su Vercel.
describe('tabelle integrations', { timeout: 30_000 }, () => {
  it('applica la migrazione senza errori', async () => {
    const migrationPath = join(__dirname, 'migrations', '20261003120000_integrations', 'migration.sql');
    const sql = readFileSync(migrationPath, 'utf-8');

    await expect(db.exec(sql)).resolves.not.toThrow();
  });

  it('vincolo di unicita (shop_id, provider) su integration_connections', async () => {
    const migrationPath = join(__dirname, 'migrations', '20261003120000_integrations', 'migration.sql');
    const sql = readFileSync(migrationPath, 'utf-8');
    await db.exec(sql);

    await db.exec(`INSERT INTO shops (id) VALUES ('shop-1');`);

    // La prima riga passa.
    await db.exec(`
      INSERT INTO integration_connections (id, shop_id, provider, status, updated_at)
      VALUES (gen_random_uuid()::text, 'shop-1', 'klaviyo', 'connected', CURRENT_TIMESTAMP);
    `);

    // La seconda con lo stesso (shop_id, provider) deve fallire.
    await expect(db.exec(`
      INSERT INTO integration_connections (id, shop_id, provider, status, updated_at)
      VALUES (gen_random_uuid()::text, 'shop-1', 'klaviyo', 'disconnected', CURRENT_TIMESTAMP);
    `)).rejects.toThrow();
  });

  it('vincolo di unicita (shop_id, provider, customer_id, target_field) su integration_conflicts', async () => {
    const migrationPath = join(__dirname, 'migrations', '20261003120000_integrations', 'migration.sql');
    const sql = readFileSync(migrationPath, 'utf-8');
    await db.exec(sql);

    await db.exec(`INSERT INTO shops (id) VALUES ('shop-2');`);

    // La prima riga passa.
    await db.exec(`
      INSERT INTO integration_conflicts (id, shop_id, provider, shopify_customer_id, target_field, their_value, status, updated_at)
      VALUES (gen_random_uuid()::text, 'shop-2', 'klaviyo', 123456, 'email', 'new@example.com', 'open', CURRENT_TIMESTAMP);
    `);

    // La seconda con gli stessi identificatori deve fallire.
    await expect(db.exec(`
      INSERT INTO integration_conflicts (id, shop_id, provider, shopify_customer_id, target_field, their_value, status, updated_at)
      VALUES (gen_random_uuid()::text, 'shop-2', 'klaviyo', 123456, 'email', 'other@example.com', 'used_theirs', CURRENT_TIMESTAMP);
    `)).rejects.toThrow();
  });

  it('DELETE FROM shops cancella a cascata le righe delle 4 tabelle', async () => {
    const migrationPath = join(__dirname, 'migrations', '20261003120000_integrations', 'migration.sql');
    const sql = readFileSync(migrationPath, 'utf-8');
    await db.exec(sql);

    await db.exec(`INSERT INTO shops (id) VALUES ('shop-3');`);

    // Una riga per tabella.
    await db.exec(`
      INSERT INTO integration_connections (id, shop_id, provider, status, updated_at)
      VALUES ('conn-1', 'shop-3', 'klaviyo', 'connected', CURRENT_TIMESTAMP);

      INSERT INTO integration_field_mappings (id, shop_id, provider, source_key, target_field)
      VALUES ('map-1', 'shop-3', 'klaviyo', 'Birthday', 'birthdate');

      INSERT INTO integration_conflicts (id, shop_id, provider, shopify_customer_id, target_field, their_value, status, updated_at)
      VALUES ('conf-1', 'shop-3', 'klaviyo', 999, 'email', 'test@example.com', 'open', CURRENT_TIMESTAMP);

      INSERT INTO integration_import_runs (id, shop_id, provider, status)
      VALUES ('run-1', 'shop-3', 'klaviyo', 'running');
    `);

    // Cancellare il negozio deve cancellare tutto.
    await db.exec(`DELETE FROM shops WHERE id = 'shop-3';`);

    const connections = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM integration_connections WHERE shop_id = 'shop-3';`);
    expect(Number(connections.rows[0].count)).toBe(0);

    const mappings = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM integration_field_mappings WHERE shop_id = 'shop-3';`);
    expect(Number(mappings.rows[0].count)).toBe(0);

    const conflicts = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM integration_conflicts WHERE shop_id = 'shop-3';`);
    expect(Number(conflicts.rows[0].count)).toBe(0);

    const runs = await db.query<{ count: string }>(`SELECT COUNT(*) as count FROM integration_import_runs WHERE shop_id = 'shop-3';`);
    expect(Number(runs.rows[0].count)).toBe(0);
  });

  it('RLS attivata sulle 4 tabelle', async () => {
    const migrationPath = join(__dirname, 'migrations', '20261003120000_integrations', 'migration.sql');
    const sql = readFileSync(migrationPath, 'utf-8');
    await db.exec(sql);

    const result = await db.query<{ relname: string }>(`
      SELECT relname
      FROM pg_class
      WHERE relname IN ('integration_connections', 'integration_field_mappings', 'integration_conflicts', 'integration_import_runs')
        AND relrowsecurity = true;
    `);

    const tables = result.rows.map(r => r.relname).sort();
    expect(tables).toEqual([
      'integration_conflicts',
      'integration_connections',
      'integration_field_mappings',
      'integration_import_runs',
    ]);
  });
});
