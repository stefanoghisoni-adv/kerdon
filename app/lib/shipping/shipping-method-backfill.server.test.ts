// app/lib/shipping/shipping-method-backfill.server.test.ts
//
// Il recupero dell'opzione di spedizione sugli ordini salvati prima dello
// schema 13. Senza, le opzioni importate raggiungono solo gli ordini nuovi e
// lo storico resta sulla tariffa generica della zona.

import { describe, it as prova, expect, vi, beforeEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

// La coda finta rispetta l'indice unico su `dedupKey`, come in
// recompute.server.test: e' li' che vive la deduplica.
const righeCoda = new Map<string, { id: string; status: string; dedupKey: string; payload: unknown; type: string; shopId: string }>();

vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: vi.fn() },
    syncRequest: { createMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock('~/lib/supabase-management.server', () => ({
  runQuery: vi.fn(),
  runQueryRows: vi.fn(),
  isSupabaseCredentialDead: vi.fn(() => false),
}));
vi.mock('~/lib/supabase-oauth.server', () => ({ getValidAccessToken: vi.fn() }));
vi.mock('~/lib/cache/database-pause-cache.server', () => ({ getDatabasePauseState: vi.fn() }));
vi.mock('~/lib/supabase/database-pause.server', () => ({ noteDatabaseUnreachable: vi.fn() }));
vi.mock('~/lib/billing/find-plan.server', () => ({ findPlanByName: vi.fn() }));
vi.mock('~/lib/authz/shop-capabilities.server', () => ({ shopCapabilitiesWithPlan: vi.fn(() => ({})) }));
vi.mock('~/lib/authz/capabilities', () => ({ can: vi.fn(() => true) }));
vi.mock('~/lib/queue/trigger.server', () => ({ triggerSyncDrain: vi.fn() }));
vi.mock('~/lib/shopify-api.server', () => ({ ShopifyAPIClient: { forShop: vi.fn() } }));
// Il ricalcolo e' di un altro file: qui conta solo che venga accodato alla fine.
vi.mock('./recompute-enqueue.server', () => ({
  enqueueLogisticsRecompute: vi.fn(),
  enqueueLogisticsContinuation: vi.fn(),
}));
// Il ricalcolo vero tira dentro lo schema e le tariffe: non servono qui.
vi.mock('~/lib/supabase/apply-schema-update.server', () => ({ applyMerchantSchemaUpdate: vi.fn() }));
vi.mock('./load-config.server', () => ({ loadLogisticsConfigStrict: vi.fn() }));

import { prisma } from '~/db.server';
import { runQuery, runQueryRows } from '~/lib/supabase-management.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { getDatabasePauseState } from '~/lib/cache/database-pause-cache.server';
import { can } from '~/lib/authz/capabilities';
import { triggerSyncDrain } from '~/lib/queue/trigger.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { enqueueLogisticsRecompute } from './recompute-enqueue.server';
import {
  BACKFILL_NODES_BATCH,
  BACKFILL_PAGE_SIZE,
  backfillSelectSQL,
  backfillUpdateSQL,
  processShippingMethodBackfill,
  type BackfillValue,
} from './shipping-method-backfill.server';
import { enqueueShippingMethodBackfill } from './shipping-method-backfill-enqueue.server';
import { LOGISTICS_FACTS_VERSION, ORDINE_NON_TROVATO, type OrderShippingFacts } from './order-logistics-facts';

/**
 * Un client Shopify finto: per ogni id il titolo e i pacchi scelti dalla
 * prova (titolo vuoto e zero pacchi se la prova non dice niente).
 */
function clientFinto(
  titoli: Record<string, string> = {},
  pacchi: Record<string, number> = {},
  resi: Record<string, string> = {},
  altri: Record<string, OrderShippingFacts> = {},
) {
  return {
    getOrderShippingFacts: vi.fn(
      async (ids: string[]) =>
        new Map<string, OrderShippingFacts>(
          ids.map((id) => [
            id,
            altri[id] ?? {
              found: true,
              method: titoli[id] ?? '',
              packageCount: pacchi[id] ?? 0,
              returnedAt: resi[id] ?? null,
              returnsKnown: true,
              fulfillmentStatus: 'FULFILLED',
              countryCode: 'IT',
              countryKnown: true,
            },
          ]),
        ),
    ),
  };
}

/** Un valore di riga con i fatti tutti letti. */
function fatto(id: string, method: string, packageCount: number, returnedAt: string | null = null): BackfillValue {
  return {
    id, found: true, method, packageCount, returnedAt, returnsKnown: true,
    fulfillmentStatus: 'FULFILLED', countryCode: 'IT', countryKnown: true,
  };
}

/** La coda di una tupla con i fatti tutti letti: stato, paese, versione. */
const CODA = `'FULFILLED'::text, 'IT'::text, ${LOGISTICS_FACTS_VERSION}::integer)`;
/** Nessun fatto di stato e paese letto, versione ferma. */
const IGNOTI = 'NULL::text, NULL::text, NULL::integer)';

const hex = (t: string) => Buffer.from(t, 'utf8').toString('hex');
const V = LOGISTICS_FACTS_VERSION;

function righe(ids: Array<string | number>) {
  return ids.map((id) => ({ shopify_order_id: String(id) }));
}

function scritture(): string[] {
  return (runQuery as any).mock.calls.map((c: any[]) => c[2] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  righeCoda.clear();
  (prisma.syncRequest.createMany as any).mockImplementation(async ({ data }: any) => {
    const [riga] = data;
    if (righeCoda.has(riga.dedupKey)) return { count: 0 };
    righeCoda.set(riga.dedupKey, { ...riga });
    return { count: 1 };
  });
  (prisma.syncRequest.findUnique as any).mockImplementation(async ({ where }: any) => righeCoda.get(where.dedupKey) ?? null);
  (prisma.syncRequest.findMany as any).mockImplementation(async ({ where }: any) =>
    [...righeCoda.values()].filter(
      (r) => r.shopId === where.shopId && r.type === where.type && where.status.in.includes(r.status),
    ),
  );
  (prisma.syncRequest.findFirst as any).mockImplementation(async ({ where }: any) => {
    return (
      [...righeCoda.values()].find(
        (r) => r.shopId === where.shopId && r.type === where.type && where.status.in.includes(r.status),
      ) ?? null
    );
  });
  (prisma.shop.findUnique as any).mockResolvedValue({
    id: 'shop-1',
    shopDomain: 'negozio.myshopify.com',
    currentPlan: 'growth',
    scopes: 'read_orders',
    supabaseConfig: { supabaseProjectRef: 'ref-1', connectionVerifiedAt: new Date() },
  });
  (getValidAccessToken as any).mockResolvedValue('token');
  (getDatabasePauseState as any).mockResolvedValue(null);
  (runQuery as any).mockResolvedValue(undefined);
  (runQueryRows as any).mockResolvedValue([]);
  (can as any).mockReturnValue(true);
  (enqueueLogisticsRecompute as any).mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('backfillSelectSQL', () => {
  prova('legge gli ordini senza opzione, senza pacchi ma spediti, o con fatti logistici vecchi, a pagine per id', () => {
    const sql = backfillSelectSQL(null);
    expect(sql).toContain('WHERE (shipping_method IS NULL');
    // I pacchi servono solo a chi il calcolo fa pagare la spedizione: spedito
    // (la stessa definizione di isShipped) e con un paese.
    expect(sql).toContain(
      "OR (package_count IS NULL AND UPPER(fulfillment_status) IN ('FULFILLED', 'PARTIALLY_FULFILLED') AND COALESCE(shipping_country_code, '') <> '')",
    );
    // La riderivazione: ogni ordine ricavato con regole piu' vecchie, una volta.
    expect(sql).toContain(`OR COALESCE(logistics_facts_version, 0) < ${V})`);
    expect(sql).toContain('ORDER BY shopify_order_id');
    expect(sql).toContain(`LIMIT ${BACKFILL_PAGE_SIZE}`);
    expect(backfillSelectSQL('42')).toContain('AND shopify_order_id > 42');
  });

  prova('un cursore che non e\' un id non entra nel testo', () => {
    expect(() => backfillSelectSQL('1 OR 1=1')).toThrow();
  });
});

describe('backfillUpdateSQL', () => {
  const vecchio = `COALESCE(o.logistics_facts_version, 0) < ${V}`;

  prova('ordine gia\' alla versione corrente: si riempie solo il vuoto', () => {
    const sql = backfillUpdateSQL([fatto('7', 'Express', 2)]);
    expect(sql).toContain('shipping_method = COALESCE(o.shipping_method, v.m)');
    expect(sql).toContain(`package_count = CASE WHEN ${vecchio} AND v.p IS NOT NULL THEN v.p ELSE COALESCE(o.package_count, v.pf) END`);
    expect(sql).toContain(`returned_at = CASE WHEN ${vecchio} AND v.rk THEN v.r ELSE o.returned_at END`);
    // Stato e paese: lo stato si rifa' sui vecchi se letto; il paese riempie
    // solo il vuoto (un ordine nuovo scritto con l'indirizzo oscurato).
    expect(sql).toContain(
      `fulfillment_status = CASE WHEN ${vecchio} AND v.fs IS NOT NULL THEN v.fs ELSE COALESCE(o.fulfillment_status, v.fs) END`,
    );
    expect(sql).toContain('shipping_country_code = COALESCE(o.shipping_country_code, v.cc)');
    expect(sql).toContain('AS v(id, m, p, pf, r, rk, fs, cc, ver)');
    expect(sql).toContain(
      `logistics_facts_version = CASE WHEN ${vecchio} AND v.ver IS NOT NULL THEN v.ver ELSE o.logistics_facts_version END`,
    );
    expect(sql).toContain(`AND (o.shipping_method IS NULL OR o.package_count IS NULL OR ${vecchio})`);
  });

  prova('fatti noti: pacchi, reso e versione entrano come letterali verificati', () => {
    const sql = backfillUpdateSQL([fatto('7', 'Express', 3, '2026-08-05T10:00:00Z')]);
    expect(sql).toContain(
      `(7::bigint, convert_from(decode('${hex('Express')}', 'hex'), 'UTF8'), 3::integer, 3::integer, '2026-08-05T10:00:00Z'::timestamp, true, ${CODA}`,
    );
  });

  prova('nessun reso qualificante: la data si toglie (NULL letto, rk vero)', () => {
    const sql = backfillUpdateSQL([fatto('7', 'Express', 1, null)]);
    expect(sql).toContain(`1::integer, 1::integer, NULL::timestamp, true, ${CODA}`);
  });

  prova('campi oscurati: NULL e rk falso, la versione non sale, niente sovrascritto', () => {
    const sql = backfillUpdateSQL([
      { id: '7', found: true, method: null, packageCount: null, returnedAt: null, returnsKnown: false, fulfillmentStatus: null, countryCode: null, countryKnown: false },
    ]);
    expect(sql).toContain(`(7::bigint, NULL::text, NULL::integer, NULL::integer, NULL::timestamp, false, ${IGNOTI}`);
  });

  prova('solo il reso oscurato: pacchi scritti, reso intatto, versione ferma', () => {
    const sql = backfillUpdateSQL([
      { ...fatto('7', 'Std', 2), returnsKnown: false },
    ]);
    expect(sql).toContain(`2::integer, 2::integer, NULL::timestamp, false, 'FULFILLED'::text, 'IT'::text, NULL::integer)`);
  });

  prova('ordine sparito da Shopify: sentinelle solo nei vuoti, nessun valore toccato, versione su', () => {
    const sql = backfillUpdateSQL([{ id: '7', ...ORDINE_NON_TROVATO }]);
    expect(sql).toContain(`(7::bigint, convert_from(decode('', 'hex'), 'UTF8'), NULL::integer, 0::integer, NULL::timestamp, false, NULL::text, NULL::text, ${V}::integer)`);
  });

  prova('paese oscurato: non si scrive e la versione resta ferma, cosi\' l ordine torna nella lettura', () => {
    const sql = backfillUpdateSQL([{ ...fatto('7', 'Std', 1), countryCode: null, countryKnown: false }]);
    expect(sql).toContain(`1::integer, 1::integer, NULL::timestamp, true, 'FULFILLED'::text, NULL::text, NULL::integer)`);
  });

  prova('stato di evasione non letto: NULL, versione ferma', () => {
    const sql = backfillUpdateSQL([{ ...fatto('7', 'Std', 1), fulfillmentStatus: null }]);
    expect(sql).toContain(`NULL::timestamp, true, NULL::text, 'IT'::text, NULL::integer)`);
  });

  prova('stato e paese che non hanno la forma di Shopify non entrano nel testo', () => {
    const sql = backfillUpdateSQL([
      { ...fatto('7', 'Std', 1), fulfillmentStatus: "X'; DROP TABLE orders; --", countryCode: "I'T" },
    ]);
    expect(sql).not.toContain('DROP');
    expect(sql).toContain('NULL::text, NULL::text');
  });

  prova('un numero di pacchi che non e\' un intero non negativo non entra nel testo', () => {
    expect(() => backfillUpdateSQL([fatto('7', 'x', -1)])).toThrow();
    expect(() => backfillUpdateSQL([fatto('7', 'x', 1.5)])).toThrow();
    expect(() => backfillUpdateSQL([fatto('7', 'x', Number.NaN)])).toThrow();
  });

  prova('una data del reso che non e\' un istante ISO non entra nel testo', () => {
    expect(() => backfillUpdateSQL([fatto('7', 'x', 1, "2026-01-01'); DROP TABLE orders; --")])).toThrow();
  });

  prova('i titoli arrivano come esadecimale: nessun carattere di Shopify finisce nel testo SQL', () => {
    const ostile = "x'); DROP TABLE orders; --";
    const sql = backfillUpdateSQL([fatto('7', ostile, 0)]);
    expect(sql).not.toContain('DROP');
    expect(sql).toContain(`(7::bigint, convert_from(decode('${hex(ostile)}', 'hex'), 'UTF8'), 0::integer`);
  });

  prova('la sentinella vuota e\' una stringa vuota, non NULL', () => {
    expect(backfillUpdateSQL([fatto('7', '', 0)])).toContain("(7::bigint, convert_from(decode('', 'hex'), 'UTF8'), 0::integer");
  });

  prova('un carattere NUL (che Postgres rifiuta nel testo) viene tolto', () => {
    const sql = backfillUpdateSQL([fatto('7', 'A\u0000B', 0)]);
    expect(sql).toContain(`decode('${hex('AB')}', 'hex')`);
  });

  prova('rifiuta un id che non e\' un intero', () => {
    expect(() => backfillUpdateSQL([fatto('1; DROP TABLE orders', 'x', 0)])).toThrow();
  });
});

describe('processShippingMethodBackfill', () => {
  prova('chiede a Shopify a lotti, scrive titoli e sentinelle, poi accoda il ricalcolo', async () => {
    const ids = Array.from({ length: BACKFILL_NODES_BATCH + 3 }, (_, i) => String(1000 + i));
    (runQueryRows as any).mockResolvedValueOnce(righe(ids));
    const client = clientFinto({ '1000': 'Express', '1001': 'Standard' }, { '1000': 2, '1001': 1 });

    await expect(processShippingMethodBackfill('shop-1', { client })).resolves.toBe('completed');

    // Due lotti: il primo pieno, il secondo con il resto. Mai oltre il tetto.
    expect(client.getOrderShippingFacts).toHaveBeenCalledTimes(2);
    for (const [lotto] of client.getOrderShippingFacts.mock.calls) {
      expect(lotto.length).toBeLessThanOrEqual(BACKFILL_NODES_BATCH);
    }
    expect(client.getOrderShippingFacts.mock.calls[0][0]).toEqual(ids.slice(0, BACKFILL_NODES_BATCH));

    // Una scrittura per pagina, con dentro ogni ordine della pagina.
    expect(scritture()).toHaveLength(1);
    const sql = scritture()[0];
    expect(sql).toContain(`(1000::bigint, convert_from(decode('${hex('Express')}', 'hex'), 'UTF8'), 2::integer, 2::integer`);
    // Nessuna shipping line: la sentinella, cosi' non lo si richiede per sempre.
    // Nessuna spedizione: zero pacchi, che toglie l'ordine dalla lettura dopo.
    expect(sql).toContain("(1002::bigint, convert_from(decode('', 'hex'), 'UTF8'), 0::integer, 0::integer");

    expect(enqueueLogisticsRecompute).toHaveBeenCalledWith('shop-1');
  });

  prova('riderivazione: pacchi dai tracking, reso tolto se non qualifica piu\', campi oscurati intatti, poi il ricalcolo', async () => {
    (runQueryRows as any).mockResolvedValueOnce(righe(['1', '2', '3', '4']));
    const client = clientFinto(
      { '1': 'Express', '2': 'Std' },
      // 1: tre tracking su una spedizione -> 3 pacchi (prima era 1).
      { '1': 3, '2': 1 },
      // 1 ha un reso OPEN/CLOSED; 2 ne aveva uno OPEN poi annullato: nessuno.
      { '1': '2026-08-05T10:00:00Z' },
      {
        // 3: resi e spedizioni oscurati. 4: sparito da Shopify.
        '3': { found: true, method: 'Std', packageCount: null, returnedAt: null, returnsKnown: false, fulfillmentStatus: null, countryCode: null, countryKnown: false },
        '4': ORDINE_NON_TROVATO,
      },
    );

    await expect(processShippingMethodBackfill('shop-1', { client })).resolves.toBe('completed');

    const sql = scritture()[0];
    expect(sql).toContain(`(1::bigint, convert_from(decode('${hex('Express')}', 'hex'), 'UTF8'), 3::integer, 3::integer, '2026-08-05T10:00:00Z'::timestamp, true, ${CODA}`);
    expect(sql).toContain(`(2::bigint, convert_from(decode('${hex('Std')}', 'hex'), 'UTF8'), 1::integer, 1::integer, NULL::timestamp, true, ${CODA}`);
    expect(sql).toContain(`(3::bigint, convert_from(decode('${hex('Std')}', 'hex'), 'UTF8'), NULL::integer, NULL::integer, NULL::timestamp, false, ${IGNOTI}`);
    expect(sql).toContain(`(4::bigint, convert_from(decode('', 'hex'), 'UTF8'), NULL::integer, 0::integer, NULL::timestamp, false, NULL::text, NULL::text, ${V}::integer)`);
    expect(enqueueLogisticsRecompute).toHaveBeenCalledWith('shop-1');
  });

  prova('query troppo cara (MAX_COST_EXCEEDED): il lotto si dimezza e si riprova, fino a uno', async () => {
    const ids = Array.from({ length: BACKFILL_NODES_BATCH }, (_, i) => String(100 + i));
    (runQueryRows as any).mockResolvedValueOnce(righe(ids));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const base = clientFinto();
    const troppoCara = Object.assign(new Error('Shopify API error: [{"message":"Query cost is 1600, which exceeds the single query max cost limit (1000).","extensions":{"code":"MAX_COST_EXCEEDED","cost":1600,"maxCost":1000}}]'), {
      graphqlCode: 'MAX_COST_EXCEEDED',
    });
    // Oltre 10 id la query costa troppo.
    const client = {
      getOrderShippingFacts: vi.fn(async (lotto: string[]) => {
        if (lotto.length > 10) throw troppoCara;
        return base.getOrderShippingFacts(lotto);
      }),
    };

    await expect(processShippingMethodBackfill('shop-1', { client })).resolves.toBe('completed');

    const dimensioni = client.getOrderShippingFacts.mock.calls.map(([l]) => l.length);
    // 25 -> 12 -> 6, poi il lotto resta a 6 per il resto della corsa.
    expect(dimensioni.slice(0, 3)).toEqual([BACKFILL_NODES_BATCH, 12, 6]);
    expect(dimensioni.slice(3).every((n) => n <= 6)).toBe(true);
    // Tutti gli ordini scritti, nessuno perso.
    for (const id of ids) expect(scritture()[0]).toContain(`(${id}::bigint`);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('costo richiesto 1600'));
  });

  prova('MAX_COST_EXCEEDED anche con un ordine solo: si solleva, la coda ritenta', async () => {
    (runQueryRows as any).mockResolvedValueOnce(righe(['1']));
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = {
      getOrderShippingFacts: vi.fn().mockRejectedValue(Object.assign(new Error('MAX_COST_EXCEEDED'), { graphqlCode: 'MAX_COST_EXCEEDED' })),
    };
    await expect(processShippingMethodBackfill('shop-1', { client })).rejects.toThrow('MAX_COST_EXCEEDED');
    expect(client.getOrderShippingFacts).toHaveBeenCalledTimes(1);
    expect(runQuery).not.toHaveBeenCalled();
  });

  prova('un id che Shopify non restituisce vale come ordine sparito, non come zero pacchi', async () => {
    (runQueryRows as any).mockResolvedValueOnce(righe(['9']));
    const client = { getOrderShippingFacts: vi.fn(async () => new Map<string, OrderShippingFacts>()) };

    await processShippingMethodBackfill('shop-1', { client });

    expect(scritture()[0]).toContain(`(9::bigint, convert_from(decode('', 'hex'), 'UTF8'), NULL::integer, 0::integer, NULL::timestamp, false, NULL::text, NULL::text, ${V}::integer)`);
  });

  prova('colonna logistics_facts_version assente (schema 15 non applicato): esce in silenzio', async () => {
    (runQueryRows as any).mockRejectedValueOnce(new Error('ERROR: 42703: column "logistics_facts_version" does not exist'));
    const client = clientFinto();

    await expect(processShippingMethodBackfill('shop-1', { client })).resolves.toBe('skipped');
    expect(client.getOrderShippingFacts).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  prova('niente da recuperare: nessuna chiamata a Shopify, nessuna scrittura, nessun ricalcolo', async () => {
    const client = clientFinto();

    await expect(processShippingMethodBackfill('shop-1', { client })).resolves.toBe('completed');

    expect(client.getOrderShippingFacts).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
    expect(enqueueLogisticsRecompute).not.toHaveBeenCalled();
  });

  prova('usa il client del negozio fuori da una richiesta quando non gliene passano uno', async () => {
    const client = clientFinto();
    (ShopifyAPIClient.forShop as any).mockResolvedValue(client);
    (runQueryRows as any).mockResolvedValueOnce(righe(['5']));

    await processShippingMethodBackfill('shop-1');

    expect(ShopifyAPIClient.forShop).toHaveBeenCalledWith('negozio.myshopify.com');
    expect(client.getOrderShippingFacts).toHaveBeenCalledWith(['5']);
  });

  prova('pagina piena: riparte dall ultimo id visto', async () => {
    const piena = Array.from({ length: BACKFILL_PAGE_SIZE }, (_, i) => String(1 + i));
    (runQueryRows as any).mockResolvedValueOnce(righe(piena)).mockResolvedValueOnce(righe(['99999']));

    await processShippingMethodBackfill('shop-1', { client: clientFinto() });

    expect(runQueryRows).toHaveBeenCalledTimes(2);
    expect((runQueryRows as any).mock.calls[1][2]).toContain(`AND shopify_order_id > ${BACKFILL_PAGE_SIZE}`);
    expect(scritture()).toHaveLength(2);
  });

  prova('budget esaurito: continuazione dal cursore, e il ricalcolo lo accoda chi finisce', async () => {
    const piena = Array.from({ length: BACKFILL_PAGE_SIZE }, (_, i) => String(1 + i));
    (runQueryRows as any).mockResolvedValueOnce(righe(piena));
    const istanti = [0, 5_000];

    await expect(
      processShippingMethodBackfill('shop-1', {
        client: clientFinto(),
        jobId: 'job-1',
        budgetMs: 1_000,
        clock: () => istanti.shift() ?? 5_000,
      }),
    ).resolves.toBe('continued');

    expect(runQueryRows).toHaveBeenCalledTimes(1);
    const continuazione = [...righeCoda.values()].find((r) => r.dedupKey.includes(':continua:'));
    expect(continuazione?.type).toBe('shipping-method-backfill');
    expect(continuazione?.payload).toEqual({ cursor: String(BACKFILL_PAGE_SIZE) });
    expect(continuazione?.dedupKey).toBe(`shipping-method-backfill:shop-1:continua:job-1:${BACKFILL_PAGE_SIZE}`);
    expect(triggerSyncDrain).toHaveBeenCalledWith('shop-1');
    expect(enqueueLogisticsRecompute).not.toHaveBeenCalled();

    // La continuazione riparte dal cursore e, finendo, accoda il ricalcolo
    // anche se la sua tappa non ha trovato niente: le tappe prima avevano scritto.
    vi.clearAllMocks();
    (runQueryRows as any).mockResolvedValue([]);
    await processShippingMethodBackfill('shop-1', { client: clientFinto(), cursor: String(BACKFILL_PAGE_SIZE) });
    expect((runQueryRows as any).mock.calls[0][2]).toContain(`AND shopify_order_id > ${BACKFILL_PAGE_SIZE}`);
    expect(enqueueLogisticsRecompute).toHaveBeenCalledWith('shop-1');
  });

  prova('un cursore malformato riparte da zero invece di finire nell SQL', async () => {
    await processShippingMethodBackfill('shop-1', { client: clientFinto(), cursor: '1 OR 1=1' });
    expect((runQueryRows as any).mock.calls[0][2]).not.toContain('OR 1=1');
  });

  prova('database in pausa: esce in silenzio senza chiedere niente a Shopify', async () => {
    (getDatabasePauseState as any).mockResolvedValue({
      status: 'INACTIVE',
      availability: 'in-pausa',
      checkedAt: new Date().toISOString(),
      resumeRequestedAt: null,
      resumeBlocked: null,
    });
    const client = clientFinto();

    await expect(processShippingMethodBackfill('shop-1', { client })).resolves.toBe('skipped');
    expect(runQueryRows).not.toHaveBeenCalled();
    expect(client.getOrderShippingFacts).not.toHaveBeenCalled();
  });

  prova('colonna shipping_method assente (schema 13 non applicato): esce in silenzio', async () => {
    (runQueryRows as any).mockRejectedValueOnce(new Error('column "shipping_method" does not exist'));
    const client = clientFinto();

    await expect(processShippingMethodBackfill('shop-1', { client })).resolves.toBe('skipped');
    expect(client.getOrderShippingFacts).not.toHaveBeenCalled();
    expect(enqueueLogisticsRecompute).not.toHaveBeenCalled();
  });

  prova('colonna package_count assente (schema 14 non applicato): esce in silenzio', async () => {
    (runQueryRows as any).mockRejectedValueOnce(new Error('ERROR: 42703: column "package_count" does not exist'));
    const client = clientFinto();

    await expect(processShippingMethodBackfill('shop-1', { client })).resolves.toBe('skipped');
    expect(client.getOrderShippingFacts).not.toHaveBeenCalled();
  });

  prova('negozio senza ordini sincronizzati o senza database: non fa niente', async () => {
    (can as any).mockReturnValueOnce(false);
    await expect(processShippingMethodBackfill('shop-1', { client: clientFinto() })).resolves.toBe('skipped');

    (prisma.shop.findUnique as any).mockResolvedValueOnce({ id: 'shop-1', supabaseConfig: null });
    await expect(processShippingMethodBackfill('shop-1', { client: clientFinto() })).resolves.toBe('skipped');
    expect(runQueryRows).not.toHaveBeenCalled();
  });

  prova('un guasto di Shopify si propaga: la coda ritenta, e quel che era scritto resta', async () => {
    (runQueryRows as any).mockResolvedValueOnce(righe(['1']));
    const client = { getOrderShippingFacts: vi.fn().mockRejectedValue(new Error('THROTTLED')) };

    await expect(processShippingMethodBackfill('shop-1', { client })).rejects.toThrow('THROTTLED');
    expect(runQuery).not.toHaveBeenCalled();
  });

  prova('riverifica il possesso del negozio prima di scrivere', async () => {
    (runQueryRows as any).mockResolvedValueOnce(righe(['1']));
    const lease = { assertHeld: vi.fn().mockRejectedValue(new Error('lucchetto perso')) };

    await expect(processShippingMethodBackfill('shop-1', { client: clientFinto(), lease })).rejects.toThrow(
      'lucchetto perso',
    );
    expect(runQuery).not.toHaveBeenCalled();
  });
});

describe('enqueueShippingMethodBackfill', () => {
  prova('accoda il recupero e sveglia la coda', async () => {
    await enqueueShippingMethodBackfill('shop-1');
    const accodati = [...righeCoda.values()].filter((r) => r.type === 'shipping-method-backfill');
    expect(accodati).toHaveLength(1);
    expect(triggerSyncDrain).toHaveBeenCalledWith('shop-1');
  });

  prova('deduplicato per negozio: se uno e\' gia\' in coda o in corso non se ne aggiunge un altro', async () => {
    await enqueueShippingMethodBackfill('shop-1');
    await enqueueShippingMethodBackfill('shop-1');
    expect([...righeCoda.values()].filter((r) => r.type === 'shipping-method-backfill')).toHaveLength(1);

    // Anche fuori dalla finestra del minuto, finche' il primo non e' finito.
    for (const r of righeCoda.values()) r.status = 'processing';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 10 * 60_000));
    await enqueueShippingMethodBackfill('shop-1');
    vi.useRealTimers();
    expect([...righeCoda.values()].filter((r) => r.type === 'shipping-method-backfill')).toHaveLength(1);
  });

  prova('negozi diversi non si deduplicano fra loro', async () => {
    await enqueueShippingMethodBackfill('shop-1');
    await enqueueShippingMethodBackfill('shop-2');
    expect([...righeCoda.values()].filter((r) => r.type === 'shipping-method-backfill')).toHaveLength(2);
  });

  prova('v14 durante un recupero in corso: un solo seguito, da zero', async () => {
    // Il recupero della 13 e' partito e avanza dal suo cursore: gli ordini che
    // ha gia' passato non tornano nella sua lettura, e resterebbero senza pacchi.
    await enqueueShippingMethodBackfill('shop-1');
    for (const r of righeCoda.values()) r.status = 'processing';

    await enqueueShippingMethodBackfill('shop-1', { restartIfRunning: true });
    await enqueueShippingMethodBackfill('shop-1', { restartIfRunning: true });

    const accodati = [...righeCoda.values()].filter((r) => r.type === 'shipping-method-backfill');
    expect(accodati).toHaveLength(2);
    const seguito = accodati.find((r) => r.status === 'queued')!;
    // Senza cursore: riparte dal primo ordine.
    expect((seguito.payload as { cursor?: string } | null)?.cursor).toBeUndefined();
    expect(seguito.dedupKey).toContain(':da-capo:');
  });

  prova('v14 con una continuazione ancora in coda: anche li\' un seguito da zero', async () => {
    righeCoda.set('k', {
      id: 'job-c', status: 'queued', dedupKey: 'k', payload: { cursor: '500' },
      type: 'shipping-method-backfill', shopId: 'shop-1',
    });

    await enqueueShippingMethodBackfill('shop-1', { restartIfRunning: true });

    const daZero = [...righeCoda.values()].filter((r) => r.type === 'shipping-method-backfill' && (r.payload as { cursor?: string } | null)?.cursor === undefined);
    expect(daZero).toHaveLength(1);
  });

  prova('v14 con un recupero da zero ancora in coda: basta lui', async () => {
    await enqueueShippingMethodBackfill('shop-1');
    await enqueueShippingMethodBackfill('shop-1', { restartIfRunning: true });
    expect([...righeCoda.values()].filter((r) => r.type === 'shipping-method-backfill')).toHaveLength(1);
  });

  prova('un guasto della coda non solleva: chi chiama ha gia\' salvato', async () => {
    (prisma.syncRequest.findFirst as any).mockRejectedValueOnce(new Error('owner db giu\''));
    await expect(enqueueShippingMethodBackfill('shop-1')).resolves.toBeUndefined();
  });
});
