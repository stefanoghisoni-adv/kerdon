// app/lib/supabase/managed-resources.ts
// L'SQL dell'eliminazione: cosa si elimina, in che ordine, e come si verifica
// dopo che e' sparito davvero.
//
// Tutto quello che c'e' qui e' puro — nessuna chiamata, nessun database — e non
// e' un vezzo: e' l'unico modo perche' i controlli su cui poggia la sicurezza
// di un DROP si possano provare senza avere davanti un progetto Supabase vero.
// Chi esegue sta in `delete-merchant-data.server`.

import { MERCHANT_TABLE_NAMES } from '~/lib/supabase-schema';
import { quoteLiteral, quoteQualifiedName } from './identifiers';

/** Per ora l'app crea solo tabelle. Viste e funzioni avrebbero un altro ordine. */
export type ManagedResourceKind = 'table';

export interface ManagedResource {
  schemaName: string;
  resourceName: string;
  resourceKind: ManagedResourceKind;
}

/**
 * L'ordine in cui si eliminano: l'inverso di quello in cui nascono.
 *
 * Serve anche se oggi la DDL non dichiara nessuna foreign key fra queste
 * tabelle: il database e' del merchant e nessuno gli impedisce di averne
 * aggiunta una — `order_lines` verso `orders` e' quella che chiunque
 * aggiungerebbe. Con l'ordine sbagliato il DROP verrebbe rifiutato e
 * l'eliminazione fallirebbe per intero, che e' meglio di un'eliminazione a
 * meta' ma resta un guasto che si evita scrivendo l'ordine giusto una volta.
 *
 * Il rifiuto e' voluto e non si aggira con CASCADE: CASCADE porterebbe via
 * anche gli oggetti del merchant che dipendono dalle nostre tabelle — una sua
 * vista, una sua tabella con una chiave esterna — e quelli non sono nostri.
 */
export const MERCHANT_DROP_ORDER: readonly string[] = [...MERCHANT_TABLE_NAMES].reverse();

/**
 * Le risorse ordinate per l'eliminazione.
 *
 * Quelle di cui non si sa la posizione (un nome che la DDL corrente non crea
 * piu', o non ancora) vanno in testa: sono le piu' probabili dipendenti, e
 * comunque non possono essere quelle da cui gli altri dipendono.
 */
export function orderForDrop(resources: readonly ManagedResource[]): ManagedResource[] {
  const position = (r: ManagedResource) => {
    const i = MERCHANT_DROP_ORDER.indexOf(r.resourceName);
    return i === -1 ? -1 : i;
  };
  return [...resources].sort((a, b) => position(a) - position(b));
}

/** `"public"."order_lines"`, gia' validato e citato. */
export function qualifiedName(resource: ManagedResource): string {
  return quoteQualifiedName(resource.schemaName, resource.resourceName);
}

/**
 * L'eliminazione, in una transazione sola.
 *
 * BEGIN/COMMIT espliciti perche' l'esito dev'essere uno per tutte: se il DROP
 * della terza tabella viene rifiutato, le due gia' cadute devono tornare. Senza
 * la transazione il database del merchant resterebbe a meta' — alcune tabelle
 * via, altre no — e nessuno dei due stati sarebbe quello che aveva chiesto.
 * Postgres, dentro una transazione, considera fallita ogni istruzione dopo la
 * prima che sbaglia e trasforma il COMMIT in un ROLLBACK: il rimedio arriva da
 * solo, purche' l'SQL parta come un blocco unico.
 *
 * `IF EXISTS` non e' in contraddizione: rende il secondo tentativo possibile
 * dopo un fallimento parziale altrove (per esempio una tabella che il merchant
 * aveva gia' cancellato a mano). Cio' che davvero e' sparito lo dice la
 * verifica dopo il COMMIT, non il fatto che il DROP non abbia protestato.
 *
 * Lancia `InvalidIdentifierError` se un nome non e' un identificatore lecito, e
 * lo fa PRIMA di restituire una sola riga di SQL: a meta' di un DROP non c'e'
 * piu' niente da salvare.
 */
export function buildDropTransactionSQL(resources: readonly ManagedResource[]): string {
  const ordered = orderForDrop(resources);
  if (ordered.length === 0) return '';

  const drops = ordered.map((r) => `DROP TABLE IF EXISTS ${qualifiedName(r)};`);
  return ['BEGIN;', ...drops, 'COMMIT;'].join('\n');
}

/**
 * La domanda da fare DOPO il COMMIT: di queste, quali ci sono ancora?
 *
 * Si chiede a `information_schema` e non provando a leggerle: una domanda sola
 * risponde per tutte, e risponde senza fallire.
 *
 * I nomi qui sono VALORI, non identificatori, e si citano in modo diverso —
 * apice singolo raddoppiato. E' la distinzione che rende una verifica vera
 * invece di una che sembra funzionare e non confronta niente.
 */
export function buildExistenceCheckSQL(resources: readonly ManagedResource[]): string {
  if (resources.length === 0) return '';

  const bySchema = new Map<string, string[]>();
  for (const r of resources) {
    const names = bySchema.get(r.schemaName) ?? [];
    names.push(r.resourceName);
    bySchema.set(r.schemaName, names);
  }

  const clauses = [...bySchema.entries()].map(([schema, names]) => {
    const list = names.map((n) => quoteLiteral(n)).join(', ');
    return `(table_schema = ${quoteLiteral(schema)} AND table_name IN (${list}))`;
  });

  return `SELECT table_schema, table_name FROM information_schema.tables
WHERE ${clauses.join(' OR ')};`;
}

export interface ExistingTableRow {
  table_schema?: unknown;
  table_name?: unknown;
}

/**
 * Le risorse che la verifica ha trovato ancora vive.
 *
 * Vuoto = l'eliminazione e' andata. Non vuoto = si tengono token e
 * configurazione, perche' senza quelli dall'app non c'e' piu' modo di finire il
 * lavoro, e il merchant non deve leggere che e' stato fatto.
 */
export function remainingResources(
  resources: readonly ManagedResource[],
  rows: readonly ExistingTableRow[],
): ManagedResource[] {
  const alive = new Set(
    rows.map((r) => `${String(r.table_schema ?? 'public')}.${String(r.table_name ?? '')}`),
  );
  return resources.filter((r) => alive.has(`${r.schemaName}.${r.resourceName}`));
}
