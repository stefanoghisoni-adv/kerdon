// app/lib/shipping/recompute.server.ts
//
// Il ricalcolo di `orders.logistics_cost` quando il merchant cambia zone,
// tariffe o packaging.
//
// PERCHE' ESISTE. Il costo logistico e' salvato sull'ordine al momento della
// scrittura (spec, Revisione 1.1 punto 1): il profitto si calcola in SQL sul
// database del merchant e le tariffe stanno sul DB owner, quindi non si possono
// unire in una query. Il prezzo di quella scelta e' questo file: quando le
// tariffe cambiano, i costi gia' scritti sono vecchi e vanno riscritti tutti.
//
// COME. E' un tipo di lavoro in piu' della coda esistente ('logistics-recompute'),
// non una coda parallela: stessa deduplica per negozio, stesso lucchetto del
// negozio, stessi ritentativi con backoff e lettera morta.

import { prisma } from '~/db.server';
import { runQuery, runQueryRows, isSupabaseCredentialDead } from '~/lib/supabase-management.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { applyMerchantSchemaUpdate } from '~/lib/supabase/apply-schema-update.server';
import { getDatabasePauseState } from '~/lib/cache/database-pause-cache.server';
import { noteDatabaseUnreachable } from '~/lib/supabase/database-pause.server';
import { databaseIsStopped, effectiveAvailability } from '~/lib/supabase/database-pause';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { shopCapabilitiesWithPlan } from '~/lib/authz/shop-capabilities.server';
import { can } from '~/lib/authz/capabilities';
import { redactError } from '~/lib/queue/queue-model';
import { enqueueLogisticsContinuation } from './recompute-enqueue.server';
import { computeLogisticsCost } from './logistics-cost';
import { clampLogisticsCost } from './cost-clamp';
import { loadLogisticsConfigStrict } from './load-config.server';
import type { OrderLogisticsInput } from './types';

/** Ordini letti e riscritti per giro: una SELECT e un UPDATE ciascuno. */
export const RECOMPUTE_PAGE_SIZE = 500;

/**
 * Quanto lavora una corsa prima di passare il testimone a una continuazione.
 *
 * Sotto il tetto del tipo (270 s in queue-model) con margine per l'ultima
 * pagina e per l'accodamento del seguito. Senza tappe, un negozio con
 * centinaia di migliaia di ordini toccherebbe il tetto a ogni tentativo,
 * ripartirebbe da zero ogni volta e finirebbe in lettera morta senza aver mai
 * finito.
 */
export const RECOMPUTE_BUDGET_MS = 200_000;

/** Un id d'ordine di Shopify come testo: solo cifre, al massimo un bigint. */
export const ID_VALIDO = /^[0-9]{1,19}$/;

interface LeaseLike {
  assertHeld(): Promise<void>;
}

// L'accodamento vive in un file suo (vedi li' il perche'); lo si riesporta da
// qui perche' e' questo il punto d'ingresso che le rotte delle tariffe usano.
export { enqueueLogisticsRecompute } from './recompute-enqueue.server';

/** Una riga letta dal database del merchant, come la restituisce la Management API. */
interface OrderRow {
  shopify_order_id: string | number;
  fulfillment_status: string | null;
  shipping_country_code: string | null;
  total_weight_grams: number | string | null;
  item_count: number | string | null;
  returned_at: string | null;
  packaging_category: string | null;
  shipping_method: string | null;
  /** NUMERIC: la Management API puo' restituirlo come testo. */
  total_price: number | string | null;
  /** INTEGER, ma come gli altri numeri lo si accetta anche come testo. */
  package_count: number | string | null;
}

/** Un numero dal JSON della Management API, o null se non lo e'. */
function numeroOppureNull(valore: number | string | null): number | null {
  if (valore === null || valore === undefined) return null;
  const n = Number(valore);
  return Number.isFinite(n) ? n : null;
}

