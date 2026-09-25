// app/lib/shipping/shipping-method-backfill.server.ts
//
// Il recupero dell'opzione di spedizione (schema 13) e dei pacchi spediti
// (schema 14) sugli ordini salvati prima che quelle colonne esistessero.
//
// PERCHE' ESISTE. Il costo di un ordine si prende dall'opzione scelta dal
// cliente (`shipping_method`), ma quella colonna e' arrivata con lo schema 13:
// gli ordini scritti prima la hanno NULL, e per loro le opzioni che il merchant
// ha appena prezzato non contano. Restano sulla tariffa generica della zona
// finche' la sincronizzazione non li riscrive, cioe' per molti mai (un ordine
// vecchio non cambia piu'). Questo lavoro chiede a Shopify solo quel dato, per
// quei soli ordini, e alla fine ricalcola i costi.
//
// Con lo schema 14 lo stesso discorso vale per `package_count`, i pacchi
// spediti che servono al costo per pacco. Lo si chiede nella stessa domanda:
// un secondo lavoro rifarebbe a Shopify le stesse domande sugli stessi ordini.
//
// COME. Un tipo di lavoro della coda esistente, sulla falsariga del ricalcolo:
// stesso lucchetto del negozio, stesse uscite silenziose, stesso passo a tappe
// con budget e continuazione dal cursore. Le differenze:
// - si leggono solo gli ordini con `shipping_method` o `package_count` NULL;
// - Shopify si interroga con `nodes(ids:)` a lotti, chiedendo il titolo della
//   prima shipping line e lo stato delle spedizioni
//   (vedi ShopifyAPIClient.getOrderShippingFacts);
// - la scrittura riempie solo le colonne ancora NULL, una per una: un valore
//   gia' scritto dalla sincronizzazione nel frattempo vince sempre;
// - un ordine senza shipping line riceve '' (stringa vuota): la sentinella
//   "controllato, nessuna opzione", che il calcolo del costo tratta come NULL
//   (findOption) ma che toglie l'ordine dalla lettura successiva. Senza, gli
//   ordini ritirati in negozio o digitali verrebbero richiesti a ogni corsa.
//   Per i pacchi la sentinella e' 0 ("controllato, nessuna spedizione"), che
//   il calcolo gia' legge come un pacco se l'ordine risulta spedito.

import { prisma } from '~/db.server';
import { runQuery, runQueryRows, isSupabaseCredentialDead } from '~/lib/supabase-management.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { noteDatabaseUnreachable } from '~/lib/supabase/database-pause.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { shopCapabilitiesWithPlan } from '~/lib/authz/shop-capabilities.server';
import { can } from '~/lib/authz/capabilities';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { enqueueLogisticsRecompute } from './recompute-enqueue.server';
import { enqueueShippingMethodBackfillContinuation } from './shipping-method-backfill-enqueue.server';
import { ID_VALIDO, databaseFermo, idSicuro, tabellaAssente, type RecomputeOutcome } from './recompute.server';
import { SHIPPED_STATUSES } from './logistics-cost';

/** Ordini senza opzione letti dal database del merchant per giro. */
export const BACKFILL_PAGE_SIZE = 250;

/**
 * Id per query a Shopify.
 *
 * Il costo richiesto di `nodes(ids:)` con una connessione da un elemento e la
 * lista delle spedizioni (al piu' 10, solo lo stato) resta sotto i 15 punti
 * per ordine: 50 ordini sono al massimo ~750 punti, sotto il tetto di 1000 per
 * query e sostenibili anche dal serbatoio del piano base (1000 punti, 50 al
 * secondo). Il client aspetta da solo quando il serbatoio non basta per il
 * lotto dopo, e lo scrive nei log.
 */
export const BACKFILL_NODES_BATCH = 50;

/** Come il ricalcolo: sotto il tetto del tipo (270 s) con margine. */
export const BACKFILL_BUDGET_MS = 200_000;

/** Un titolo di Shopify e' corto; oltre questo e' un dato che non ha senso scrivere intero. */
const TITOLO_MAX = 500;

interface LeaseLike {
  assertHeld(): Promise<void>;
}

/** Quel che serve di Shopify: titolo della prima shipping line e pacchi, per id. */
export interface ShippingFactsClient {
  getOrderShippingFacts(ids: string[]): Promise<Map<string, { method: string; packageCount: number }>>;
}

/** Il valore di una riga da completare. */
export interface BackfillValue {
  id: string;
  method: string;
  packageCount: number;
}

/**
 * Il titolo come espressione SQL che non contiene niente di Shopify.
 *
 * Il titolo e' testo libero scritto dal merchant (o da un'app di spedizioni):
 * raddoppiare gli apici basterebbe con `standard_conforming_strings` acceso,
 * ma e' una scommessa sulla configurazione del database di qualcun altro.
 * L'esadecimale invece e' fatto di sole cifre e lettere a-f, e si verifica. Il
 * carattere NUL si toglie perche' Postgres lo rifiuta nel testo e farebbe
 * fallire l'intera pagina.
 */
