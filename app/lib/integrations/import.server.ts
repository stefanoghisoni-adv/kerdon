// app/lib/integrations/import.server.ts
//
// L'import da Klaviyo: legge i profili a pagine, li abbina ai clienti del
// merchant e riempie le date di nascita vuote. Quando i due valori non
// combaciano non sceglie: registra un conflitto e lascia decidere il merchant.
//
// GIRA NELLA CODA. `requestImport` crea il giro (IntegrationImportRun) e lo
// accoda; il drenaggio chiama `processIntegrationImport`, che salva cursore e
// contatori dopo ogni pagina. Per questo un giro si puo' interrompere in
// qualunque punto — tempo finito, deploy, Klaviyo che non risponde — e
// riprendere dall'ultima pagina chiusa senza doppie scritture ne' conflitti
// duplicati: la pagina in corso al momento dell'interruzione si rifa' da capo,
// e rifarla scrive gli stessi valori e aggiorna le stesse righe.
//
// CHI PUO' ESSERE TOCCATO. Solo i clienti nella tabella del merchant (quindi
// con consenso) ed entro il tetto clienti del piano, contato dai piu' vecchi.
// Un profilo Klaviyo che corrisponde a qualcun altro si salta.

import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '~/db.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { birthdateMetafieldOf } from '~/lib/customers/birthdate-metafield';
import { drainPages, readAllByIn } from '~/lib/gdpr/paged-read';
import { loadCustomerQuota } from '~/lib/limits/customer-limit.server';
import { naturalDedupKey } from '~/lib/queue/queue-model';
import { enqueueSyncRequest } from '~/lib/queue/queue-store.server';
import { triggerSyncDrain } from '~/lib/queue/trigger.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { hasCustomerWriteAccess } from '~/lib/sync/customers-write-access';
import { resolveBirthdateTarget } from '~/lib/workers/processors.server';
import { connectionStatus, getAccessToken, markNeedsReconnect } from './connections.server';
import { KlaviyoAuthError, KlaviyoUnavailableError, listProfiles } from './klaviyo/api.server';
import { buildIndices, matchProfile, type CandidateCustomer } from './matching';
import { decide, parseDate, type DateFormat } from './values';

export interface ImportCounters {
  matchedById: number;
  matchedByEmail: number;
  matchedByPhone: number;
  filled: number;
  same: number;
  conflicts: number;
  decided: number;
  skippedNoMatch: number;
  skippedAmbiguous: number;
  unreadable: number;
  notWritten: number;
}

type Provider = 'klaviyo';

const TYPE = 'integration-import' as const;
const TARGET_FIELD = 'birthdate';

/** Un giro 'running' piu' vecchio di cosi', senza lavoro in coda, e' fermo. */
export const STALE_RUN_MS = 15 * 60_000;

/**
 * Il tempo di una tappa. Sotto il tetto della coda (270 s) con margine: una
 * pagina Klaviyo che incontra i tentativi puo' durare mezzo minuto, e quella
 * pagina deve finire prima che la coda stacchi.
 */
export const IMPORT_BUDGET_MS = 200_000;

/** Sotto questo tempo residuo non si comincia un'altra pagina. */
export const MIN_REMAINING_MS = 10_000;

const COUNTER_KEYS: readonly (keyof ImportCounters)[] = [
  'matchedById',
  'matchedByEmail',
  'matchedByPhone',
  'filled',
  'same',
  'conflicts',
  'decided',
  'skippedNoMatch',
  'skippedAmbiguous',
  'unreadable',
  'notWritten',
];

export function emptyCounters(): ImportCounters {
  return Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0])) as unknown as ImportCounters;
}

function readCounters(raw: unknown): ImportCounters {
  const counters = emptyCounters();
  if (raw && typeof raw === 'object') {
    for (const k of COUNTER_KEYS) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'number' && Number.isFinite(v)) counters[k] = v;
    }
  }
  return counters;
}

class AlreadyRunning extends Error {}

/**
 * C'e' un import in corso per questo negozio? Stessa regola di `requestImport`:
 * l'ultimo giro e' 'running' e o e' partito da meno di 15 minuti, o ha ancora
 * lavoro in coda. Un giro fermo non conta: il pulsante deve tornare usabile,
 * e la richiesta successiva lo chiude.
 */
