import { describe, it, expect, vi, beforeEach } from 'vitest';

const findPlanByName = vi.fn();
const triggerSyncDrain = vi.fn();

// La coda finta rispetta la sola regola che qui conta: una chiave di deduplica
// gia' presente non produce una seconda riga (l'indice unico su Postgres).
const righe = new Map<string, { id: string; type: string; shopId: string | null }>();
const enqueueSyncRequest = vi.fn(
  async (opts: { type: string; shopId: string | null; dedupKey: string; db?: unknown }) => {
    const esistente = righe.get(opts.dedupKey);
    if (esistente) return { id: esistente.id, duplicate: true };
    const id = `req-${righe.size + 1}`;
    righe.set(opts.dedupKey, { id, type: opts.type, shopId: opts.shopId });
    return { id, duplicate: false };
  },
);

vi.mock('~/db.server', () => ({ prisma: {} }));
vi.mock('~/lib/billing/find-plan.server', () => ({
  findPlanByName: (...a: unknown[]) => findPlanByName(...a),
}));
vi.mock('~/lib/queue/queue-store.server', () => ({
  enqueueSyncRequest: (opts: {
    type: string;
    shopId: string | null;
    dedupKey: string;
    db?: unknown;
  }) => enqueueSyncRequest(opts),
}));
vi.mock('~/lib/queue/trigger.server', () => ({
  triggerSyncDrain: (...a: unknown[]) => triggerSyncDrain(...a),
}));

import { queueCapCatchUp } from './cap-catch-up.server';
import { dedupKeyFor } from '~/lib/queue/queue-model';

const NOW = new Date('2026-10-02T10:00:30.000Z');

const PLANS: Record<string, unknown> = {
  basic: { planName: 'Basic', maxProducts: 20, maxCustomers: 0, customersSyncEnabled: false, productFeedsEnabled: false },
  growth: { planName: 'Growth', maxProducts: 200, maxCustomers: 250, customersSyncEnabled: true, productFeedsEnabled: true },
  scale: { planName: 'Scale', maxProducts: 1000, maxCustomers: 500, customersSyncEnabled: true, productFeedsEnabled: true },
};

/** Il negozio come lo legge la transazione, DOPO la scrittura del piano nuovo. */
function negozio(overrides: Record<string, unknown> = {}) {
  return {
    lifecycleStatus: 'active',
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products,read_customers,read_orders',
    currentPlan: 'Growth',
    isInTrial: false,
    trialEndsAt: null,
    activeChargeId: '1234',
    lastSyncedPlan: 'Basic',
    supabaseConfig: { connectionVerifiedAt: new Date('2026-09-01T00:00:00.000Z') },
    ...overrides,
  };
}

const shopFindUnique = vi.fn();
const db = { shop: { findUnique: (...a: unknown[]) => shopFindUnique(...a) } } as never;

function call(previousPlanName: string | null, nextPlanName: string, now = NOW) {
  return queueCapCatchUp({ shopId: 'shop-1', previousPlanName, nextPlanName, db, now });
}

