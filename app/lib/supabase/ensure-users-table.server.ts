import type { SupabaseClient } from '@supabase/supabase-js';
import { prisma } from '~/db.server';
import { buildUsersSchemaSQL } from '~/lib/supabase-schema';
import { ensureTable } from './ensure-table.server';

/**
 * Provvede alla tabella `users` quando manca.
 *
 * Il problema e' quello di sempre, ed e' il motivo per cui esistono anche
 * `ensure-customers-table` e `report-tables`: la DDL gira al collegamento, e
 * chi si e' collegato prima che una tabella esistesse resta senza, per sempre,
 * senza un solo gesto da poter compiere per accorgersene. Per `users` la cosa
 * pesa piu' che altrove — non e' una tabella che si riempira' comunque alla
 * prossima sincronizzazione, e' quella dove si scrive che un browser e'
 * passato: quello che non si scrive oggi non torna domani.
 *
 * L'aggiornamento automatico dello schema (versione 7) la porta a tutti i
 * negozi collegati, e questa e' la rete sotto: serve al negozio che riceve una
 * visita prima che l'aggiornamento sia passato, e a quello per cui
 * l'aggiornamento non e' riuscito.
 *
 * Si chiama SOLO dopo che una scrittura e' fallita per tabella mancante, mai
 * preventivamente: sondare prima di ogni scrittura vorrebbe dire
 * un'interrogazione in piu' su ogni pagina di ogni vetrina, pagata da tutti per
 * un caso che capita una volta sola per negozio.
 */
export async function provisionUsersTable(
  shopId: string,
  supabase: SupabaseClient,
): Promise<boolean> {
  const config = await prisma.supabaseConfig.findUnique({ where: { shopId } });
  // Nessun progetto collegato: non c'e' niente da creare e non e' un guasto.
  if (!config) return false;

  const result = await ensureTable(shopId, config, supabase, {
    // Il nome e' letterale nella DDL e non e' configurabile, a differenza di
    // prodotti e clienti: `users` non e' una tabella che il merchant legge o
    // rimappa, e' l'impianto del riconoscimento.
    ddlTableName: 'users',
    tableName: 'users',
    probeColumn: 'external_id',
    buildSQL: buildUsersSchemaSQL,
    label: 'ensureUsersTable',
  });

  return result.status === 'created' || result.status === 'already_present';
}
