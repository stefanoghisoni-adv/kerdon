import {
  buildCustomersSchemaSQL,
  buildOrdersSchemaSQL,
  buildProductsSchemaSQL,
  RELOAD_SCHEMA_SQL,
} from '~/lib/supabase-schema';

/**
 * Le tabelle che la tab Clienti legge, e come provvedere a quelle che mancano.
 *
 * Il problema che risolve e' vecchio quanto la DDL: le tabelle del merchant
 * nascono al collegamento, e nascono quelle che il negozio meritava ALLORA —
 * `customers` solo con un piano che sincronizza i clienti, `orders` e
 * `order_lines` solo se gli ordini erano gia' leggibili. Tutto cio' che cambia
 * dopo (un piano che sale, il permesso sugli ordini concesso in un secondo
 * momento, una DDL passata a meta') lascia un database senza una tabella che
 * nessuno rifara' mai.
 *
 * Chi sincronizza si e' gia' difeso da tempo, con `ensureCustomersTable` e
 * `ensureOrdersTables`. Chi legge no: la query trovava `orders` inesistente,
 * Postgres rispondeva "relation does not exist" e la Management API lo girava
 * come un 400 nudo. A schermo diventava "non e' stato possibile leggere i
 * clienti", per sempre, senza che il merchant avesse un solo gesto da fare per
 * uscirne.
 *
 * La DDL e' idempotente e additiva — CREATE TABLE IF NOT EXISTS, ADD COLUMN IF
 * NOT EXISTS — quindi provvedere a una tabella mancante non tocca i dati delle
 * altre.
 */

/** Le quattro tabelle su cui poggiano le query della tab Clienti. */
export const CUSTOMERS_REPORT_TABLES = [
  'products',
  'orders',
  'order_lines',
  'customers',
] as const;

export type ReportTable = (typeof CUSTOMERS_REPORT_TABLES)[number];

/**
 * Quali di quelle tabelle esistono davvero.
 *
 * Si chiede a `information_schema` e non provando a leggerle: una domanda sola
 * risponde per tutte, e soprattutto risponde senza fallire — un SELECT su una
 * tabella che non c'e' e' proprio l'errore da cui stiamo cercando di uscire.
 */
export function existingReportTablesSQL(): string {
  const names = CUSTOMERS_REPORT_TABLES.map((t) => `'${t}'`).join(', ');
  return `SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN (${names});`;
}

/**
 * La DDL delle sole tabelle che mancano, o `null` se non ne manca nessuna.
 *
 * `orders` e `order_lines` vengono da una DDL sola perche' nascono insieme e
 * l'una senza l'altra non serve a niente: righe che non si possono ricondurre
 * al loro ordine non entrano in nessun conto.
 *
 * La ricarica dello schema chiude la lista: le nostre letture passano dalla
 * Management API e non ne avrebbero bisogno, ma la stessa tabella la usera' poi
 * la sincronizzazione attraverso l'API REST, che lavora su una copia in cache e
 * senza quella riga continuerebbe a non vederla.
 */
export function missingReportTablesSQL(existing: readonly string[]): string | null {
  const have = new Set(existing);
  const missing = CUSTOMERS_REPORT_TABLES.filter((t) => !have.has(t));
  if (missing.length === 0) return null;

  const parts: string[] = [];
  if (missing.includes('products')) parts.push(buildProductsSchemaSQL());
  if (missing.includes('customers')) parts.push(buildCustomersSchemaSQL());
  if (missing.includes('orders') || missing.includes('order_lines')) {
    parts.push(buildOrdersSchemaSQL());
  }

  return parts.join('') + RELOAD_SCHEMA_SQL;
}

/** Le tabelle che mancano, per dirlo nei log invece di lasciarlo indovinare. */
export function missingReportTables(existing: readonly string[]): ReportTable[] {
  const have = new Set(existing);
  return CUSTOMERS_REPORT_TABLES.filter((t) => !have.has(t));
}
