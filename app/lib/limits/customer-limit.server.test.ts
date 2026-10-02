import { describe, it, expect, vi } from 'vitest';
import {
  loadCustomerQuota,
  countSyncedCustomers,
} from './customer-limit.server';

/** Un finto query builder che registra la catena e risponde con `result`. */
function fakeSupabase(result: { data?: unknown; error?: unknown; count?: number | null }) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: any = {};
  for (const name of ['select', 'eq', 'order', 'limit']) {
    builder[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null, count: null, ...result }).then(resolve, reject);
  const from = vi.fn(() => builder);
  return { client: { from } as any, calls, from };
}

describe('loadCustomerQuota', () => {
  it('senza tetto non legge niente', async () => {
    const { client, from } = fakeSupabase({});
    const quota = await loadCustomerQuota(client, 'customers', null);
    expect(from).not.toHaveBeenCalled();
    expect(quota.ok && quota.quota.remaining()).toBeNull();
  });

  it('tetto zero: non legge niente e non ammette nessuno', async () => {
    const { client, from } = fakeSupabase({});
    const quota = await loadCustomerQuota(client, 'customers', 0);
    expect(from).not.toHaveBeenCalled();
    expect(quota.ok && quota.quota.admit({ id: 1 })).toBe(false);
  });

  it('legge i primi N idonei in graduatoria e li usa come punto di partenza', async () => {
    const { client, calls, from } = fakeSupabase({
      data: [
        { shopify_customer_id: 10, created_at: '2024-01-01T00:00:00' },
        { shopify_customer_id: 11, created_at: '2024-01-02T00:00:00' },
      ],
    });
    const quota = await loadCustomerQuota(client, 'clienti', 2);
    expect(from).toHaveBeenCalledWith('clienti');
    expect(calls).toEqual([
      ['select', ['shopify_customer_id, created_at']],
      ['eq', ['accepts_marketing', true]],
      ['order', ['created_at', { ascending: true, nullsFirst: true }]],
      ['order', ['shopify_customer_id', { ascending: true }]],
      ['limit', [2]],
    ]);
    if (!quota.ok) throw new Error('atteso ok');
    expect(quota.quota.remaining()).toBe(0);
    expect(quota.quota.admit({ id: 99, createdAt: '2025-01-01T00:00:00Z' })).toBe(false);
    expect(quota.quota.admit({ id: 10, createdAt: '2024-01-01T00:00:00Z' })).toBe(true);
  });

  it('lettura fallita: lo dice, non indovina', async () => {
    const { client } = fakeSupabase({ error: { message: 'boom' } });
    const quota = await loadCustomerQuota(client, 'customers', 250);
    expect(quota).toEqual({ ok: false, error: 'boom' });
  });
});

describe('countSyncedCustomers', () => {
  it('conta solo i clienti con consenso', async () => {
    const { client, calls } = fakeSupabase({ count: 137 });
    expect(await countSyncedCustomers(client, 'customers')).toBe(137);
    expect(calls).toEqual([
      ['select', ['shopify_customer_id', { count: 'exact', head: true }]],
      ['eq', ['accepts_marketing', true]],
    ]);
  });

  it('errore o tabella mancante: null', async () => {
    const { client } = fakeSupabase({ error: { message: 'no table' } });
    expect(await countSyncedCustomers(client, 'customers')).toBeNull();
  });
});