export async function importInProgress(shopId: string, provider: Provider): Promise<boolean> {
  const last = await prisma.integrationImportRun.findFirst({
    where: { shopId, provider },
    orderBy: { startedAt: 'desc' },
  });
  if (last?.status !== 'running') return false;
  if (Date.now() - last.startedAt.getTime() < STALE_RUN_MS) return true;
  const pending = await prisma.syncRequest.findFirst({
    where: { shopId, type: TYPE, status: { in: ['queued', 'processing'] } },
    select: { id: true },
  });
  return pending !== null;
}

/**
 * Chiede un import. Non lo esegue: crea il giro e lo mette in coda.
 *
 * Un giro solo per negozio. Due difese, perche' ognuna copre un caso diverso:
 *  - un giro 'running' con lavoro ancora in coda, o partito da meno di 15
 *    minuti, vale come in corso;
 *  - la chiave di deduplica e' legata all'ultimo giro esistente: due clic
 *    insieme leggono lo stesso ultimo giro, producono la stessa chiave, e
 *    sull'indice unico ne entra uno solo. Il perdente annulla la transazione,
 *    giro compreso.
 *
 * La chiave non e' solo `integration-import:<negozio>`: gli item conclusi
 * restano in tabella una settimana, e una chiave fissa impedirebbe di
 * importare di nuovo per sette giorni.
 */
export async function requestImport(
  shopId: string,
  provider: Provider,
): Promise<{
  queued: boolean;
  reason?: 'already_running' | 'no_mapping' | 'not_connected' | 'no_write_access' | 'plan';
}> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`negozio ${shopId} non trovato`);

  const plan = await findPlanByName(shop.currentPlan);
  if (!plan?.customersSyncEnabled) return { queued: false, reason: 'plan' };

  const { status } = await connectionStatus(shopId);
  if (status !== 'connected') return { queued: false, reason: 'not_connected' };

  const mapping = await prisma.integrationFieldMapping.findUnique({
    where: { shopId_provider_targetField: { shopId, provider, targetField: TARGET_FIELD } },
  });
  if (!mapping) return { queued: false, reason: 'no_mapping' };

  if (!hasCustomerWriteAccess(shop.scopes) || !birthdateMetafieldOf(shop)) {
    return { queued: false, reason: 'no_write_access' };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const now = new Date();
      const last = await tx.integrationImportRun.findFirst({
        where: { shopId, provider },
        orderBy: { startedAt: 'desc' },
      });

      if (last?.status === 'running') {
        const pending = await tx.syncRequest.findFirst({
          where: { shopId, type: TYPE, status: { in: ['queued', 'processing'] } },
          select: { id: true },
        });
        if (pending || now.getTime() - last.startedAt.getTime() < STALE_RUN_MS) {
          throw new AlreadyRunning();
        }
        // Fermo e senza niente in coda che lo riprenda: lo si chiude, cosi'
        // un item rimasto in giro non lo rianima.
        await tx.integrationImportRun.update({
          where: { id: last.id },
          data: { status: 'interrupted', finishedAt: now },
        });
      }

      const run = await tx.integrationImportRun.create({
        data: {
          shopId,
          provider,
          status: 'running',
          counters: emptyCounters() as unknown as Prisma.InputJsonValue,
        },
      });

      const queued = await enqueueSyncRequest({
        type: TYPE,
        shopId,
        payload: { runId: run.id, cursor: null },
        dedupKey: naturalDedupKey(TYPE, `${shopId}:dopo:${last?.id ?? 'primo'}`),
        db: tx,
      });
      if (queued.duplicate) throw new AlreadyRunning();
    });
  } catch (error) {
    if (error instanceof AlreadyRunning) return { queued: false, reason: 'already_running' };
    throw error;
  }

  triggerSyncDrain(shopId);
  return { queued: true };
}

/**
 * Il seguito di un giro fermato per tempo, dal suo cursore.
 *
 * Una continuazione per item: la chiave e' legata all'item che si ferma, quindi
 * un item ritentato non ne accoda una seconda. Solleva se non entra in coda:
 * l'item che la chiede non deve dichiararsi concluso lasciando indietro il
 * resto dei profili.
 */
export async function enqueueImportContinuation(
  shopId: string,
  jobId: string,
  runId: string,
  cursor: string,
): Promise<void> {
  await enqueueSyncRequest({
    type: TYPE,
    shopId,
    payload: { runId, cursor },
    dedupKey: naturalDedupKey(TYPE, `${shopId}:continua:${jobId}`),
  });
  triggerSyncDrain(shopId);
}

