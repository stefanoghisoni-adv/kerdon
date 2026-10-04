// app/lib/integrations/import.server.test.ts
//
// L'import da Klaviyo con tutte le dipendenze finte: database dell'app in
// memoria, Klaviyo che risponde a pagine, Shopify che registra le scritture,
// tabella clienti del merchant come elenco di righe.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const stato = vi.hoisted(() => ({
  shop: null as Record<string, unknown> | null,
  mapping: null as Record<string, unknown> | null,
  runs: [] as Array<Record<string, any>>,
  pendingRequests: [] as Array<{ shopId: string; type: string; status: string }>,
  conflicts: new Map<number, { status: string; theirValue: string; ourValue: string | null; decidedAt: Date | null }>(),
  customers: [] as Array<Record<string, unknown>>,
  chosen: null as number[] | null,
  dedupKeys: new Set<string>(),
}));

vi.mock('~/db.server', () => {
  const prisma: Record<string, any> = {
    shop: { findUnique: vi.fn(async () => stato.shop) },
    integrationFieldMapping: { findUnique: vi.fn(async () => stato.mapping) },
    integrationImportRun: {
      findUnique: vi.fn(async ({ where }: any) => stato.runs.find((r) => r.id === where.id) ?? null),
      findFirst: vi.fn(async () =>
        [...stato.runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const run = { id: `run-${stato.runs.length + 1}`, cursor: null, startedAt: new Date(), finishedAt: null, ...data };
        stato.runs.push(run);
        return run;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const run = stato.runs.find((r) => r.id === where.id)!;
        Object.assign(run, data);
        return run;
      }),
    },
    syncRequest: {
      findFirst: vi.fn(async ({ where }: any) =>
        stato.pendingRequests.find(
          (r) => r.shopId === where.shopId && r.type === where.type && where.status.in.includes(r.status),
        ) ?? null,
      ),
    },
    // Le due query sui conflitti, lette per posizione dei parametri.
    $queryRaw: vi.fn(async (_s: TemplateStringsArray, _shop: string, _provider: string, ids: string[]) =>
      ids
        .filter((id) => stato.conflicts.has(Number(id)))
        .map((id) => ({
          shopify_customer_id: BigInt(id),
          status: stato.conflicts.get(Number(id))!.status,
          their_value: stato.conflicts.get(Number(id))!.theirValue,
        })),
    ),
    $executeRaw: vi.fn(
      async (_s: TemplateStringsArray, _id: string, _shop: string, _provider: string, customerId: string, ours: string | null, theirs: string) => {
        const prima = stato.conflicts.get(Number(customerId));
        if (prima && prima.status !== 'open' && prima.theirValue === theirs) return 1;
        stato.conflicts.set(Number(customerId), { status: 'open', theirValue: theirs, ourValue: ours, decidedAt: null });
        return 1;
      },
    ),
  };
  prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma };
});

vi.mock('~/lib/billing/find-plan.server', () => ({ findPlanByName: vi.fn() }));
vi.mock('~/lib/integrations/connections.server', () => ({
  getAccessToken: vi.fn(async () => 'tok'),
  markNeedsReconnect: vi.fn(),
  connectionStatus: vi.fn(async () => ({ status: 'connected', accountName: 'Acme' })),
}));
vi.mock('~/lib/integrations/klaviyo/api.server', async (orig) => ({
  ...(await orig<typeof import('~/lib/integrations/klaviyo/api.server')>()),
  listProfiles: vi.fn(),
}));
vi.mock('~/lib/shopify-api.server', () => ({
  ShopifyAPIClient: { forShop: vi.fn() },
}));
vi.mock('~/lib/workers/processors.server', () => ({
  resolveBirthdateTarget: vi.fn(async () => ({ namespace: 'facts', key: 'birth_date', type: 'date' })),
}));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn(() => ({})) }));
vi.mock('~/lib/limits/customer-limit.server', () => ({
  loadCustomerQuota: vi.fn(async () => ({
    ok: true,
    quota: {
      admit: () => true,
      chosenIds: () => stato.chosen ?? [],
      remaining: () => (stato.chosen === null ? null : 0),
    },
  })),
}));
vi.mock('~/lib/gdpr/paged-read', () => ({
  readAllByIn: vi.fn(async (_s: unknown, _t: unknown, _c: string, ids: number[]) => ({
    rows: stato.customers.filter((c) => ids.includes(Number(c.shopify_customer_id))),
    keys: [],
    error: null,
    expected: null,
  })),
  drainPages: vi.fn(async () => ({ rows: stato.customers, keys: [], error: null, expected: null })),
}));
vi.mock('~/lib/queue/queue-store.server', () => ({
  enqueueSyncRequest: vi.fn(async (opts: { dedupKey: string; shopId: string; type: string }) => {
    if (stato.dedupKeys.has(opts.dedupKey)) return { id: 'x', duplicate: true };
    stato.dedupKeys.add(opts.dedupKey);
    stato.pendingRequests.push({ shopId: opts.shopId, type: opts.type, status: 'queued' });
    return { id: `req-${stato.dedupKeys.size}`, duplicate: false };
  }),
}));
vi.mock('~/lib/queue/trigger.server', () => ({ triggerSyncDrain: vi.fn() }));

