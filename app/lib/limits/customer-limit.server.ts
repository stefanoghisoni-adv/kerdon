// app/lib/limits/customer-limit.server.ts
//
// Le due letture che il limite clienti fa sul database del merchant: chi c'e'
// gia' dentro il tetto (per decidere chi altro puo' entrare) e quanti clienti
// idonei ci sono (per mostrarlo). Le regole stanno in customer-limit.ts.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createCustomerQuota, type CustomerQuota } from './customer-limit';

export type LoadedCustomerQuota =
  | { ok: true; quota: CustomerQuota }
  | { ok: false; error: string };

interface SeedRow {
  shopify_customer_id?: number | string | null;
  created_at?: string | null;
}

/**
 * La quota clienti di questa corsa, a partire da chi e' gia' sincronizzato.
 *
 * Si leggono solo i primi `limit` clienti idonei in graduatoria (creazione
 * crescente, nulli per primi, poi id): sono gli unici che possono restare fra i
 * primi N comunque vada la corsa. L'ordine di Postgres su una colonna TIMESTAMP
 * e' lo stesso del confronto testuale di `customerRankKey`.
 *
 * Una lettura fallita non si trasforma in "nessuno dentro": vorrebbe dire
 * ammettere fino al tetto altri clienti sopra a quelli che ci sono gia'. Chi
 * chiama decide se ritentare o fermarsi.
 */
export async function loadCustomerQuota(
  supabase: SupabaseClient,
  tableName: string,
  limit: number | null | undefined,
): Promise<LoadedCustomerQuota> {
  if (limit == null || limit <= 0) {
    return { ok: true, quota: createCustomerQuota(limit) };
  }

  try {
    const { data, error } = (await supabase
      .from(tableName)
      .select('shopify_customer_id, created_at')
      .eq('accepts_marketing', true)
      .order('created_at', { ascending: true, nullsFirst: true })
      .order('shopify_customer_id', { ascending: true })
      .limit(limit)) as unknown as {
      data: SeedRow[] | null;
      error: { message?: string } | null;
    };

    if (error) return { ok: false, error: error.message ?? 'lettura non riuscita' };

    const seed = (data ?? [])
      .map((row) => ({ id: Number(row.shopify_customer_id), createdAt: row.created_at ?? null }))
      .filter((row) => Number.isFinite(row.id));

    return { ok: true, quota: createCustomerQuota(limit, seed) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'lettura non riuscita' };
  }
}

/**
 * Quanti clienti idonei ci sono nel database del merchant.
 *
 * null quando non lo si sa dire (tabella assente, database irraggiungibile): un
 * contatore che mostrasse zero direbbe una cosa falsa.
 */
export async function countSyncedCustomers(
  supabase: SupabaseClient,
  tableName: string,
): Promise<number | null> {
  try {
    const { count, error } = (await supabase
      .from(tableName)
      .select('shopify_customer_id', { count: 'exact', head: true })
      .eq('accepts_marketing', true)) as unknown as {
      count: number | null;
      error: unknown;
    };
    if (error || count == null) return null;
    return count;
  } catch {
    return null;
  }
}
