import type { SupabaseClient } from '@supabase/supabase-js';
import { prisma } from '~/db.server';
import { buildOrdersSchemaSQL } from '~/lib/supabase-schema';
import { ensureTable, type EnsureTableResult } from './ensure-table.server';

/**
 * Garantisce che le tabelle degli ordini esistano prima di sincronizzarle.
 *
 * Servono nello stesso caso dei clienti: al collegamento vengono create solo se
 * il negozio aveva gia' concesso di leggere gli ordini, quindi chi concede il
 * permesso dopo non ce le ha. Senza questa verifica la prima sincronizzazione
 * fallirebbe portandosi dietro l'intera corsa, prodotti compresi.
 *
 * Una chiamata sola per due tabelle: nascono insieme dalla stessa DDL, e una
 * senza l'altra non serve a niente — le righe senza il loro ordine non si
 * possono nemmeno raggruppare.
 */
export type EnsureOrdersTablesResult = EnsureTableResult;

interface ConfigLike {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  supabaseProjectRef: string | null;
}

export async function ensureOrdersTables(
  shopId: string,
  config: ConfigLike,
  supabase: SupabaseClient,
): Promise<EnsureOrdersTablesResult> {
  return ensureTable(shopId, config, supabase, {
    ddlTableName: 'orders',
    tableName: 'orders',
    probeColumn: 'shopify_order_id',
    // La DDL le crea entrambe: sondare la prima basta a sapere se il giro e'
    // gia' stato fatto.
    buildSQL: buildOrdersSchemaSQL,
    label: 'ensureOrdersTables',
    onCreated: () => logCreation(shopId),
  });
}

// Come per i clienti: la creazione finisce nei log, dove il merchant la ritrova.
// Best effort — le tabelle ormai ci sono.
async function logCreation(shopId: string): Promise<void> {
  try {
    await prisma.syncJob.create({
      data: {
        shopId,
        jobType: 'table_create_orders',
        status: 'completed',
        completedAt: new Date(),
      },
    });
  } catch (err) {
    console.warn(
      '[ensureOrdersTables] log creazione tabelle ordini fallito:',
      err instanceof Error ? err.message : 'errore sconosciuto',
    );
  }
}