function inputDi(riga: OrderRow): OrderLogisticsInput {
  return {
    fulfillment_status: riga.fulfillment_status ?? null,
    shipping_country_code: riga.shipping_country_code ?? null,
    total_weight_grams: numeroOppureNull(riga.total_weight_grams),
    item_count: numeroOppureNull(riga.item_count),
    returned_at: riga.returned_at ?? null,
    packaging_category: riga.packaging_category ?? null,
    // Gli stessi due campi che la scrittura dell'ordine passa al costo: se
    // mancassero qui, il ricalcolo riporterebbe tutti gli ordini alla tariffa
    // generica e il costo cambierebbe a seconda di chi ha scritto per ultimo.
    shipping_method: riga.shipping_method ?? null,
    total_price: numeroOppureNull(riga.total_price),
    // Come l'opzione: se il ricalcolo non leggesse i pacchi, ogni ordine
    // riletto pagherebbe un pacco solo, e il costo cambierebbe a seconda di
    // chi ha scritto per ultimo.
    package_count: numeroOppureNull(riga.package_count),
  };
}

/**
 * L'id come testo di sole cifre, oppure un'eccezione.
 *
 * Nessun id finisce nell'SQL senza passare di qui: e' un bigint di Shopify, e
 * tutto cio' che non e' fatto di sole cifre non e' un id ma un problema.
 */
export function idSicuro(valore: string | number): string {
  const testo = typeof valore === 'number' ? (Number.isSafeInteger(valore) ? String(valore) : '') : valore;
  if (!ID_VALIDO.test(testo)) {
    throw new Error(`shopify_order_id non valido nel ricalcolo: ${String(valore).slice(0, 40)}`);
  }
  return testo;
}

/**
 * Il costo come letterale numerico a due decimali.
 *
 * La regola (non finito, negativo o oltre il tetto della colonna diventa zero)
 * e' quella di `clampLogisticsCost`, la stessa di chi scrive gli ordini: un
 * ordine deve avere lo stesso costo chiunque l'abbia scritto per ultimo.
 */
function costoSicuro(valore: number): string {
  return clampLogisticsCost(valore).toFixed(2);
}

/** La lettura di una pagina di ordini, dopo l'ultimo id visto. */
export function recomputeSelectSQL(dopoId: string | null): string {
  const filtro = dopoId === null ? '' : `WHERE shopify_order_id > ${idSicuro(dopoId)}\n`;
  // L'id torna come testo: un bigint nel JSON perderebbe precisione oltre 2^53.
  return `SELECT shopify_order_id::text AS shopify_order_id, fulfillment_status,
  shipping_country_code, total_weight_grams, item_count, returned_at, packaging_category,
  shipping_method, total_price, package_count
FROM orders
${filtro}ORDER BY shopify_order_id
LIMIT ${RECOMPUTE_PAGE_SIZE};`;
}

/**
 * La scrittura di una pagina: un UPDATE solo, con i valori in una VALUES.
 *
 * Ogni valore e' passato da `idSicuro` o `costoSicuro` prima di finire nel
 * testo: nient'altro viene interpolato. `IS DISTINCT FROM` evita di riscrivere
 * righe gia' giuste: il risultato e' lo stesso (tutte le righe hanno il costo
 * nuovo), ma senza generare righe morte per niente.
 */
export function recomputeUpdateSQL(valori: Array<{ id: string | number; cost: number }>): string {
  const tuple = valori.map((v) => `(${idSicuro(v.id)}::bigint, ${costoSicuro(v.cost)}::numeric)`);
  return `UPDATE orders AS o
SET logistics_cost = v.cost
FROM (VALUES ${tuple.join(', ')}) AS v(id, cost)
WHERE o.shopify_order_id = v.id
  AND o.logistics_cost IS DISTINCT FROM v.cost;`;
}

/**
 * La tabella o la colonna non ci sono ancora: niente da ricalcolare.
 *
 * Copre anche `shipping_method` quando lo schema 13 non e' arrivato (per
 * esempio se l'aggiornamento appena tentato e' fallito): la SELECT la nomina,
 * e un ricalcolo senza di lei riporterebbe tutti gli ordini alla tariffa
 * generica. Meglio non scrivere niente e lasciare i costi di prima.
 */
export function tabellaAssente(error: unknown): boolean {
  const messaggio = error instanceof Error ? error.message : String(error);
  return /relation .* does not exist|column .* does not exist|42P01|42703/i.test(messaggio);
}

