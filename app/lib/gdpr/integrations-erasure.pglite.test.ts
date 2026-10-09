/**
 * Le tabelle delle integrazioni davanti alle due cancellazioni GDPR, provate
 * su un Postgres vero.
 *
 * DUE PROMESSE, E SONO DIVERSE.
 *
 *  - `customers/redact`: i conflitti con Klaviyo di una persona portano la sua
 *    data di nascita (la nostra e quella di Klaviyo) e se ne vanno con lei.
 *    Quelli degli altri clienti, e quelli della stessa persona su un altro
 *    negozio, restano: sono dati di qualcun altro, o di un altro titolare.
 *  - `shop/redact`: del negozio non resta niente, e non perche' qualcuno si sia
 *    ricordato di elencare le quattro tabelle nuove in `eraseShopRecord`. Le
 *    tabelle pendono da `shops` con `ON DELETE CASCADE`: la `DELETE` del
 *    negozio, l'ultima istruzione di `eraseShopRecord`, le svuota da sola.
 *    Se un giorno la migrazione perdesse la cascata, questa prova se ne
 *    accorgerebbe prima di un negozio vero.
 *
 * Qui gira la migrazione vera delle integrazioni. Prisma e' un sottile
 * adattatore su PGlite che traduce in SQL le sole chiamate di cui la
 * cancellazione ha bisogno. PGlite e' Postgres in WebAssembly, in memoria e
 * usa e getta.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock('~/db.server', () => ({
  prisma: {
    syncJobEvent: { deleteMany: async () => ({ count: 0 }) },
    syncJob: { findMany: async () => [], update: async () => ({}) },
    integrationConflict: {
      // L'esportazione: stessa forma della cancellazione, negozio + clienti.
      findMany: async ({ where }: any) => {
        const keys = Object.keys(where ?? {}).sort().join(',');
        if (keys !== 'customerId,shopId' || !Array.isArray(where.customerId?.in)) {
          throw new Error('condizione non prevista');
        }
        const { rows } = await h.db.query(
          `SELECT provider, target_field AS "targetField", our_value AS "ourValue",
                  their_value AS "theirValue", status, decided_at AS "decidedAt"
             FROM integration_conflicts
            WHERE shop_id = $1 AND shopify_customer_id = ANY($2::bigint[])
            ORDER BY created_at`,
          [where.shopId, where.customerId.in.map(String)],
        );
        return rows;
      },
      // La sola forma che la cancellazione usa: negozio + elenco di clienti.
      // Una condizione diversa fa fallire la prova invece di essere ignorata.
      deleteMany: async ({ where }: any) => {
        const keys = Object.keys(where ?? {}).sort().join(',');
        if (keys !== 'customerId,shopId' || !Array.isArray(where.customerId?.in)) {
          throw new Error(`condizione non prevista: ${JSON.stringify(where, (_k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
        }
        const res = await h.db.query(
          `DELETE FROM integration_conflicts
            WHERE shop_id = $1 AND shopify_customer_id = ANY($2::bigint[])`,
          [where.shopId, where.customerId.in.map(String)],
        );
        return { count: res.affectedRows ?? 0 };
      },
    },
  },
}));

import {
  collectIntegrationConflicts,
  eraseCustomerFromAppDatabase,
  stepsFailed,
} from './customer-record.server';

const MIGRATION = readFileSync(
  join(process.cwd(), 'prisma/migrations/20261003120000_integrations/migration.sql'),
  'utf8',
);

async function conflitto(shopId: string, customerId: number, theirs: string) {
  await h.db.query(
    `INSERT INTO integration_conflicts
       (id, shop_id, provider, shopify_customer_id, target_field, our_value, their_value, status, updated_at)
     VALUES ($1, $2, 'klaviyo', $3, 'birthdate', '1990-01-01', $4, 'open', NOW())`,
    [randomUUID(), shopId, String(customerId), theirs],
  );
}

async function righe(table: string, shopId: string): Promise<number> {
  const { rows } = await h.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE shop_id = $1`, [shopId]);
  return rows[0].n;
}

beforeEach(async () => {
  h.db = new PGlite();
  // La tabella dei negozi ridotta all'osso: la migrazione vi aggancia le FK.
  await h.db.exec(`CREATE TABLE shops (id TEXT PRIMARY KEY);
    INSERT INTO shops (id) VALUES ('shop-1'), ('shop-2');`);
  await h.db.exec(MIGRATION);
});

describe('customers/redact: i conflitti della persona', () => {
  it('se ne vanno i suoi, restano quelli degli altri e degli altri negozi', async () => {
    await conflitto('shop-1', 4021, '1988-12-25');
    await conflitto('shop-1', 5000, '1975-06-01');
    await conflitto('shop-2', 4021, '1988-12-25');

    const steps = await eraseCustomerFromAppDatabase('shop-1', '4021', 'impronta');

    expect(stepsFailed(steps)).toBe(false);
    expect(steps.find((s) => s.table === 'integration_conflicts')).toMatchObject({
      outcome: 'deleted',
      rows: 1,
    });
    const { rows } = await h.db.query(
      `SELECT shop_id, shopify_customer_id::text AS c FROM integration_conflicts ORDER BY shop_id, c`,
    );
    expect(rows).toEqual([
      { shop_id: 'shop-1', c: '5000' },
      { shop_id: 'shop-2', c: '4021' },
    ]);
  });
});

describe('customers/data_request: i conflitti della persona', () => {
  it('escono i suoi, non quelli di altri clienti o di altri negozi', async () => {
    await conflitto('shop-1', 4021, '1988-12-25');
    await conflitto('shop-1', 5000, '1975-06-01');
    await conflitto('shop-2', 4021, '2001-01-01');

    const { rows, step } = await collectIntegrationConflicts('shop-1', '4021');

    expect(step).toMatchObject({ table: 'integration_conflicts', outcome: 'read', rows: 1 });
    expect(rows).toEqual([
      {
        provider: 'klaviyo',
        field: 'birthdate',
        our_value: '1990-01-01',
        provider_value: '1988-12-25',
        status: 'open',
        decided_at: null,
      },
    ]);
  });
});

describe('shop/redact: la cascata su shops', () => {
  it('la DELETE del negozio svuota le quattro tabelle delle integrazioni, solo per lui', async () => {
    for (const shopId of ['shop-1', 'shop-2']) {
      await h.db.query(
        `INSERT INTO integration_connections (id, shop_id, provider, access_token, status, updated_at)
         VALUES ($1, $2, 'klaviyo', 'cifrato', 'connected', NOW())`,
        [randomUUID(), shopId],
      );
      await h.db.query(
        `INSERT INTO integration_field_mappings (id, shop_id, provider, source_key, target_field, date_format)
         VALUES ($1, $2, 'klaviyo', 'Birthday', 'birthdate', 'DMY')`,
        [randomUUID(), shopId],
      );
      await h.db.query(
        `INSERT INTO integration_import_runs (id, shop_id, provider, status) VALUES ($1, $2, 'klaviyo', 'completed')`,
        [randomUUID(), shopId],
      );
      await conflitto(shopId, 4021, '1988-12-25');
    }

    // L'istruzione con cui `eraseShopRecord` chiude: `tx.shop.deleteMany({ where: { id } })`.
    await h.db.query(`DELETE FROM shops WHERE id = $1`, ['shop-1']);

    const tabelle = [
      'integration_connections',
      'integration_field_mappings',
      'integration_import_runs',
      'integration_conflicts',
    ];
    for (const t of tabelle) {
      expect(await righe(t, 'shop-1'), t).toBe(0);
      expect(await righe(t, 'shop-2'), t).toBe(1);
    }
  });
});
