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
    syncRequest: { createMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
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
} from './shipping-method-backfill.server';
import { enqueueShippingMethodBackfill } from './shipping-method-backfill-enqueue.server';

/** Un client Shopify finto: per ogni id il titolo scelto dalla prova. */
function clientFinto(titoli: Record<string, string> = {}) {
  return {
    getOrderShippingTitles: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, titoli[id] ?? '']))),
  };
}

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
    currentPlan: 'pro',
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
  prova('legge solo gli ordini senza opzione, a pagine per id', () => {
    const sql = backfillSelectSQL(null);
    expect(sql).toContain('WHERE shipping_method IS NULL');
    expect(sql).toContain('ORDER BY shopify_order_id');
    expect(sql).toContain(`LIMIT ${BACKFILL_PAGE_SIZE}`);
    expect(backfillSelectSQL('42')).toContain('AND shopify_order_id > 42');
  });

  prova('un cursore che non e\' un id non entra nel testo', () => {
    expect(() => backfillSelectSQL('1 OR 1=1')).toThrow();
  });
});

describe('backfillUpdateSQL', () => {
  prova('non sovrascrive mai un valore gia\' scritto', () => {
    const sql = backfillUpdateSQL([{ id: '7', method: 'Express' }]);
    expect(sql).toContain('AND o.shipping_method IS NULL');
  });

  prova('i titoli arrivano come esadecimale: nessun carattere di Shopify finisce nel testo SQL', () => {
    const ostile = "x'); DROP TABLE orders; --";
    const sql = backfillUpdateSQL([{ id: '7', method: ostile }]);
    expect(sql).not.toContain('DROP');
    const hex = Buffer.from(ostile, 'utf8').toString('hex');
    expect(sql).toContain(`(7::bigint, convert_from(decode('${hex}', 'hex'), 'UTF8'))`);
  });

  prova('la sentinella vuota e\' una stringa vuota, non NULL', () => {
    expect(backfillUpdateSQL([{ id: '7', method: '' }])).toContain("(7::bigint, convert_from(decode('', 'hex'), 'UTF8'))");
  });

  prova('un carattere NUL (che Postgres rifiuta nel testo) viene tolto', () => {
    const sql = backfillUpdateSQL([{ id: '7', method: 'A\u0000B' }]);
    expect(sql).toContain(`decode('${Buffer.from('AB').toString('hex')}', 'hex')`);
  });

  prova('rifiuta un id che non e\' un intero', () => {
    expect(() => backfillUpdateSQL([{ id: '1; DROP TABLE orders', method: 'x' }])).toThrow();
  });
});

describe('processShippingMethodBackfill', () => {
  prova('chiede a Shopify a lotti, scrive titoli e sentinelle, poi accoda il ricalcolo', async () => {
    const ids = Array.from({ length: BACKFILL_NODES_BATCH + 3 }, (_, i) => String(1000 + i));
    (runQueryRows as any).mockResolvedValueOnce(righe(ids));
    const client = clientFinto({ '1000': 'Express', '1001': 'Standard' });

    await expect(processShippingMethodBackfill('shop-1', { client })).resolves.toBe('completed');

    // Due lotti: il primo pieno, il secondo con il resto. Mai oltre il tetto.
    expect(client.getOrderShippingTitles).toHaveBeenCalledTimes(2);
    for (const [lotto] of client.getOrderShippingTitles.mock.calls) {
      expect(lotto.length).toBeLessThanOrEqual(BACKFILL_NODES_BATCH);
    }
    expect(client.getOrderShippingTitles.mock.calls[0][0]).toEqual(ids.slice(0, BACKFILL_NODES_BATCH));

    // Una scrittura per pagina, con dentro ogni ordine della pagina.
    expect(scritture()).toHaveLength(1);
    const sql = scritture()[0];
    expect(sql).toContain(`(1000::bigint, convert_from(decode('${Buffer.from('Express').toString('hex')}', 'hex'), 'UTF8'))`);
    // Nessuna shipping line: la sentinella, cosi' non lo si richiede per sempre.
    expect(sql).toContain("(1002::bigint, convert_from(decode('', 'hex'), 'UTF8'))");
    expect(sql).toContain('AND o.shipping_method IS NULL');

    expect(enqueueLogisticsRecompute).toHaveBeenCalledWith('shop-1');
  });

  prova('niente da recuperare: nessuna chiamata a Shopify, nessuna scrittura, nessun ricalcolo', async () => {
    const client = clientFinto();

    await expect(processShippingMethodBackfill('shop-1', { client })).resolves.toBe('completed');

    expect(client.getOrderShippingTitles).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
    expect(enqueueLogisticsRecompute).not.toHaveBeenCalled();
  });

  prova('usa il client del negozio fuori da una richiesta quando non gliene passano uno', async () => {
    const client = clientFinto();
    (ShopifyAPIClient.forShop as any).mockResolvedValue(client);
    (runQueryRows as any).mockResolvedValueOnce(righe(['5']));

    await processShippingMethodBackfill('shop-1');

    expect(ShopifyAPIClient.forShop).toHaveBeenCalledWith('negozio.myshopify.com');
    expect(client.getOrderShippingTitles).toHaveBeenCalledWith(['5']);
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
    expect(client.getOrderShippingTitles).not.toHaveBeenCalled();
  });

  prova('colonna shipping_method assente (schema 13 non applicato): esce in silenzio', async () => {
    (runQueryRows as any).mockRejectedValueOnce(new Error('column "shipping_method" does not exist'));
    const client = clientFinto();

    await expect(processShippingMethodBackfill('shop-1', { client })).resolves.toBe('skipped');
    expect(client.getOrderShippingTitles).not.toHaveBeenCalled();
    expect(enqueueLogisticsRecompute).not.toHaveBeenCalled();
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
    const client = { getOrderShippingTitles: vi.fn().mockRejectedValue(new Error('THROTTLED')) };

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

  prova('un guasto della coda non solleva: chi chiama ha gia\' salvato', async () => {
    (prisma.syncRequest.findFirst as any).mockRejectedValueOnce(new Error('owner db giu\''));
    await expect(enqueueShippingMethodBackfill('shop-1')).resolves.toBeUndefined();
  });
});