/** Il database del merchant risulta fermo secondo quel che sappiamo. */
export async function databaseFermo(shopId: string): Promise<boolean> {
  const stato = await getDatabasePauseState(shopId);
  return stato !== null && databaseIsStopped(effectiveAvailability(stato, new Date()));
}

/**
 * Il lavoro della coda: riscrive il costo logistico di tutti gli ordini.
 *
 * Gli esiti, e il perche' di ciascuno:
 * - negozio che non sincronizza ordini, database fermo, tabella o colonna
 *   assente: si esce senza errore, come gli altri job. Non c'e' niente da
 *   ricalcolare, e ritentare non cambierebbe le cose.
 * - tariffe illeggibili per un guasto: si esce SENZA scrivere e si solleva,
 *   cosi' la coda ritenta con il suo backoff. Scrivere con una configurazione
 *   "vuota" azzererebbe costi giusti.
 * - qualunque altro guasto del database acceso: si solleva, la coda ritenta.
 */
export interface RecomputeContext {
  lease?: LeaseLike;
  signal?: AbortSignal;
  /** L'id dell'item in coda: lega la chiave della continuazione a questa corsa. */
  jobId?: string;
  /** Da dove riprendere, se questa e' una continuazione. null = da zero. */
  cursor?: string | null;
  /** Iniettabili per le prove: il budget di una tappa e l'orologio in ms. */
  budgetMs?: number;
  clock?: () => number;
}

/**
 * Com'e' finita una corsa.
 *
 * - completed: tutti gli ordini hanno il costo delle tariffe lette adesso.
 * - continued: budget finito, il resto e' in coda come continuazione.
 * - skipped: non c'era niente da fare o non si poteva farlo adesso (niente
 *   database, niente ordini, database fermo, tabella o colonna assente).
 *
 * Serve al ricalcolo dentro il salvataggio (recompute-inline.server): e' da qui
 * che sa se puo' dire al merchant "numeri aggiornati" o solo "a breve".
 */
export type RecomputeOutcome = 'completed' | 'continued' | 'skipped';

