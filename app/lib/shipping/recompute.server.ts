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
import { dedupKeyFor, redactError } from '~/lib/queue/queue-model';
import { enqueueSyncRequest } from '~/lib/queue/queue-store.server';
import { triggerSyncDrain } from '~/lib/queue/trigger.server';
import { computeLogisticsCost } from './logistics-cost';
import { loadLogisticsConfigStrict } from './load-config.server';
import type { OrderLogisticsInput } from './types';

/** Ordini letti e riscritti per giro: una SELECT e un UPDATE ciascuno. */
export const RECOMPUTE_PAGE_SIZE = 500;

/**
 * Quante volte si segue la catena dei ricalcoli gia' partiti.
 *
 * Ogni anello e' un ricalcolo che ha gia' letto le tariffe: la catena cresce
 * di uno solo quando un salvataggio arriva mentre l'ultimo sta lavorando,
 * quindi nella pratica e' lunga uno o due. Il tetto c'e' solo perche' un ciclo
 * senza tetto e' un ciclo che prima o poi non finisce.
 */
const MAX_CATENA = 5;

/** Il tetto di NUMERIC(10,2): oltre, Postgres rifiuterebbe l'intera pagina. */
const MAX_COSTO = 99_999_999.99;

const ID_VALIDO = /^[0-9]{1,19}$/;

interface LeaseLike {
  assertHeld(): Promise<void>;
}

/**
 * Mette in coda il ricalcolo per un negozio. Da chiamare DOPO aver salvato.
 *
 * LA DEDUPLICA. La stessa delle sincronizzazioni (tipo + negozio + finestra di
 * un minuto): dieci salvataggi di fila fanno un ricalcolo solo. Con una
 * differenza che qui conta: un salvataggio si puo' fondere in un ricalcolo solo
 * se quello non ha ancora letto le tariffe, cioe' se e' ancora 'queued'. Se e'
 * gia' partito (o finito) le ha lette vecchie, e fondersi in lui vorrebbe dire
 * lasciare sugli ordini i costi di prima del salvataggio. Allora se ne accoda
 * uno "dopo di lui", con una chiave legata al suo id: i salvataggi successivi
 * si fondono in quello, finche' non parte a sua volta.
 *
 * NON SOLLEVA. Chi chiama ha gia' salvato: far fallire la sua action per un
 * guasto della coda mostrerebbe un errore su un salvataggio riuscito. Il guasto
 * finisce nei log come ALLARME, e il prossimo salvataggio riaccoda.
 */
export async function enqueueLogisticsRecompute(shopId: string): Promise<void> {
  try {
    const base = dedupKeyFor('logistics-recompute', shopId, new Date());
    let chiave = base;

    for (let anello = 0; anello < MAX_CATENA; anello++) {
      const esito = await enqueueSyncRequest({
        type: 'logistics-recompute',
        shopId,
        dedupKey: chiave,
      });
      if (!esito.duplicate) break;

      const esistente = await prisma.syncRequest.findUnique({
        where: { dedupKey: chiave },
        select: { id: true, status: true },
      });
      // Ancora da prendere: leggera' le tariffe appena salvate. Basta lui.
      if (!esistente || esistente.status === 'queued') break;

      chiave = `${base}:dopo:${esistente.id}`;
    }

    triggerSyncDrain(shopId);
  } catch (error) {
    console.error(
      `[logistics-recompute] ALLARME ricalcolo non accodato per il negozio ${shopId}: ${redactError(error)}`,
    );
  }
}

/** Una riga letta dal database del merchant, come la restituisce la Management API. */
interface OrderRow {
  shopify_order_id: string | number;
  fulfillment_status: string | null;
  shipping_country_code: string | null;
  total_weight_grams: number | string | null;
  item_count: number | string | null;
  returned_at: string | null;
  packaging_category: string | null;
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
  };
}

/**
 * L'id come testo di sole cifre, oppure un'eccezione.
 *
 * Nessun id finisce nell'SQL senza passare di qui: e' un bigint di Shopify, e
 * tutto cio' che non e' fatto di sole cifre non e' un id ma un problema.
 */
function idSicuro(valore: string | number): string {
  const testo = typeof valore === 'number' ? (Number.isSafeInteger(valore) ? String(valore) : '') : valore;
  if (!ID_VALIDO.test(testo)) {
    throw new Error(`shopify_order_id non valido nel ricalcolo: ${String(valore).slice(0, 40)}`);
  }
  return testo;
}

/**
 * Il costo come letterale numerico a due decimali.
 *
 * Un valore non finito o fuori dal tetto della colonna diventa zero: e' la
 * stessa scelta di chi scrive gli ordini quando il costo non si sa, e non
 * blocca la pagina intera per un ordine solo.
 */
function costoSicuro(valore: number): string {
  if (!Number.isFinite(valore) || Math.abs(valore) > MAX_COSTO) return '0.00';
  const arrotondato = Math.round(valore * 100) / 100;
  // `Object.is` per non scrivere "-0.00".
  return (Object.is(arrotondato, -0) ? 0 : arrotondato).toFixed(2);
}

/** La lettura di una pagina di ordini, dopo l'ultimo id visto. */
export function recomputeSelectSQL(dopoId: string | null): string {
  const filtro = dopoId === null ? '' : `WHERE shopify_order_id > ${idSicuro(dopoId)}\n`;
  // L'id torna come testo: un bigint nel JSON perderebbe precisione oltre 2^53.
  return `SELECT shopify_order_id::text AS shopify_order_id, fulfillment_status,
  shipping_country_code, total_weight_grams, item_count, returned_at, packaging_category
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

/** La tabella o la colonna non ci sono ancora: niente da ricalcolare. */
function tabellaAssente(error: unknown): boolean {
  const messaggio = error instanceof Error ? error.message : String(error);
  return /relation .* does not exist|column .* does not exist|42P01|42703/i.test(messaggio);
}

/** Il database del merchant risulta fermo secondo quel che sappiamo. */
async function databaseFermo(shopId: string): Promise<boolean> {
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
export async function processLogisticsRecompute(
  shopId: string,
  ctx: { lease?: LeaseLike; signal?: AbortSignal } = {},
): Promise<void> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { supabaseConfig: true },
  });
  const ref = shop?.supabaseConfig?.supabaseProjectRef;
  if (!shop || !ref) {
    console.log(`[logistics-recompute] negozio ${shopId} senza database collegato: niente da ricalcolare`);
    return;
  }

  // La stessa porta delle sincronizzazioni: collegamento, disinstallazione,
  // permesso sugli ordini. Senza ordini sincronizzati non c'e' niente da
  // riscrivere, e un negozio disinstallato non va toccato.
  const plan = await findPlanByName(shop.currentPlan);
  if (!can(shopCapabilitiesWithPlan(shop, plan), 'sync_orders')) {
    console.log(`[logistics-recompute] negozio ${shopId} senza sync ordini: ricalcolo saltato`);
    return;
  }

  if (await databaseFermo(shopId)) {
    console.warn(`[logistics-recompute] database del negozio ${shopId} in pausa: ricalcolo saltato`);
    return;
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
      return;
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

  let dopoId: string | null = null;
  let aggiornati = 0;

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
    }
  } catch (error) {
    if (error instanceof Salta) return;
    throw error;
  }

  console.log(`[logistics-recompute] negozio ${shopId}: ${aggiornati} ordini ricalcolati`);
}