import { processIntegrationImport, requestImport } from './import.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { listProfiles, KlaviyoAuthError, KlaviyoUnavailableError } from '~/lib/integrations/klaviyo/api.server';
import { markNeedsReconnect, connectionStatus } from '~/lib/integrations/connections.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { enqueueSyncRequest } from '~/lib/queue/queue-store.server';

/* eslint-disable @typescript-eslint/no-explicit-any */

const setCustomerBirthdates = vi.fn();

function profilo(id: string, email: string, birthday: unknown) {
  return { id, email, phone: null, countryCode: null, shopifyCustomerId: null, properties: { birthday } };
}

function cliente(id: number, email: string, dob: string | null) {
  return {
    id: `uuid-${id}`,
    shopify_customer_id: id,
    email_address: email,
    phone_number: null,
    country_code: 'IT',
    date_of_birth: dob,
    created_at: `2024-01-0${id}T00:00:00`,
  };
}

const PAGINA_2 = 'https://a.klaviyo.com/api/profiles?page%5Bcursor%5D=due';

function nuovoRun(over: Record<string, unknown> = {}) {
  const run = {
    id: 'run-1',
    shopId: 'shop-1',
    provider: 'klaviyo',
    status: 'running',
    cursor: null,
    counters: {},
    startedAt: new Date(),
    finishedAt: null,
    ...over,
  };
  stato.runs.push(run);
  return run;
}

const opzioni = (over: Record<string, unknown> = {}) => ({
  cursor: null,
  runId: 'run-1',
  lease: { assertHeld: async () => undefined },
  saveCursor: vi.fn(async () => undefined),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  stato.shop = {
    id: 'shop-1',
    shopDomain: 'acme.myshopify.com',
    currentPlan: 'Growth',
    scopes: 'read_customers,write_customers',
    birthdateMetafieldNamespace: 'facts',
    birthdateMetafieldKey: 'birth_date',
    supabaseConfig: { tableNameCustomers: 'customers' },
  };
  stato.mapping = { sourceKey: 'birthday', dateFormat: 'auto', targetField: 'birthdate' };
  stato.runs = [];
  stato.pendingRequests = [];
  stato.conflicts = new Map();
  stato.dedupKeys = new Set();
  stato.customers = [
    cliente(1, 'vuoto@x.it', null),
    cliente(2, 'uguale@x.it', '19900101'),
    cliente(3, 'diverso@x.it', '19800505'),
    cliente(4, 'deciso@x.it', '19700101'),
    cliente(5, 'oltre@x.it', null),
  ];
  // Il tetto ammette i primi quattro per data di creazione: il quinto e' fuori.
  stato.chosen = [1, 2, 3, 4];
  stato.conflicts.set(4, { status: 'kept_ours', theirValue: '1971-02-02', ourValue: '19700101', decidedAt: new Date() });
  (findPlanByName as any).mockResolvedValue({ customersSyncEnabled: true, maxCustomers: 4 });
  (connectionStatus as any).mockResolvedValue({ status: 'connected', accountName: 'Acme' });
  setCustomerBirthdates.mockImplementation(async (entries: unknown[]) => ({ written: entries.length, errors: [], failed: [] }));
  (ShopifyAPIClient.forShop as any).mockResolvedValue({ setCustomerBirthdates });
  (listProfiles as any).mockImplementation(async (_t: string, cursor: string | null) => {
    if (cursor === null) {
      return {
        profiles: [
          profilo('k1', 'vuoto@x.it', '1985-04-23'),
          profilo('k2', 'UGUALE@x.it', '1990-01-01'),
          profilo('k3', 'diverso@x.it', '1981-01-01'),
          profilo('k4', 'deciso@x.it', '1971-02-02'),
          profilo('k5', 'oltre@x.it', '1999-09-09'),
        ],
        next: PAGINA_2,
      };
    }
    throw new KlaviyoUnavailableError();
  });
});