describe('queueCapCatchUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    righe.clear();
    // La riga di log di ogni accodamento: qui non dice niente di nuovo.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    findPlanByName.mockImplementation(async (name: string | null) =>
      name ? (PLANS[name.trim().toLowerCase()] ?? null) : null,
    );
    shopFindUnique.mockResolvedValue(negozio());
  });

  it('upgrade su un negozio collegato: accoda UNA sync completa e la fa partire', async () => {
    const esito = await call('Basic', 'Growth');

    expect(esito).toEqual({ status: 'queued', products: true, customers: true });
    expect(enqueueSyncRequest).toHaveBeenCalledTimes(1);
    expect(enqueueSyncRequest).toHaveBeenCalledWith({
      type: 'initial-bulk-sync',
      shopId: 'shop-1',
      // La stessa chiave del recupero del cron: se passa nello stesso minuto,
      // si fonde con questa invece di accodarne un'altra.
      dedupKey: dedupKeyFor('initial-bulk-sync', 'shop-1', NOW),
      // Lo stesso client del cambio di piano: dentro una transazione la riga
      // entra con il piano o non entra, e non chiede una seconda connessione.
      db,
    });
    expect(findPlanByName).toHaveBeenCalledWith('Basic', db);
    expect(findPlanByName).toHaveBeenCalledWith('Growth', db);
    expect(triggerSyncDrain).toHaveBeenCalledWith('shop-1');
  });

  it('downgrade: nessuna sync completa in piu', async () => {
    shopFindUnique.mockResolvedValue(negozio({ currentPlan: 'Basic', lastSyncedPlan: 'Growth' }));
    const esito = await call('Growth', 'Basic');

    expect(esito.status).toBe('not_raised');
    expect(enqueueSyncRequest).not.toHaveBeenCalled();
    expect(triggerSyncDrain).not.toHaveBeenCalled();
  });

  it('stesso piano riapplicato (notifica ripetuta): niente', async () => {
    const esito = await call('Growth', 'Growth');

    expect(esito.status).toBe('not_raised');
    expect(enqueueSyncRequest).not.toHaveBeenCalled();
  });

  it('decide sul piano senza rileggere il negozio quando il tetto non sale', async () => {
    await call('Scale', 'Growth');
    expect(shopFindUnique).not.toHaveBeenCalled();
  });

  it('webhook e callback dello stesso cambio insieme: una riga sola in coda', async () => {
    // Tutte e due hanno letto il piano di prima prima che l'altra scrivesse:
    // la decisione da sola non basta, e ci pensa la deduplica della coda.
    const [a, b] = await Promise.all([call('Basic', 'Growth'), call('Basic', 'Growth')]);

    expect(righe.size).toBe(1);
    expect([a.status, b.status].sort()).toEqual(['already_queued', 'queued']);
    // Una riga, un innesco.
    expect(triggerSyncDrain).toHaveBeenCalledTimes(1);
  });

  it('seconda notifica dopo che la prima ha gia applicato il piano: niente', async () => {
    await call('Basic', 'Growth');
    // La seconda trova il piano gia' scritto: prima e dopo coincidono.
    await call('Growth', 'Growth');

    expect(righe.size).toBe(1);
    expect(enqueueSyncRequest).toHaveBeenCalledTimes(1);
  });

  it('negozio non collegato al proprio database: niente', async () => {
    shopFindUnique.mockResolvedValue(negozio({ supabaseConfig: null }));
    const esito = await call('Basic', 'Growth');

    expect(esito.status).toBe('not_ready');
    expect(enqueueSyncRequest).not.toHaveBeenCalled();
  });

  it('collegamento non ancora verificato: niente', async () => {
    shopFindUnique.mockResolvedValue(
      negozio({ supabaseConfig: { connectionVerifiedAt: null } }),
    );
    expect((await call('Basic', 'Growth')).status).toBe('not_ready');
    expect(enqueueSyncRequest).not.toHaveBeenCalled();
  });

  it('negozio sospeso o disinstallato: niente', async () => {
    shopFindUnique.mockResolvedValue(negozio({ authorization: 'DISABLED' }));
    expect((await call('Basic', 'Growth')).status).toBe('not_ready');

    shopFindUnique.mockResolvedValue(negozio({ uninstalledAt: new Date('2026-09-30') }));
    expect((await call('Basic', 'Growth')).status).toBe('not_ready');

    expect(enqueueSyncRequest).not.toHaveBeenCalled();
  });

  it('mai sincronizzato: la prima sync resta del merchant, non si accoda niente', async () => {
    shopFindUnique.mockResolvedValue(negozio({ lastSyncedPlan: null }));
    const esito = await call('Basic', 'Growth');

    expect(esito.status).toBe('never_synced');
    expect(enqueueSyncRequest).not.toHaveBeenCalled();
  });

  it('non solleva mai: un guasto della coda non deve far fallire il cambio di piano', async () => {
    const errore = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    enqueueSyncRequest.mockRejectedValueOnce(new Error('coda giu'));

    const esito = await call('Basic', 'Growth');

    expect(esito.status).toBe('failed');
    expect(triggerSyncDrain).not.toHaveBeenCalled();
    expect(errore).toHaveBeenCalledWith(expect.stringContaining('ALLARME'));
    errore.mockRestore();
  });
});