function testoSicuro(valore: string): string {
  const pulito = valore.replace(/\u0000/g, '').slice(0, TITOLO_MAX);
  const hex = Buffer.from(pulito, 'utf8').toString('hex');
  if (!/^[0-9a-f]*$/.test(hex)) throw new Error('titolo non codificabile nel recupero opzione');
  return `convert_from(decode('${hex}', 'hex'), 'UTF8')`;
}

/**
 * I pacchi come letterale intero, oppure un'eccezione: come l'id, nessun
 * numero finisce nell'SQL senza essere verificato.
 */
function pacchiSicuri(valore: number): string {
  if (!Number.isSafeInteger(valore) || valore < 0) {
    throw new Error(`numero di pacchi non valido nel recupero: ${String(valore).slice(0, 40)}`);
  }
  return `${valore}::integer`;
}

/**
 * "Spedito con un paese" in SQL: le stesse due condizioni con cui il calcolo
 * decide se far pagare la spedizione (isShipped e il paese non vuoto). Gli
 * stati arrivano dalla costante del calcolo, non riscritti a mano.
 */
const SPEDITO_CON_PAESE = `UPPER(fulfillment_status) IN (${SHIPPED_STATUSES.map((s) => `'${s}'`).join(', ')}) AND COALESCE(shipping_country_code, '') <> ''`;

/**
 * La lettura di una pagina di ordini ancora da completare, dopo l'ultimo id visto.
 *
 * L'opzione serve a ogni ordine; i pacchi solo a chi il calcolo fa pagare la
 * spedizione. Un ordine mai spedito o senza paese non la paga, quindi i suoi
 * pacchi non cambierebbero niente: chiederli a Shopify sarebbe solo costo. Se
 * piu' avanti parte, la sincronizzazione lo riscrive con i pacchi.
 */
export function backfillSelectSQL(dopoId: string | null): string {
  const filtro = dopoId === null ? '' : `\n  AND shopify_order_id > ${idSicuro(dopoId)}`;
  // L'id torna come testo: un bigint nel JSON perderebbe precisione oltre 2^53.
  return `SELECT shopify_order_id::text AS shopify_order_id
FROM orders
WHERE (shipping_method IS NULL
  OR (package_count IS NULL AND ${SPEDITO_CON_PAESE}))${filtro}
ORDER BY shopify_order_id
LIMIT ${BACKFILL_PAGE_SIZE};`;
}

/**
 * La scrittura di una pagina: un UPDATE solo, con i valori in una VALUES.
 *
 * `COALESCE(colonna, nuovo)` su ciascuna colonna e' la garanzia che il
 * recupero non tocca mai un valore gia' scritto: un ordine letto perche' gli
 * mancavano i pacchi ha gia' la sua opzione, e quella resta; e se la
 * sincronizzazione ha riscritto l'ordine fra la nostra lettura e la nostra
 * scrittura, il suo dato e' piu' fresco del nostro. La condizione sul WHERE
 * evita solo di riscrivere righe gia' complete.
 */
export function backfillUpdateSQL(valori: BackfillValue[]): string {
  const tuple = valori.map(
    (v) => `(${idSicuro(v.id)}::bigint, ${testoSicuro(v.method)}, ${pacchiSicuri(v.packageCount)})`,
  );
  return `UPDATE orders AS o
SET shipping_method = COALESCE(o.shipping_method, v.m),
  package_count = COALESCE(o.package_count, v.p)
FROM (VALUES ${tuple.join(', ')}) AS v(id, m, p)
WHERE o.shopify_order_id = v.id
  AND (o.shipping_method IS NULL OR o.package_count IS NULL);`;
}

export interface BackfillContext {
  lease?: LeaseLike;
  signal?: AbortSignal;
  /** L'id dell'item in coda: lega la chiave della continuazione a questa corsa. */
  jobId?: string;
  /** Da dove riprendere, se questa e' una continuazione. null = da zero. */
  cursor?: string | null;
  /** Iniettabili per le prove. */
  budgetMs?: number;
  clock?: () => number;
  client?: ShippingFactsClient;
}

/**
 * Il lavoro della coda. Gli esiti, come nel ricalcolo:
 * - niente database, niente ordini sincronizzati, database fermo, colonna
 *   assente, collegamento revocato: si esce senza errore ('skipped').
 * - un guasto di Shopify o del database acceso: si solleva e la coda ritenta.
 *   Quel che e' gia' scritto resta, e al giro dopo non viene richiesto.
 */