describe('processIntegrationImport', () => {
  it('seconda pagina con 429 esaurito: run interrotto con i contatori della prima', async () => {
    nuovoRun();

    const esito = await processIntegrationImport('shop-1', opzioni());

    expect(esito).toBe('interrupted');
    const run = stato.runs[0];
    expect(run.status).toBe('interrupted');
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect(run.cursor).toBe(PAGINA_2);
    expect(run.counters).toEqual({
      matchedById: 0,
      matchedByEmail: 4,
      matchedByPhone: 0,
      filled: 1,
      same: 1,
      conflicts: 1,
      decided: 1,
      skippedNoMatch: 1,
      skippedAmbiguous: 0,
      unreadable: 0,
      notWritten: 0,
    });
  });

  it('campo vuoto: una sola scrittura su Shopify, nel campo scelto, in formato ISO', async () => {
    nuovoRun();
    await processIntegrationImport('shop-1', opzioni());

    expect(setCustomerBirthdates).toHaveBeenCalledTimes(1);
    expect(setCustomerBirthdates).toHaveBeenCalledWith([{ customerId: 1, date: '1985-04-23' }], {
      namespace: 'facts',
      key: 'birth_date',
      type: 'date',
    });
  });

  it('valore diverso: conflitto aperto; uguale e gia deciso: nessun conflitto nuovo', async () => {
    nuovoRun();
    await processIntegrationImport('shop-1', opzioni());

    // Il nostro valore arriva come YYYYMMDD e si registra in ISO, come quello di Klaviyo.
    expect(stato.conflicts.get(3)).toMatchObject({ status: 'open', theirValue: '1981-01-01', ourValue: '1980-05-05' });
    expect(stato.conflicts.has(2)).toBe(false);
    // kept_ours con lo stesso valore di Klaviyo: resta chiuso.
    expect(stato.conflicts.get(4)?.status).toBe('kept_ours');
  });

  it('conflitto deciso ma Klaviyo ha cambiato valore: si riapre', async () => {
    stato.conflicts.set(4, { status: 'kept_ours', theirValue: '1960-01-01', ourValue: '19700101', decidedAt: new Date() });
    nuovoRun();
    await processIntegrationImport('shop-1', opzioni());

    expect(stato.conflicts.get(4)).toMatchObject({ status: 'open', theirValue: '1971-02-02', decidedAt: null });
    expect(stato.runs[0].counters.conflicts).toBe(2);
    expect(stato.runs[0].counters.decided).toBe(0);
  });

  it('cliente oltre il tetto del piano: non toccato', async () => {
    nuovoRun();
    await processIntegrationImport('shop-1', opzioni());

    const scritti = setCustomerBirthdates.mock.calls.flatMap((c) => c[0] as Array<{ customerId: number }>);
    expect(scritti.map((e) => e.customerId)).not.toContain(5);
    expect(stato.conflicts.has(5)).toBe(false);
  });

  it('senza tetto: tutti i clienti idonei sono candidati', async () => {
    stato.chosen = null;
    nuovoRun();
    await processIntegrationImport('shop-1', opzioni());

    const scritti = setCustomerBirthdates.mock.calls.flatMap((c) => c[0] as Array<{ customerId: number }>);
    expect(scritti.map((e) => e.customerId).sort()).toEqual([1, 5]);
  });

  it('scrittura rifiutata da Shopify: contata come non scritta', async () => {
    setCustomerBirthdates.mockResolvedValue({ written: 0, errors: ['no'], failed: [{ customerId: 1, reason: 'no' }] });
    nuovoRun();
    await processIntegrationImport('shop-1', opzioni());

    expect(stato.runs[0].counters.filled).toBe(0);
    expect(stato.runs[0].counters.notWritten).toBe(1);
  });

  it('valori illeggibili e profili ambigui: saltati e contati', async () => {
    stato.customers.push(cliente(6, 'doppio@x.it', null), cliente(7, 'doppio@x.it', null));
    stato.chosen = null;
    (listProfiles as any).mockResolvedValue({
      profiles: [profilo('a', 'vuoto@x.it', '31/12/90'), profilo('b', 'doppio@x.it', '1990-01-01'), profilo('c', 'diverso@x.it', '')],
      next: null,
    });
    nuovoRun();

    expect(await processIntegrationImport('shop-1', opzioni())).toBe('completed');

    expect(stato.runs[0]).toMatchObject({ status: 'completed' });
    expect(stato.runs[0].counters).toMatchObject({ unreadable: 1, skippedAmbiguous: 1, filled: 0 });
    expect(setCustomerBirthdates).not.toHaveBeenCalled();
  });

  it('Klaviyo rifiuta il token: da ricollegare e run interrotto', async () => {
    (listProfiles as any).mockRejectedValue(new KlaviyoAuthError());
    nuovoRun();

    expect(await processIntegrationImport('shop-1', opzioni())).toBe('interrupted');
    expect(markNeedsReconnect).toHaveBeenCalledWith('shop-1');
    expect(stato.runs[0].status).toBe('interrupted');
  });

  it('tempo quasi finito: si ferma dopo la pagina e passa il cursore alla continuazione', async () => {
    (listProfiles as any).mockResolvedValue({ profiles: [profilo('k1', 'vuoto@x.it', '1985-04-23')], next: PAGINA_2 });
    nuovoRun();
    let adesso = 0;
    const saveCursor = vi.fn(async () => undefined);

    const esito = await processIntegrationImport('shop-1', {
      ...opzioni({ saveCursor }),
      budgetMs: 100_000,
      clock: () => (adesso += 50_000),
    } as any);

    expect(esito).toBe('paused');
    expect(saveCursor).toHaveBeenCalledWith(PAGINA_2, 'run-1');
    expect(stato.runs[0]).toMatchObject({ status: 'running', cursor: PAGINA_2 });
  });

  it('segnale interrotto: in pausa senza accodare, la coda riprende lo stesso item', async () => {
    const controller = new AbortController();
    (listProfiles as any).mockImplementation(async () => {
      controller.abort();
      return { profiles: [], next: PAGINA_2 };
    });
    nuovoRun();
    const saveCursor = vi.fn(async () => undefined);

    expect(await processIntegrationImport('shop-1', opzioni({ signal: controller.signal, saveCursor }))).toBe('paused');
    expect(saveCursor).not.toHaveBeenCalled();
    expect(stato.runs[0].cursor).toBe(PAGINA_2);
  });

  it('run gia chiuso: niente da fare', async () => {
    nuovoRun({ status: 'completed' });
    expect(await processIntegrationImport('shop-1', opzioni())).toBe('completed');
    expect(listProfiles).not.toHaveBeenCalled();
  });
});