interface LeaseLike {
  assertHeld(): Promise<void>;
}

export interface ImportOptions {
  cursor: string | null;
  runId: string | null;
  lease?: LeaseLike;
  signal?: AbortSignal;
  /** Chiamata quando il giro si ferma per tempo: deve accodarne il seguito. */
  saveCursor: (cursor: string, runId: string) => Promise<void>;
  /**
   * L'ultimo tentativo concesso dalla coda. Solo qui Klaviyo indisponibile
   * chiude il giro: prima, l'errore risale e la coda ritenta.
   */
  lastAttempt?: boolean;
  /** Iniettabili per le prove. */
  budgetMs?: number;
  clock?: () => number;
}

interface PriorConflict {
  status: 'open' | 'kept_ours' | 'used_theirs';
  theirValue: string;
}

/**
 * Esegue (o riprende) un giro di import.
 *
 * - completed: profili finiti, o giro gia' chiuso da qualcun altro.
 * - paused: tempo finito o interruzione; il cursore e' salvato sul giro. Per
 *   tempo, il seguito e' accodato con `saveCursor`; per interruzione esterna
 *   la coda riprende lo stesso item, che riparte dal cursore salvato.
 * - interrupted: Klaviyo ha rifiutato il token, oppure non risponde anche
 *   all'ultimo tentativo della coda, oppure manca qualcosa per continuare
 *   (piano, associazione, campo scrivibile). Il giro resta chiuso; il
 *   merchant ne chiede uno nuovo.
 *
 * Gli altri errori (Klaviyo indisponibile prima dell'ultimo tentativo,
 * Shopify, database del merchant) si sollevano: la coda ritenta l'item, che
 * riparte dall'ultima pagina chiusa.
 */
