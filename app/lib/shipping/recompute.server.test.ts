import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LogisticsConfig } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

// La coda vera (queue-store) gira sopra un Prisma finto che rispetta l'indice
// unico su `dedupKey`: e' quell'indice a fare la deduplica, quindi e' lui che
// va imitato, non la funzione di accodamento.
const righeCoda = new Map<
  string,
  { id: string; status: string; dedupKey: string; payload: unknown }
>();

async function createManyInMemoria({ data }: any) {
  const [riga] = data;
  if (righeCoda.has(riga.dedupKey)) return { count: 0 };
  righeCoda.set(riga.dedupKey, {
    id: riga.id,
    status: riga.status,
    dedupKey: riga.dedupKey,
    payload: riga.payload,
  });
  return { count: 1 };
}

async function findUniqueInMemoria({ where }: any) {
  return righeCoda.get(where.dedupKey) ?? null;
}

vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: vi.fn() },
    syncRequest: { createMany: vi.fn(), findUnique: vi.fn() },
  },
}));

vi.mock('~/lib/supabase-management.server', () => ({
  runQuery: vi.fn(),
  runQueryRows: vi.fn(),
  isSupabaseCredentialDead: vi.fn(() => false),
}));
vi.mock('~/lib/supabase-oauth.server', () => ({ getValidAccessToken: vi.fn() }));
vi.mock('./load-config.server', () => ({ loadLogisticsConfigStrict: vi.fn() }));
vi.mock('~/lib/supabase/apply-schema-update.server', () => ({
  applyMerchantSchemaUpdate: vi.fn(),
}));
vi.mock('~/lib/cache/database-pause-cache.server', () => ({ getDatabasePauseState: vi.fn() }));
vi.mock('~/lib/supabase/database-pause.server', () => ({ noteDatabaseUnreachable: vi.fn() }));
vi.mock('~/lib/billing/find-plan.server', () => ({ findPlanByName: vi.fn() }));
vi.mock('~/lib/authz/shop-capabilities.server', () => ({ shopCapabilitiesWithPlan: vi.fn(() => ({})) }));
vi.mock('~/lib/authz/capabilities', () => ({ can: vi.fn(() => true) }));
vi.mock('~/lib/queue/trigger.server', () => ({ triggerSyncDrain: vi.fn() }));

import { prisma } from '~/db.server';
import { runQuery, runQueryRows } from '~/lib/supabase-management.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { loadLogisticsConfigStrict } from './load-config.server';
import { getDatabasePauseState } from '~/lib/cache/database-pause-cache.server';
import { noteDatabaseUnreachable } from '~/lib/supabase/database-pause.server';
import { can } from '~/lib/authz/capabilities';
import { triggerSyncDrain } from '~/lib/queue/trigger.server';
import {
  RECOMPUTE_PAGE_SIZE,
  enqueueLogisticsRecompute,
  processLogisticsRecompute,
  recomputeUpdateSQL,
} from './recompute.server';

const CONFIG: LogisticsConfig = {
  zones: [
    {
      zoneName: 'Italia',
      countries: ['IT'],
      restOfWorld: false,
      rateType: 'linear',
      rates: [{ weightFromKg: null, weightToKg: null, cost: 5 }],
      options: [],
    },
  ],
  categories: [{ name: 'scatola', cost: 1 }],
  fallbackRules: [],
  defaultWeightPerItemKg: null,
  returnCost: 3,
};

function ordine(over: Record<string, unknown>) {
  return {
    shopify_order_id: '1001',
    fulfillment_status: 'FULFILLED',
    shipping_country_code: 'IT',
    total_weight_grams: 1000,
    item_count: 1,
    returned_at: null,
    packaging_category: null,
    shipping_method: null,
    total_price: null,
    ...over,
  };
}