export async function processLogisticsRecompute(
  shopId: string,
  ctx: RecomputeContext = {},
): Promise<RecomputeOutcome> {
  const orologio = ctx.clock ?? (() => Date.now());
  const partenza = orologio();
  const budget = ctx.budgetMs ?? RECOMPUTE_BUDGET_MS;

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { supabaseConfig: true },
  });
  const ref = shop?.supabaseConfig?.supabaseProjectRef;
  if (!shop || !ref) {
    console.log(`[logistics-recompute] negozio ${shopId} senza database collegato: niente da ricalcolare`);
    return 'skipped';
  }

  // La stessa porta delle sincronizzazioni: collegamento, disinstallazione,
  // permesso sugli ordini. Senza ordini sincronizzati non c'e' niente da
  // riscrivere, e un negozio disinstallato non va toccato.
  const plan = await findPlanByName(shop.currentPlan);
  if (!can(shopCapabilitiesWithPlan(shop, plan), 'sync_orders')) {
    console.log(`[logistics-recompute] negozio ${shopId} senza sync ordini: ricalcolo saltato`);
    return 'skipped';
  }

  if (await databaseFermo(shopId)) {
    console.warn(`[logistics-recompute] database del negozio ${shopId} in pausa: ricalcolo saltato`);
    return 'skipped';
  }

  // Le tariffe una volta sola, PRIMA di toccare il database del merchant: se
  // non si leggono non si scrive niente.
  let config;
  try {
    config = await loadLogisticsConfigStrict(shopId);
  } catch (error) {
    console.warn(
      `[logistics-recompute] tariffe non leggibili per il negozio ${shopId}: nessuna scrittura, la coda ritentera' (${redactError(error)})`,
    );
    throw new Error('configurazione logistica non leggibile: ricalcolo rimandato');
  }

  // Come fanno le sincronizzazioni prima di scrivere: se lo schema del merchant
  // e' indietro (colonna logistics_cost assente), lo si allinea adesso.
  await applyMerchantSchemaUpdate(shopId);

  let token: string;
  try {
    token = await getValidAccessToken(shopId);
  } catch (error) {
    // Collegamento revocato: ritentare non lo riaccende. Lo dira' il banner.
    if (isSupabaseCredentialDead(error)) {
      console.warn(`[logistics-recompute] collegamento Supabase non valido per il negozio ${shopId}: ricalcolo saltato`);
      return 'skipped';
    }
    throw error;
  }

  /**
   * Una chiamata al database del merchant, con i suoi fallimenti classificati.
   *
   * Solo gli errori che vengono DA LI' passano per la classificazione: un
   * possesso perso o un'interruzione non sono un database fermo, e devono
   * arrivare alla coda cosi' come sono.
   */
  class Salta extends Error {}
  const suDatabase = async <T>(chiamata: () => Promise<T>): Promise<T> => {
    try {
      return await chiamata();
    } catch (error) {
      if (tabellaAssente(error)) {
        console.warn(`[logistics-recompute] tabella ordini non pronta per il negozio ${shopId}: ricalcolo saltato`);
        throw new Salta();
      }
      // Un fallimento puo' voler dire che il database si e' appena fermato:
      // lo si chiede a Supabase (la stessa rilevazione della dashboard) e, se
      // e' cosi', si esce in silenzio come gli altri job.
      await noteDatabaseUnreachable(shopId);
      if (await databaseFermo(shopId)) {
        console.warn(`[logistics-recompute] database del negozio ${shopId} in pausa: ricalcolo interrotto`);
        throw new Salta();
      }
      throw error;
    }
  };

  // Il cursore arriva dal payload della coda: lo si valida come qualunque altro
  // valore che finisce nell'SQL. Se e' malformato si riparte da zero, che
  // costa tempo ma non sbaglia niente.
  let dopoId: string | null = null;
  if (ctx.cursor != null) {
    if (ID_VALIDO.test(ctx.cursor)) dopoId = ctx.cursor;
    else console.warn(`[logistics-recompute] cursore non valido per il negozio ${shopId}: si riparte da zero`);
  }
  let aggiornati = 0;
  let passaggio: string | null = null;

  try {
    for (;;) {
      // Fra una pagina e l'altra: il tetto di durata o lo spegnimento fermano
      // la corsa qui, non a meta' di una scrittura.
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('ricalcolo interrotto');

      const sql = recomputeSelectSQL(dopoId);
      const righe = await suDatabase(() => runQueryRows<OrderRow>(token, ref, sql));
      if (righe.length === 0) break;

      const valori = righe.map((riga) => ({
        id: riga.shopify_order_id,
        cost: computeLogisticsCost(inputDi(riga), config).total,
      }));
      const update = recomputeUpdateSQL(valori);

      // Il permesso di scrivere, riverificato prima di ogni pagina come fanno
      // le sincronizzazioni.
      await ctx.lease?.assertHeld();
      await suDatabase(() => runQuery(token, ref, update));
      aggiornati += righe.length;

      if (righe.length < RECOMPUTE_PAGE_SIZE) break;
      dopoId = idSicuro(righe[righe.length - 1].shopify_order_id);

      // Budget finito: ci si ferma su un confine di pagina, con tutto quel che
      // e' stato letto gia' scritto, e si passa il cursore a una continuazione.
      // Questa corsa si chiude completata; il seguito riparte in
      // un'invocazione nuova, con il suo budget intero.
      if (orologio() - partenza >= budget) {
        passaggio = dopoId;
        break;
      }
    }
  } catch (error) {
    if (error instanceof Salta) return 'skipped';
    throw error;
  }

  if (passaggio !== null) {
    // Solleva se non entra in coda: meglio ritentare questa corsa che
    // dichiararla finita lasciando indietro il resto degli ordini.
    await enqueueLogisticsContinuation(shopId, ctx.jobId ?? 'senza-item', passaggio);
    console.log(
      `[logistics-recompute] negozio ${shopId}: ${aggiornati} ordini ricalcolati, si prosegue dopo l'ordine ${passaggio}`,
    );
    return 'continued';
  }

  console.log(`[logistics-recompute] negozio ${shopId}: ${aggiornati} ordini ricalcolati`);
  return 'completed';
}