describe('requestImport', () => {
  it('due richieste di fila: la seconda trova il giro gia in corso', async () => {
    expect(await requestImport('shop-1', 'klaviyo')).toEqual({ queued: true });
    expect(await requestImport('shop-1', 'klaviyo')).toEqual({ queued: false, reason: 'already_running' });
    expect(enqueueSyncRequest).toHaveBeenCalledTimes(1);
    expect(stato.runs).toHaveLength(1);
    expect((enqueueSyncRequest as any).mock.calls[0][0]).toMatchObject({
      type: 'integration-import',
      shopId: 'shop-1',
      payload: { runId: 'run-1', cursor: null },
    });
  });

  it('chiave di deduplica occupata (due clic insieme): nessun secondo giro', async () => {
    stato.dedupKeys.add('integration-import:shop-1:dopo:primo');
    expect(await requestImport('shop-1', 'klaviyo')).toEqual({ queued: false, reason: 'already_running' });
  });

  it('un giro fermo da piu di 15 minuti senza lavoro in coda: chiuso e se ne parte uno nuovo', async () => {
    nuovoRun({ startedAt: new Date(Date.now() - 16 * 60_000) });
    expect(await requestImport('shop-1', 'klaviyo')).toEqual({ queued: true });
    expect(stato.runs[0].status).toBe('interrupted');
    expect(stato.runs).toHaveLength(2);
  });

  it('un giro vecchio ma con lavoro ancora in coda: resta in corso', async () => {
    nuovoRun({ startedAt: new Date(Date.now() - 60 * 60_000) });
    stato.pendingRequests.push({ shopId: 'shop-1', type: 'integration-import', status: 'processing' });
    expect(await requestImport('shop-1', 'klaviyo')).toEqual({ queued: false, reason: 'already_running' });
  });

  it('dopo un giro concluso se ne puo chiedere un altro', async () => {
    nuovoRun({ status: 'completed', startedAt: new Date(Date.now() - 60_000) });
    expect(await requestImport('shop-1', 'klaviyo')).toEqual({ queued: true });
  });

  it('senza write_customers: no_write_access', async () => {
    stato.shop!.scopes = 'read_customers';
    expect(await requestImport('shop-1', 'klaviyo')).toEqual({ queued: false, reason: 'no_write_access' });
    expect(enqueueSyncRequest).not.toHaveBeenCalled();
  });

  it('senza campo data di nascita scelto: no_write_access', async () => {
    stato.shop!.birthdateMetafieldKey = null;
    expect(await requestImport('shop-1', 'klaviyo')).toEqual({ queued: false, reason: 'no_write_access' });
  });

  it('piano senza clienti: plan', async () => {
    (findPlanByName as any).mockResolvedValue({ customersSyncEnabled: false });
    expect(await requestImport('shop-1', 'klaviyo')).toEqual({ queued: false, reason: 'plan' });
  });

  it('Klaviyo non collegato: not_connected', async () => {
    (connectionStatus as any).mockResolvedValue({ status: 'needs_reconnect', accountName: null });
    expect(await requestImport('shop-1', 'klaviyo')).toEqual({ queued: false, reason: 'not_connected' });
  });

  it('nessuna associazione salvata: no_mapping', async () => {
    stato.mapping = null;
    expect(await requestImport('shop-1', 'klaviyo')).toEqual({ queued: false, reason: 'no_mapping' });
  });
});