export async function processIntegrationImport(
  shopId: string,
  opts: ImportOptions,
): Promise<'completed' | 'paused' | 'interrupted'> {
  const clock = opts.clock ?? (() => Date.now());
  const start = clock();
  const budget = opts.budgetMs ?? IMPORT_BUDGET_MS;
  const provider: Provider = 'klaviyo';

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { supabaseConfig: true },
  });
  if (!shop) return 'completed';

  let run = opts.runId
    ? await prisma.integrationImportRun.findUnique({ where: { id: opts.runId } })
    : null;
  // Un giro di un altro negozio: l'item e' corrotto. Non lo si tocca e non se
  // ne apre uno nuovo — sarebbe un import che questo merchant non ha chiesto.
  if (run && run.shopId !== shopId) return 'completed';
  if (!run) {
    run = await prisma.integrationImportRun.create({
      data: {
        shopId,
        provider,
        status: 'running',
        cursor: opts.cursor,
        counters: emptyCounters() as unknown as Prisma.InputJsonValue,
      },
    });
  }
  if (run.status !== 'running') return 'completed';
  const runId = run.id;

  // Il cursore del giro e' quello buono: e' salvato dopo ogni pagina, mentre
  // quello del payload e' fermo a quando l'item e' stato accodato.
  let cursor = run.cursor ?? opts.cursor;
  const counters = readCounters(run.counters);

  const finish = async (status: 'completed' | 'interrupted' | 'failed') => {
    await prisma.integrationImportRun.update({
      where: { id: runId },
      data: {
        status,
        cursor,
        counters: counters as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
  };

  // Le condizioni si rileggono a ogni tappa: fra la richiesta e adesso il
  // merchant puo' aver cambiato piano, associazione o permessi.
  const plan = await findPlanByName(shop.currentPlan);
  const mapping = await prisma.integrationFieldMapping.findUnique({
    where: { shopId_provider_targetField: { shopId, provider, targetField: TARGET_FIELD } },
  });
  if (!plan?.customersSyncEnabled || !mapping || !shop.supabaseConfig) {
    await finish('failed');
    return 'interrupted';
  }

  const shopify = await ShopifyAPIClient.forShop(shop.shopDomain);
  const target = await resolveBirthdateTarget(
    shopify,
    birthdateMetafieldOf(shop),
    hasCustomerWriteAccess(shop.scopes),
  );
  if (!target) {
    await finish('failed');
    return 'interrupted';
  }

  let token: string;
  try {
    token = await getAccessToken(shopId);
  } catch (error) {
    return interruptOn(error);
  }

  const { candidates, ours } = await loadCandidates(
    createSupabaseClient(shop.supabaseConfig),
    shop.supabaseConfig.tableNameCustomers,
    plan.maxCustomers,
  );
  const idx = buildIndices(candidates);
  const format = (mapping.dateFormat ?? 'auto') as DateFormat;

  async function interruptOn(error: unknown): Promise<'interrupted'> {
    if (error instanceof KlaviyoAuthError) {
      await markNeedsReconnect(shopId);
      await finish('interrupted');
      return 'interrupted';
    }
    if (error instanceof KlaviyoUnavailableError && opts.lastAttempt) {
      // Ultimo tentativo della coda: il giro si chiude qui, con cursore e
      // contatori dell'ultima pagina chiusa, invece di finire in lettera morta.
      await finish('interrupted');
      return 'interrupted';
    }
    // Klaviyo indisponibile (429 esauriti, rinnovo del token gia' in corso) e
    // ogni altro errore: l'item torna in coda col suo ritardo e riparte dal
    // cursore salvato sul giro, che resta 'running'.
    throw error;
  }

  for (;;) {
    if (opts.signal?.aborted) return 'paused';

    let page: Awaited<ReturnType<typeof listProfiles>>;
    try {
      page = await listProfiles(token, cursor);
    } catch (error) {
      return interruptOn(error);
    }

    // I contatori della pagina si sommano solo a pagina chiusa: se qualcosa
    // solleva a meta', il giro riprende da qui con i contatori di prima.
    const pageCounters = emptyCounters();
    const fills = new Map<number, string>();
    const conflicts = new Map<number, { ours: string | null; theirs: string }>();

    const matched: Array<{ customerId: number; theirs: string }> = [];
    // Abbinati con il campo vuoto su Klaviyo: un loro conflitto aperto non ha
    // piu' ragione di esistere.
    const emptied = new Set<number>();
    for (const profile of page.profiles) {
      const match = matchProfile(profile, idx);
      if ('skipped' in match) {
        if (match.skipped === 'ambiguous') pageCounters.skippedAmbiguous++;
        else pageCounters.skippedNoMatch++;
        continue;
      }
      if (match.level === 'id') pageCounters.matchedById++;
      else if (match.level === 'email') pageCounters.matchedByEmail++;
      else pageCounters.matchedByPhone++;

      const raw = Object.hasOwn(profile.properties, mapping.sourceKey)
        ? profile.properties[mapping.sourceKey]
        : null;
      const parsed = parseDate(raw, format);
      if (!parsed.ok) {
        // Vuoto su Klaviyo: non c'e' niente da importare, non e' un problema.
        if (parsed.reason !== 'empty') pageCounters.unreadable++;
        else emptied.add(match.customerId);
        continue;
      }
      matched.push({ customerId: match.customerId, theirs: parsed.date });
    }

    const prior = await loadPriorConflicts(shopId, provider, [
      ...new Set([...matched.map((m) => m.customerId), ...emptied]),
    ]);

    // Conflitti aperti che questa pagina rende superati: i due valori ora
    // combaciano, il buco e' stato riempito, o Klaviyo il valore non ce l'ha
    // piu'. Si cancellano (vedi `closeOpenConflicts`).
    const toClose = new Set<number>();
    const isOpen = (customerId: number) => prior.get(customerId)?.status === 'open';
    for (const customerId of emptied) if (isOpen(customerId)) toClose.add(customerId);

    for (const { customerId, theirs } of matched) {
      const current = fills.get(customerId) ?? ours.get(customerId) ?? null;
      const decision = decide(current, theirs, prior.get(customerId) ?? null);
      if (decision === 'fill') {
        fills.set(customerId, theirs);
      } else if (decision === 'same') {
        pageCounters.same++;
        // Uguale a un valore che stiamo per scrivere: si chiude solo se la
        // scrittura va (piu' sotto).
        if (isOpen(customerId) && !fills.has(customerId)) toClose.add(customerId);
      } else if (decision === 'decided') {
        pageCounters.decided++;
      } else {
        pageCounters.conflicts++;
        conflicts.set(customerId, { ours: current, theirs });
        prior.set(customerId, { status: 'open', theirValue: theirs });
      }
    }

    await opts.lease?.assertHeld();

    if (fills.size > 0) {
      // "Vuoto" lo dice la tabella del merchant, che puo' essere indietro
      // rispetto a Shopify: si scrive solo dove Shopify non ha ancora la data
      // (compare-and-set). Sovrascrivere e' solo di «Usa Klaviyo».
      const entries = [...fills].map(([customerId, date]) => ({ customerId, date }));
      const result = await shopify.fillCustomerBirthdatesIfAbsent(entries, target);
      pageCounters.notWritten += result.failed.length;
      pageCounters.filled += result.written.length;
      for (const customerId of result.written) {
        ours.set(customerId, fills.get(customerId)!);
        if (isOpen(customerId)) toClose.add(customerId);
      }

      // Shopify la data ce l'aveva gia': si rilegge e si decide su quella,
      // come se la tabella del merchant fosse stata aggiornata.
      if (result.present.length > 0) {
        const current = await shopify.getCustomerBirthdateValues(result.present, target);
        for (const customerId of result.present) {
          const theirs = fills.get(customerId)!;
          if (!current.has(customerId)) {
            // Non riletto (cliente sparito nel frattempo): non scritto.
            pageCounters.notWritten++;
            continue;
          }
          const shopifyValue = current.get(customerId) ?? null;
          ours.set(customerId, shopifyValue);
          const decision = decide(shopifyValue, theirs, prior.get(customerId) ?? null);
          if (decision === 'same') {
            pageCounters.same++;
            if (isOpen(customerId)) toClose.add(customerId);
          } else if (decision === 'decided') {
            pageCounters.decided++;
          } else if (decision === 'conflict') {
            pageCounters.conflicts++;
            conflicts.set(customerId, { ours: shopifyValue, theirs });
            prior.set(customerId, { status: 'open', theirValue: theirs });
          } else {
            // Il metafield esiste ma e' vuoto: non lo si tocca lo stesso, la
            // garanzia e' "mai sopra un metafield esistente".
            pageCounters.notWritten++;
          }
        }
      }
    }

    for (const [customerId, { ours: ourValue, theirs }] of conflicts) {
      toClose.delete(customerId);
      await upsertConflict(shopId, provider, customerId, ourValue, theirs);
    }
    await closeOpenConflicts(shopId, provider, [...toClose]);

    for (const k of COUNTER_KEYS) counters[k] += pageCounters[k];
    cursor = page.next;

    if (!cursor) {
      await finish('completed');
      return 'completed';
    }

    await prisma.integrationImportRun.update({
      where: { id: runId },
      data: { cursor, counters: counters as unknown as Prisma.InputJsonValue },
    });

    if (opts.signal?.aborted) return 'paused';
    if (budget - (clock() - start) < MIN_REMAINING_MS) {
      await opts.saveCursor(cursor, runId);
      return 'paused';
    }
  }
}

const CANDIDATE_COLUMNS =
  'id, shopify_customer_id, email_address, phone_number, country_code, date_of_birth, created_at';

/**
 * I clienti a cui un profilo puo' essere abbinato: idonei (consenso) ed entro
 * il tetto del piano. Con un tetto, gli ammessi sono al piu' qualche centinaio
 * e si leggono per id; senza, si legge tutta la tabella a pagine.
 */
async function loadCandidates(
  supabase: ReturnType<typeof createSupabaseClient>,
  tableName: string,
  maxCustomers: number | null | undefined,
): Promise<{ candidates: CandidateCustomer[]; ours: Map<number, string | null> }> {
  const loaded = await loadCustomerQuota(supabase, tableName, maxCustomers);
  if (!loaded.ok) throw new Error(`tetto clienti non leggibile: ${loaded.error}`);

  const table = { id: 'customers' as const, name: tableName };
  const limited = loaded.quota.remaining() !== null;
  const read = limited
    ? await readAllByIn(supabase, table, 'shopify_customer_id', loaded.quota.chosenIds(), CANDIDATE_COLUMNS)
    : await drainPages(table, (after, limit) => {
        let query = supabase
          .from(tableName)
          .select(CANDIDATE_COLUMNS)
          .eq('accepts_marketing', true);
        if (after !== null) query = query.gt('id', after);
        return query.order('id', { ascending: true }).limit(limit);
      });
  if (read.error) {
    const message = (read.error as { message?: string }).message ?? 'lettura non riuscita';
    throw new Error(`clienti del merchant non leggibili: ${message}`);
  }

  const candidates: CandidateCustomer[] = [];
  const ours = new Map<number, string | null>();
  for (const row of read.rows) {
    const id = Number(row.shopify_customer_id);
    if (!Number.isSafeInteger(id)) continue;
    candidates.push({
      shopifyCustomerId: id,
      email: (row.email_address as string | null) ?? null,
      phone: (row.phone_number as string | null) ?? null,
      countryCode: (row.country_code as string | null) ?? null,
    });
    ours.set(id, oursAsIso((row.date_of_birth as string | null) ?? null));
  }
  return { candidates, ours };
}

/**
 * La data di nascita come la tiene la tabella del merchant (`YYYYMMDD`) in ISO,
 * il formato di Klaviyo e di Shopify: cosi' il confronto e il conflitto
 * registrato parlano la stessa lingua. Un valore in un altro formato resta
 * com'e' (`decide` lo tratta da solo).
 */
export function oursAsIso(value: string | null): string | null {
  if (value === null) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : value;
}

async function loadPriorConflicts(
  shopId: string,
  provider: Provider,
  customerIds: number[],
): Promise<Map<number, PriorConflict>> {
  const prior = new Map<number, PriorConflict>();
  if (customerIds.length === 0) return prior;
  const ids = customerIds.map(String);
  const rows = await prisma.$queryRaw<
    Array<{ shopify_customer_id: bigint | number | string; status: string; their_value: string }>
  >`SELECT shopify_customer_id, status, their_value
      FROM integration_conflicts
     WHERE shop_id = ${shopId}
       AND provider = ${provider}
       AND target_field = 'birthdate'
       AND shopify_customer_id = ANY(${ids}::bigint[])`;
  for (const row of rows) {
    prior.set(Number(row.shopify_customer_id), {
      status: row.status as PriorConflict['status'],
      theirValue: row.their_value,
    });
  }
  return prior;
}

/**
 * Chiude i conflitti APERTI che non hanno piu' ragione di esistere.
 *
 * Si cancellano invece di segnarli in un altro stato: 'kept_ours' e
 * 'used_theirs' dicono "il merchant ha scelto", e qui non ha scelto nessuno;
 * uno stato nuovo andrebbe insegnato a elenco, conteggi ed export. Un
 * conflitto che non c'e' piu' semplicemente non si mostra; se i valori
 * tornano a divergere, il giro dopo ne apre uno nuovo. Le decisioni gia' prese
 * non si toccano: il filtro su 'open' e' nell'SQL, perche' il merchant puo'
 * decidere fra la lettura e questa cancellazione.
 */
async function closeOpenConflicts(
  shopId: string,
  provider: Provider,
  customerIds: number[],
): Promise<void> {
  if (customerIds.length === 0) return;
  const ids = customerIds.map(String);
  await prisma.$executeRaw`
    DELETE FROM integration_conflicts
     WHERE shop_id = ${shopId}
       AND provider = ${provider}
       AND target_field = 'birthdate'
       AND status = 'open'
       AND shopify_customer_id = ANY(${ids}::bigint[])`;
}

/**
 * Apre (o riapre) il conflitto di un cliente. Una riga per cliente e campo.
 *
 * Una decisione gia' presa resta in piedi se il valore di Klaviyo e' quello
 * su cui il merchant ha deciso: il controllo e' anche qui, nell'SQL, perche'
 * il merchant puo' decidere fra la lettura e questa scrittura.
 */
async function upsertConflict(
  shopId: string,
  provider: Provider,
  customerId: number,
  ourValue: string | null,
  theirValue: string,
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO integration_conflicts
      (id, shop_id, provider, shopify_customer_id, target_field, our_value, their_value,
       status, decided_at, created_at, updated_at)
    VALUES
      (${randomUUID()}, ${shopId}, ${provider}, ${String(customerId)}::bigint, 'birthdate',
       ${ourValue}, ${theirValue}, 'open', NULL, NOW(), NOW())
    ON CONFLICT (shop_id, provider, shopify_customer_id, target_field) DO UPDATE SET
      our_value = EXCLUDED.our_value,
      their_value = EXCLUDED.their_value,
      status = CASE
        WHEN integration_conflicts.status <> 'open'
         AND integration_conflicts.their_value = EXCLUDED.their_value
        THEN integration_conflicts.status ELSE 'open' END,
      decided_at = CASE
        WHEN integration_conflicts.status <> 'open'
         AND integration_conflicts.their_value = EXCLUDED.their_value
        THEN integration_conflicts.decided_at ELSE NULL END,
      updated_at = NOW()`;
}