/** Le istruzioni di scrittura mandate al database del merchant. */
function scritture(): string[] {
  return (runQuery as any).mock.calls.map((c: any[]) => c[2] as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  righeCoda.clear();
  // Ripristinate a ogni prova: `clearAllMocks` non toglie le implementazioni
  // che una prova ha cambiato, e la coda finta deve ripartire identica.
  (prisma.syncRequest.createMany as any).mockImplementation(createManyInMemoria);
  (prisma.syncRequest.findUnique as any).mockImplementation(findUniqueInMemoria);
  (prisma.shop.findUnique as any).mockResolvedValue({
    id: 'shop-1',
    currentPlan: 'pro',
    scopes: 'read_orders',
    supabaseConfig: { supabaseProjectRef: 'ref-1', connectionVerifiedAt: new Date() },
  });
  (getValidAccessToken as any).mockResolvedValue('token');
  (loadLogisticsConfigStrict as any).mockResolvedValue(CONFIG);
  (getDatabasePauseState as any).mockResolvedValue(null);
  (runQuery as any).mockResolvedValue(undefined);
  (runQueryRows as any).mockResolvedValue([]);
  (can as any).mockReturnValue(true);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('processLogisticsRecompute', () => {
  it('una pagina di 3 ordini diventa una sola scrittura con i 3 costi giusti', async () => {
    (runQueryRows as any).mockResolvedValueOnce([
      // Spedito in Italia, 2 kg a 5 €/kg + scatola da 1 € = 11
      ordine({ shopify_order_id: '1001', total_weight_grams: 2000, packaging_category: 'scatola' }),
      // Mai partito: nessun costo
      ordine({ shopify_order_id: '1002', fulfillment_status: null }),
      // Spedito, 1 kg = 5, rientrato = +3 → 8
      ordine({ shopify_order_id: '1003', returned_at: '2026-09-01T00:00:00Z' }),
    ]);

    await processLogisticsRecompute('shop-1');

    expect(scritture()).toHaveLength(1);
    const sql = scritture()[0];
    expect(sql).toContain('(1001::bigint, 11.00::numeric)');
    expect(sql).toContain('(1002::bigint, 0.00::numeric)');
    expect(sql).toContain('(1003::bigint, 8.00::numeric)');
    // Pagina corta: e' l'ultima, non si chiede una seconda pagina.
    expect(runQueryRows).toHaveBeenCalledTimes(1);
  });

  it('pagina per shopify_order_id ripartendo dall\'ultimo visto', async () => {
    const piena = Array.from({ length: RECOMPUTE_PAGE_SIZE }, (_, i) =>
      ordine({ shopify_order_id: String(5000 + i) }),
    );
    (runQueryRows as any)
      .mockResolvedValueOnce(piena)
      .mockResolvedValueOnce([ordine({ shopify_order_id: '9000' })]);

    await processLogisticsRecompute('shop-1');

    expect(runQueryRows).toHaveBeenCalledTimes(2);
    const seconda = (runQueryRows as any).mock.calls[1][2] as string;
    expect(seconda).toContain(`shopify_order_id > ${5000 + RECOMPUTE_PAGE_SIZE - 1}`);
    expect(seconda).toContain(`LIMIT ${RECOMPUTE_PAGE_SIZE}`);
    expect(scritture()).toHaveLength(2);
  });

  it('senza configurazione scrive zero su tutti: il costo vecchio non vale piu\'', async () => {
    (loadLogisticsConfigStrict as any).mockResolvedValue(null);
    (runQueryRows as any).mockResolvedValueOnce([
      ordine({ shopify_order_id: '1001', total_weight_grams: 2000 }),
    ]);

    await processLogisticsRecompute('shop-1');

    expect(scritture()).toHaveLength(1);
    expect(scritture()[0]).toContain('(1001::bigint, 0.00::numeric)');
  });

  it('se le tariffe non si leggono non scrive niente e lascia ritentare la coda', async () => {
    (loadLogisticsConfigStrict as any).mockRejectedValue(new Error('connection reset'));
    (runQueryRows as any).mockResolvedValue([ordine({})]);

    await expect(processLogisticsRecompute('shop-1')).rejects.toThrow();

    expect(runQuery).not.toHaveBeenCalled();
    expect(runQueryRows).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('tabella orders assente: nessuna eccezione e nessuna scrittura', async () => {
    (runQueryRows as any).mockRejectedValue(
      new Error('Supabase query error: 400 — relation "orders" does not exist'),
    );

    await expect(processLogisticsRecompute('shop-1')).resolves.toBeUndefined();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('colonna logistics_cost non ancora creata: nessuna eccezione', async () => {
    (runQueryRows as any).mockResolvedValueOnce([ordine({})]);
    (runQuery as any).mockRejectedValue(
      new Error('Supabase query error: 400 — column "logistics_cost" of relation "orders" does not exist'),
    );

    await expect(processLogisticsRecompute('shop-1')).resolves.toBeUndefined();
  });

  it('database in pausa gia\' noto: si ferma prima di chiedere qualunque cosa', async () => {
    (getDatabasePauseState as any).mockResolvedValue({
      status: 'INACTIVE',
      availability: 'in-pausa',
      checkedAt: new Date().toISOString(),
      resumeRequestedAt: null,
      resumeBlocked: null,
    });

    await expect(processLogisticsRecompute('shop-1')).resolves.toBeUndefined();
    expect(runQueryRows).not.toHaveBeenCalled();
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('database che risulta in pausa solo al primo errore: nessuna eccezione', async () => {
    (runQueryRows as any).mockRejectedValue(new Error('Supabase query error: 544 — timeout'));
    (getDatabasePauseState as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        status: 'INACTIVE',
        availability: 'in-pausa',
        checkedAt: new Date().toISOString(),
        resumeRequestedAt: null,
        resumeBlocked: null,
      });

    await expect(processLogisticsRecompute('shop-1')).resolves.toBeUndefined();
    expect(noteDatabaseUnreachable).toHaveBeenCalledWith('shop-1');
  });

  it('un guasto qualunque del database acceso invece si propaga: la coda ritenta', async () => {
    (runQueryRows as any).mockRejectedValue(new Error('Supabase query error: 500'));

    await expect(processLogisticsRecompute('shop-1')).rejects.toThrow('500');
  });

  it('negozio senza ordini sincronizzati: non tocca il database', async () => {
    (can as any).mockReturnValue(false);

    await processLogisticsRecompute('shop-1');

    expect(runQueryRows).not.toHaveBeenCalled();
    expect(loadLogisticsConfigStrict).not.toHaveBeenCalled();
  });

  it('riverifica il possesso del negozio prima di scrivere', async () => {
    (runQueryRows as any).mockResolvedValueOnce([ordine({})]);
    const lease = { assertHeld: vi.fn().mockRejectedValue(new Error('lucchetto perso')) };

    await expect(processLogisticsRecompute('shop-1', { lease })).rejects.toThrow('lucchetto perso');
    expect(runQuery).not.toHaveBeenCalled();
  });
});

describe('a tappe sui negozi grandi', () => {
  it('a budget esaurito dopo la pagina 1 accoda la continuazione dal suo ultimo id', async () => {
    const pagina1 = Array.from({ length: RECOMPUTE_PAGE_SIZE }, (_, i) =>
      ordine({ shopify_order_id: String(5000 + i) }),
    );
    const ultimo = String(5000 + RECOMPUTE_PAGE_SIZE - 1);
    (runQueryRows as any).mockResolvedValueOnce(pagina1);
    // L'orologio: la corsa parte a 0, dopo la prima pagina sono passati 2 s su
    // un budget di 1 s.
    const istanti = [0, 2_000];
    const clock = () => istanti.shift() ?? 2_000;

    await processLogisticsRecompute('shop-1', { jobId: 'job-1', budgetMs: 1_000, clock });

    // Una pagina letta e scritta, poi si ferma invece di andare avanti.
    expect(runQueryRows).toHaveBeenCalledTimes(1);
    expect(scritture()).toHaveLength(1);
    const continuazione = [...righeCoda.values()].find((r) => r.dedupKey.includes(':continua:'));
    expect(continuazione?.payload).toEqual({ cursor: ultimo });
    expect(triggerSyncDrain).toHaveBeenCalledWith('shop-1');

    // Il tentativo dopo riparte da li', non da zero.
    vi.clearAllMocks();
    (runQueryRows as any).mockResolvedValueOnce([ordine({ shopify_order_id: '9000' })]);
    await processLogisticsRecompute('shop-1', {
      jobId: continuazione!.id,
      cursor: (continuazione!.payload as { cursor: string }).cursor,
    });
    const prima = (runQueryRows as any).mock.calls[0][2] as string;
    expect(prima).toContain(`shopify_order_id > ${ultimo}`);
  });

  it('se la continuazione non si accoda, solleva: la coda ritenta invece di perdere il resto', async () => {
    (runQueryRows as any).mockResolvedValueOnce(
      Array.from({ length: RECOMPUTE_PAGE_SIZE }, (_, i) => ordine({ shopify_order_id: String(1 + i) })),
    );
    (prisma.syncRequest.createMany as any).mockRejectedValueOnce(new Error('db giu\''));
    const istanti = [0, 2_000];

    await expect(
      processLogisticsRecompute('shop-1', {
        jobId: 'job-1',
        budgetMs: 1_000,
        clock: () => istanti.shift() ?? 2_000,
      }),
    ).rejects.toThrow();
  });

  it('un cursore malformato nel payload riparte da zero', async () => {
    await processLogisticsRecompute('shop-1', { jobId: 'job-1', cursor: '1 OR 1=1' });

    const prima = (runQueryRows as any).mock.calls[0][2] as string;
    expect(prima).not.toContain('WHERE');
  });
});

describe('recomputeUpdateSQL', () => {
  it('un costo negativo diventa zero', () => {
    expect(recomputeUpdateSQL([{ id: '7', cost: -5 }])).toContain('(7::bigint, 0.00::numeric)');
  });

  it('rifiuta un id che non e\' un intero', () => {
    expect(() => recomputeUpdateSQL([{ id: "1; DROP TABLE orders", cost: 1 }])).toThrow();
  });

  it('un costo non finito diventa zero invece di finire nel testo', () => {
    const sql = recomputeUpdateSQL([{ id: '7', cost: Number.NaN }]);
    expect(sql).toContain('(7::bigint, 0.00::numeric)');
    expect(sql).not.toContain('NaN');
  });
});

describe('enqueueLogisticsRecompute', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-23T10:00:10.000Z'));
  });

  it('due salvataggi ravvicinati accodano un solo ricalcolo', async () => {
    await enqueueLogisticsRecompute('shop-1');
    await enqueueLogisticsRecompute('shop-1');

    expect(righeCoda.size).toBe(1);
    const [riga] = [...righeCoda.values()];
    expect(riga.dedupKey.startsWith('logistics-recompute:shop-1:')).toBe(true);
    expect(triggerSyncDrain).toHaveBeenCalledWith('shop-1');
  });

  it('se il ricalcolo e\' gia\' partito ne accoda uno dopo, e uno solo', async () => {
    await enqueueLogisticsRecompute('shop-1');
    // Il primo ha gia' letto le tariffe vecchie: il salvataggio nuovo non puo'
    // fondersi in lui.
    [...righeCoda.values()][0].status = 'processing';

    await enqueueLogisticsRecompute('shop-1');
    await enqueueLogisticsRecompute('shop-1');

    expect(righeCoda.size).toBe(2);
  });

  it('il ricalcolo accodato dopo un salvataggio riparte da zero, senza cursore', async () => {
    await enqueueLogisticsRecompute('shop-1');
    [...righeCoda.values()][0].status = 'processing';

    await enqueueLogisticsRecompute('shop-1');

    const seguito = [...righeCoda.values()][1];
    expect(seguito.dedupKey).toContain(':dopo:');
    expect((seguito.payload as { cursor?: unknown } | null)?.cursor).toBeUndefined();
  });

  it('catena esaurita: niente accodato, e lo dice con un ALLARME', async () => {
    // Ogni chiave e' gia' presa da un ricalcolo partito.
    (prisma.syncRequest.createMany as any).mockResolvedValue({ count: 0 });
    let n = 0;
    (prisma.syncRequest.findUnique as any).mockImplementation(async () => ({
      id: `r${n++}`,
      status: 'processing',
    }));

    await enqueueLogisticsRecompute('shop-1');

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ALLARME'));
  });

  it('negozi diversi non si deduplicano fra loro', async () => {
    await enqueueLogisticsRecompute('shop-1');
    await enqueueLogisticsRecompute('shop-2');

    expect(righeCoda.size).toBe(2);
  });

  it('un guasto della coda non fa fallire il salvataggio di chi chiama', async () => {
    (prisma.syncRequest.createMany as any).mockRejectedValueOnce(new Error('db giu\''));

    await expect(enqueueLogisticsRecompute('shop-1')).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
