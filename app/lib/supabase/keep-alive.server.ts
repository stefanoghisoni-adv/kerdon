import type { SupabaseClient } from '@supabase/supabase-js';
import type { Shop, SupabaseConfig } from '@prisma/client';
import { createSupabaseClient } from '../supabase.server';

export type KeepAliveResult = 'ok' | 'failed' | 'skipped';

/**
 * Ping giornaliero al database del merchant per evitare il pause automatico
 * dei progetti Supabase gratuiti dopo 7 giorni di inattività.
 *
 * Lettura minima (una colonna, limit 1) sulla tabella prodotti o, se quella
 * non esiste, sulla tabella clienti. Non scrive nulla.
 *
 * @param shop - Il negozio con la sua config Supabase
 * @param timeoutMs - Timeout in millisecondi (default 5000)
 * @returns 'ok' se la lettura è andata a buon fine, 'failed' se è fallita,
 *          'skipped' se la config non ha le credenziali necessarie
 */
export async function keepMerchantDbAwake(
  shop: Shop & { supabaseConfig: SupabaseConfig | null },
  timeoutMs = 5000,
): Promise<KeepAliveResult> {
  if (!shop.supabaseConfig) {
    return 'skipped';
  }

  try {
    const client = createSupabaseClient(shop.supabaseConfig);
    const result = await performKeepAliveRead(
      client,
      shop.supabaseConfig.tableNameProducts,
      shop.supabaseConfig.tableNameCustomers,
      timeoutMs,
    );
    return result;
  } catch (error) {
    console.error(`Keep-alive fallito per ${shop.shopDomain}:`, error);
    return 'failed';
  }
}

/**
 * Esegue una lettura minima sul database del merchant.
 * Prova prima con la tabella prodotti, poi con quella clienti se la prima
 * non esiste.
 */
async function performKeepAliveRead(
  client: SupabaseClient,
  productsTable: string,
  customersTable: string,
  timeoutMs: number,
): Promise<KeepAliveResult> {
  // Promise per il timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Keep-alive timeout')), timeoutMs);
  });

  try {
    // Prova con la tabella prodotti
    const readPromise = client.from(productsTable).select('id', { head: true, count: 'exact' });

    await Promise.race([readPromise, timeoutPromise]);
    return 'ok';
  } catch (productsError) {
    // Se la tabella prodotti non esiste, prova con quella clienti
    try {
      const readPromise = client.from(customersTable).select('id', { head: true, count: 'exact' });

      await Promise.race([readPromise, timeoutPromise]);
      return 'ok';
    } catch (customersError) {
      console.error('Keep-alive: entrambe le tabelle non disponibili', {
        productsError,
        customersError,
      });
      return 'failed';
    }
  }
}
