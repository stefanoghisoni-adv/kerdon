/**
 * La cancellazione dei dati del merchant toglie anche il guardiano delle
 * cancellazioni GDPR, provato su un Postgres vero.
 *
 * Il registro delle risorse conosce solo tabelle, e la DDL crea anche una
 * funzione e un trigger su `orders` — pure quando `orders` c'era gia' ed e' del
 * merchant. Qui si esegue l'SQL vero dell'eliminazione (buildDropTransactionSQL,
 * buildGuardDropSQL) e la verifica vera (buildGuardExistenceSQL) sullo schema
 * che l'app crea. PGlite e' Postgres in WebAssembly, in memoria.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { buildMerchantSchemaSQL } from '~/lib/supabase-schema';
import {
  buildDropTransactionSQL,
  buildExistenceCheckSQL,
  buildGuardDropSQL,
  buildGuardExistenceSQL,
  type ManagedResource,
} from './managed-resources';

const table = (resourceName: string): ManagedResource => ({
  schemaName: 'public',
  resourceName,
  resourceKind: 'table',
});

let db: PGlite;

async function guardiano(): Promise<unknown[]> {
  return (await db.query(buildGuardExistenceSQL())).rows;
}

async function tabelle(nomi: string[]): Promise<string[]> {
  const r = await db.query<{ table_name: string }>(buildExistenceCheckSQL(nomi.map(table)));
  return r.rows.map((x) => x.table_name).sort();
}

beforeEach(() => {
  db = new PGlite();
});

// PGlite carica il suo WASM al primo uso: sulla macchina di build Vercel i
// 5s di default non bastano al primo test.
describe('dopo la cancellazione non resta niente del guardiano', { timeout: 30_000 }, () => {
  it('orders creata da Kerdon: via le tabelle, il trigger e la funzione', async () => {
    await db.exec(buildMerchantSchemaSQL(true, true));
    expect(await guardiano()).toHaveLength(2);

    const tutte = ['products', 'users', 'customers', 'orders', 'order_lines'];
    await db.exec(buildDropTransactionSQL(tutte.map(table)));

    expect(await tabelle(tutte)).toEqual([]);
    expect(await guardiano()).toEqual([]);
  });

  it('orders gia del merchant: la tabella resta coi suoi dati, trigger e funzione no', async () => {
    // La sua tabella, con dentro un suo ordine, prima che l'app arrivasse.
    await db.exec(`CREATE TABLE orders (id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      shopify_order_id BIGINT UNIQUE NOT NULL, nota_del_merchant TEXT);
      INSERT INTO orders (shopify_order_id, nota_del_merchant) VALUES (1, 'mia');`);
    await db.exec(buildMerchantSchemaSQL(true, true));
    expect(await guardiano()).toHaveLength(2);

    // Il registro la segna createdByKerdon = false: non e' fra le risorse.
    const nostre = ['products', 'users', 'customers', 'order_lines'];
    await db.exec(buildDropTransactionSQL(nostre.map(table)));

    expect(await tabelle(['orders', ...nostre])).toEqual(['orders']);
    expect(await guardiano()).toEqual([]);
    const riga = await db.query<{ nota_del_merchant: string }>('SELECT nota_del_merchant FROM orders;');
    expect(riga.rows).toEqual([{ nota_del_merchant: 'mia' }]);
    // E una scrittura sulla sua tabella non passa piu' da nessun trigger nostro.
    await db.exec(`UPDATE orders SET customer_redacted_at = NOW(), shopify_customer_id = 5;`);
    const dopo = await db.query<{ shopify_customer_id: number }>('SELECT shopify_customer_id FROM orders;');
    expect(Number(dopo.rows[0].shopify_customer_id)).toBe(5);
  });

  it('nessuna tabella nostra: si toglie solo il guardiano', async () => {
    await db.exec(buildMerchantSchemaSQL(true, true));

    await db.exec(buildGuardDropSQL());

    expect(await guardiano()).toEqual([]);
    expect(await tabelle(['orders', 'order_lines'])).toEqual(['order_lines', 'orders']);
  });

  it('orders gia sparita: la transazione non si annulla', async () => {
    // Tolta a mano dal merchant: DROP TRIGGER ... ON public.orders avvisa e prosegue.
    await db.exec(buildMerchantSchemaSQL(true, true));
    await db.exec('DROP TABLE orders;');

    await db.exec(buildDropTransactionSQL(['products', 'users', 'customers', 'order_lines'].map(table)));

    expect(await tabelle(['products', 'users', 'customers', 'order_lines'])).toEqual([]);
    expect(await guardiano()).toEqual([]);
  });

  it('senza ordini: niente trigger da togliere, e nessun errore', async () => {
    await db.exec(buildMerchantSchemaSQL(true, false));
    await db.exec(buildDropTransactionSQL(['products', 'users', 'customers'].map(table)));
    expect(await guardiano()).toEqual([]);
  });
});
