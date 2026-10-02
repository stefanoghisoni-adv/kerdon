import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Un Redis finto, in memoria: la prova guarda quando lo si interroga, non la
// rete. `redisUp` spegne il server per i casi in cui Redis manca.
const store = new Map<string, string>();
let redisUp = true;
const get = vi.fn(async (k: string) => store.get(k) ?? null);
const set = vi.fn(async (k: string, v: string) => {
  store.set(k, v);
  return 'OK';
});
const del = vi.fn(async (k: string) => (store.delete(k) ? 1 : 0));

vi.mock('ioredis', () => ({
  default: class {
    get = get;
    set = set;
    del = del;
  },
}));

vi.mock('../queue/connection.server', () => ({
  redisConnectionOptions: () => {
    if (!redisUp) throw new Error('REDIS_URL environment variable not configured');
    return {};
  },
}));

async function load() {
  vi.resetModules();
  return import('./report-tables-cache.server');
}

beforeEach(() => {
  store.clear();
  redisUp = true;
  get.mockClear();
  set.mockClear();
  del.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('report-tables-cache', () => {
  it('di un negozio mai visto non sa niente', async () => {
    const cache = await load();
    expect(await cache.reportTablesKnown('shop-1', 'ref')).toBe(false);
  });

  it('ricordato una volta, risponde dalla memoria senza chiedere a Redis', async () => {
    const cache = await load();
    await cache.rememberReportTables('shop-1', 'ref');
    get.mockClear();

    expect(await cache.reportTablesKnown('shop-1', 'ref')).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('un\'istanza appena avviata lo ritrova in Redis', async () => {
    const prima = await load();
    await prima.rememberReportTables('shop-1', 'ref');

    // Un processo nuovo: memoria vuota, Redis condiviso.
    const nuova = await load();
    expect(await nuova.reportTablesKnown('shop-1', 'ref')).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('un progetto diverso dello stesso negozio va ricontrollato', async () => {
    const cache = await load();
    await cache.rememberReportTables('shop-1', 'ref-vecchio');
    expect(await cache.reportTablesKnown('shop-1', 'ref-nuovo')).toBe(false);
  });

  it("dimenticato, si ricontrolla: ne' in memoria ne' in Redis", async () => {
    const cache = await load();
    await cache.rememberReportTables('shop-1', 'ref');
    await cache.forgetReportTables('shop-1', 'ref');

    expect(await cache.reportTablesKnown('shop-1', 'ref')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('il ricordo in memoria scade', async () => {
    vi.useFakeTimers();
    const cache = await load();
    await cache.rememberReportTables('shop-1', 'ref');
    store.clear();

    vi.advanceTimersByTime(61 * 60 * 1000);
    expect(await cache.reportTablesKnown('shop-1', 'ref')).toBe(false);
  });

  it('senza Redis resta la memoria, e nessuna chiamata fallisce', async () => {
    redisUp = false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = await load();

    expect(await cache.reportTablesKnown('shop-1', 'ref')).toBe(false);
    await cache.rememberReportTables('shop-1', 'ref');
    expect(await cache.reportTablesKnown('shop-1', 'ref')).toBe(true);
    await expect(cache.forgetReportTables('shop-1', 'ref')).resolves.toBeUndefined();
  });

  it('un Redis che non risponde non tiene ferma l\'apertura', async () => {
    const cache = await load();
    // Il client si apre con un import dinamico, che i timer finti non
    // governano: lo si apre prima, e si ferma il tempo solo dopo.
    await cache.reportTablesKnown('shop-0', 'ref');
    vi.useFakeTimers();
    get.mockImplementationOnce(() => new Promise<string | null>(() => {}));

    const known = cache.reportTablesKnown('shop-1', 'ref');
    await vi.advanceTimersByTimeAsync(300);
    expect(await known).toBe(false);
  });
});
