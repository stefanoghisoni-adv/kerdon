import { prisma } from '~/db.server';
import { decrypt } from '~/utils/crypto.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQuery } from '~/lib/supabase-management.server';
import { validateSupabaseUrl } from '~/utils/supabase-url.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { hasOrdersAccess } from '~/lib/sync/orders-access';
import {
  LATEST_SCHEMA_VERSION,
  buildSchemaUpdateSQL,
  needsSchemaUpdate,
} from './merchant-migrations';

export type SchemaUpdateStatus =
  /** Non c'era nulla da aggiornare. */
  | 'up_to_date'
  /** Aggiornato adesso. */
  | 'applied'
  /** Nessun database collegato: non c'e' niente da aggiornare. */
  | 'not_connected'
  /** C'era da aggiornare ma non ci siamo riusciti. */
  | 'failed';

export interface SchemaUpdateResult {
  status: SchemaUpdateStatus;
  /** Versione dello schema del merchant dopo il tentativo. */
  version: number;
}

/**
 * Porta le tabelle del merchant alla versione che l'app si aspetta.
 *
 * Idempotente e sicura da chiamare spesso: se non c'e' nulla da fare esce
 * subito, senza toccare il progetto del merchant. Quando invece c'e' da
 * aggiornare, l'SQL viene eseguito con le credenziali che il merchant ha gia'
 * concesso collegando il database — non serve che ci metta mano lui, ne' che
 * l'app venga reinstallata.
 */
export async function applyMerchantSchemaUpdate(
  shopId: string,
): Promise<SchemaUpdateResult> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { supabaseConfig: true },
  });

  const config = shop?.supabaseConfig;
  if (!shop || !config || !config.connectionVerifiedAt) {
    return { status: 'not_connected', version: config?.schemaVersion ?? 0 };
  }
  if (!needsSchemaUpdate(config.schemaVersion)) {
    return { status: 'up_to_date', version: config.schemaVersion };
  }

  // Le tabelle da allineare dipendono da due cose diverse: i clienti dal piano
  // — se non li prevede, la loro tabella non esiste nemmeno — e gli ordini dal
  // permesso, che il negozio concede all'installazione. Creare tabelle che
  // nessuno riempira' e' spazio occupato per niente.
  const plan = await findPlanByName(shop.currentPlan);
  const sql = buildSchemaUpdateSQL(
    config.schemaVersion,
    plan?.customersSyncEnabled ?? false,
    hasOrdersAccess(shop.scopes),
  );
  if (!sql) return { status: 'up_to_date', version: config.schemaVersion };

  const done =
    (await runViaManagementApi(shopId, config.supabaseProjectRef, sql)) ||
    (await runViaExecSql(config, sql));

  if (!done) return { status: 'failed', version: config.schemaVersion };

  await prisma.supabaseConfig.update({
    where: { shopId },
    data: { schemaVersion: LATEST_SCHEMA_VERSION },
  });
  console.log(
    `[schema-update] shop ${shopId}: schema portato alla versione ${LATEST_SCHEMA_VERSION}`,
  );
  return { status: 'applied', version: LATEST_SCHEMA_VERSION };
}

/** Via principale: il token OAuth concesso collegando il database. */
async function runViaManagementApi(
  shopId: string,
  ref: string | null,
  sql: string,
): Promise<boolean> {
  if (!ref) return false;
  try {
    const token = await getValidAccessToken(shopId);
    await runQuery(token, ref, sql);
    return true;
  } catch (err) {
    console.warn(
      '[schema-update] aggiornamento via Management API non riuscito:',
      err instanceof Error ? err.message : 'errore sconosciuto',
    );
    return false;
  }
}

/** Via secondaria, per i collegamenti che non passano dall'OAuth. */
async function runViaExecSql(
  config: { supabaseUrl: string; supabaseServiceRoleKey: string },
  sql: string,
): Promise<boolean> {
  const urlCheck = validateSupabaseUrl(config.supabaseUrl);
  if (!urlCheck.ok || !urlCheck.url) return false;

  try {
    const serviceRoleKey = decrypt(config.supabaseServiceRoleKey);
    const res = await fetch(`${urlCheck.url}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });
    return res.ok;
  } catch (err) {
    console.warn(
      '[schema-update] aggiornamento via exec_sql non riuscito:',
      err instanceof Error ? err.message : 'errore sconosciuto',
    );
    return false;
  }
}

// Ultimo tentativo automatico per negozio: la dashboard puo' essere ricaricata
// molte volte di seguito, e un aggiornamento che non riesce non deve
// trasformarsi in una raffica di chiamate al progetto del merchant. Vive in
// memoria: al massimo si riprova prima del previsto quando l'istanza cambia.
const lastAttempt = new Map<string, number>();
const RETRY_AFTER_MS = 5 * 60_000;

/**
 * Tentativo in sottofondo, per chi apre la dashboard: non si attende e non
 * riporta nulla: se non riesce resta il banner, con il suo pulsante.
 */
export function triggerMerchantSchemaUpdate(shopId: string): void {
  const now = Date.now();
  const previous = lastAttempt.get(shopId);
  if (previous != null && now - previous < RETRY_AFTER_MS) return;
  lastAttempt.set(shopId, now);

  void applyMerchantSchemaUpdate(shopId).catch((err) => {
    console.warn(
      '[schema-update] tentativo in sottofondo fallito:',
      err instanceof Error ? err.message : 'errore sconosciuto',
    );
  });
}

/** Solo per i test: azzera la memoria dei tentativi. */
export function clearSchemaUpdateAttempts(): void {
  lastAttempt.clear();
}