export async function processShippingMethodBackfill(
  shopId: string,
  ctx: BackfillContext = {},
): Promise<RecomputeOutcome> {
  const orologio = ctx.clock ?? (() => Date.now());
  const partenza = orologio();
  const budget = ctx.budgetMs ?? BACKFILL_BUDGET_MS;

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { supabaseConfig: true },
  });
  const ref = shop?.supabaseConfig?.supabaseProjectRef;
  if (!shop || !ref) {
    console.log(`[shipping-method-backfill] negozio ${shopId} senza database collegato: niente da recuperare`);
    return 'skipped';
  }

  // La stessa porta del ricalcolo: senza ordini sincronizzati non c'e' niente
  // da completare, e un negozio disinstallato non va toccato ne' su Supabase
  // ne' su Shopify.
  const plan = await findPlanByName(shop.currentPlan);
  if (!can(shopCapabilitiesWithPlan(shop, plan), 'sync_orders')) {
    console.log(`[shipping-method-backfill] negozio ${shopId} senza sync ordini: recupero saltato`);
    return 'skipped';
  }

  if (await databaseFermo(shopId)) {
    console.warn(`[shipping-method-backfill] database del negozio ${shopId} in pausa: recupero saltato`);
    return 'skipped';
  }

  let token: string;
  try {
    token = await getValidAccessToken(shopId);
  } catch (error) {
    if (isSupabaseCredentialDead(error)) {
      console.warn(`[shipping-method-backfill] collegamento Supabase non valido per il negozio ${shopId}: recupero saltato`);
      return 'skipped';
    }
    throw error;
  }

  class Salta extends Error {}
  const suDatabase = async <T>(chiamata: () => Promise<T>): Promise<T> => {
    try {
      return await chiamata();
    } catch (error) {
      // Schema 13 o 14 non ancora applicato: la colonna arrivera', e con lei
      // (apply-schema-update) un recupero nuovo. Adesso non c'e' niente da fare.
      if (tabellaAssente(error)) {
        console.warn(`[shipping-method-backfill] colonna o tabella non pronta per il negozio ${shopId}: recupero saltato`);
        throw new Salta();
      }
      await noteDatabaseUnreachable(shopId);
      if (await databaseFermo(shopId)) {
        console.warn(`[shipping-method-backfill] database del negozio ${shopId} in pausa: recupero interrotto`);
        throw new Salta();
      }
      throw error;
    }
  };

  // Il cursore arriva dal payload della coda: lo si valida come ogni valore
  // che finisce nell'SQL. Malformato = da zero, che costa tempo ma non sbaglia:
  // gli ordini gia' valorizzati non tornano comunque nella lettura.
  let dopoId: string | null = null;
  if (ctx.cursor != null) {
    if (ID_VALIDO.test(ctx.cursor)) dopoId = ctx.cursor;
    else console.warn(`[shipping-method-backfill] cursore non valido per il negozio ${shopId}: si riparte da zero`);
  }

  // Il client di Shopify si procura solo se c'e' davvero qualcosa da chiedere:
  // la maggior parte dei negozi, dopo il primo recupero, non ha ordini NULL.
  let client: ShippingFactsClient | null = ctx.client ?? null;
  let aggiornati = 0;
  let passaggio: string | null = null;

  try {
    for (;;) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('recupero interrotto');

      const righe = await suDatabase(() =>
        runQueryRows<{ shopify_order_id: string | number }>(token, ref, backfillSelectSQL(dopoId)),
      );
      if (righe.length === 0) break;

      const ids = righe.map((r) => idSicuro(r.shopify_order_id));
      client ??= await ShopifyAPIClient.forShop(shop.shopDomain);

      const valori: BackfillValue[] = [];
      for (let i = 0; i < ids.length; i += BACKFILL_NODES_BATCH) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('recupero interrotto');
        const lotto = ids.slice(i, i + BACKFILL_NODES_BATCH);
        const fatti = await client.getOrderShippingFacts(lotto);
        // Un id che Shopify non ha restituito vale come "nessuna opzione, nessuna
        // spedizione": e' la stessa risposta di un ordine senza l'una e l'altra.
        for (const id of lotto) {
          const fatto = fatti.get(id);
          valori.push({ id, method: fatto?.method ?? '', packageCount: fatto?.packageCount ?? 0 });
        }
      }

      await ctx.lease?.assertHeld();
      await suDatabase(() => runQuery(token, ref, backfillUpdateSQL(valori)));
      aggiornati += valori.length;

      if (righe.length < BACKFILL_PAGE_SIZE) break;
      dopoId = ids[ids.length - 1];

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
    // Il ricalcolo lo accoda chi finisce, non ogni tappa: ricalcolare a meta'
    // recupero vorrebbe dire rifarlo da capo alla tappa dopo.
    await enqueueShippingMethodBackfillContinuation(shopId, ctx.jobId ?? 'senza-item', passaggio);
    console.log(
      `[shipping-method-backfill] negozio ${shopId}: ${aggiornati} ordini completati, si prosegue dopo l'ordine ${passaggio}`,
    );
    return 'continued';
  }

  // Alla fine i costi vanno rifatti con le opzioni appena scritte. Anche se
  // questa tappa non ha trovato niente, se e' una continuazione le tappe prima
  // hanno scritto. Non solleva (vedi recompute-enqueue.server).
  if (aggiornati > 0 || ctx.cursor != null) {
    await enqueueLogisticsRecompute(shopId);
  }
  console.log(`[shipping-method-backfill] negozio ${shopId}: ${aggiornati} ordini completati`);
  return 'completed';
}
