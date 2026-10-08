// app/lib/customers/fetch-conflict-names.test.ts
//
// Test per fetchConflictCustomerNames: carica nomi ed email dal database
// del merchant per i conflitti, anche quando fuori periodo.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dei moduli server
vi.mock('~/lib/supabase-oauth.server', () => ({
  getValidAccessToken: vi.fn(),
}));

vi.mock('~/lib/supabase-management.server', () => ({
  runQueryRows: vi.fn(),
}));

import { fetchConflictCustomerNames } from './customers.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQueryRows } from '~/lib/supabase-management.server';

describe('fetchConflictCustomerNames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restituisce Map vuota quando customerIds è vuoto', async () => {
    const result = await fetchConflictCustomerNames('shop-1', 'ref-1', []);

    expect(result).toEqual(new Map());
    expect(getValidAccessToken).not.toHaveBeenCalled();
    expect(runQueryRows).not.toHaveBeenCalled();
  });

  it('carica nomi ed email dal database del merchant', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123');
    vi.mocked(runQueryRows).mockResolvedValue([
      { customer_id: 1, first_name: 'Mario', email: 'mario@example.com' },
      { customer_id: 2, first_name: 'Luigi', email: 'luigi@example.com' },
    ]);

    const result = await fetchConflictCustomerNames('shop-1', 'ref-1', [1, 2]);

    expect(getValidAccessToken).toHaveBeenCalledWith('shop-1');
    expect(runQueryRows).toHaveBeenCalledWith(
      'token-123',
      'ref-1',
      expect.stringContaining('FROM orders o'),
    );

    expect(result).toEqual(
      new Map([
        [1, { firstName: 'Mario', email: 'mario@example.com' }],
        [2, { firstName: 'Luigi', email: 'luigi@example.com' }],
      ]),
    );
  });

  it('gestisce nomi null (cliente senza first_name)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123');
    vi.mocked(runQueryRows).mockResolvedValue([
      { customer_id: 1, first_name: null, email: 'nessunnome@example.com' },
    ]);

    const result = await fetchConflictCustomerNames('shop-1', 'ref-1', [1]);

    expect(result).toEqual(
      new Map([[1, { firstName: null, email: 'nessunnome@example.com' }]]),
    );
  });

  it('gestisce email null', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123');
    vi.mocked(runQueryRows).mockResolvedValue([
      { customer_id: 1, first_name: 'Mario', email: null },
    ]);

    const result = await fetchConflictCustomerNames('shop-1', 'ref-1', [1]);

    expect(result).toEqual(new Map([[1, { firstName: 'Mario', email: null }]]));
  });

  it('usa IDs validati per evitare SQL injection', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123');
    vi.mocked(runQueryRows).mockResolvedValue([]);

    // IDs are validated as safe integers by the caller
    await fetchConflictCustomerNames('shop-1', 'ref-1', [1, 2, 3]);

    const callArgs = vi.mocked(runQueryRows).mock.calls[0];
    const sql = callArgs[2];

    // Verifica che gli IDs validati siano interpolati nella query
    expect(sql).toContain('ANY(ARRAY[1, 2, 3])');

    // Verifica che runQueryRows riceva solo 3 argomenti (token, ref, sql)
    expect(callArgs).toHaveLength(3);
  });

  it('restituisce Map vuota in caso di errore', async () => {
    vi.mocked(getValidAccessToken).mockRejectedValue(new Error('Token expired'));

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await fetchConflictCustomerNames('shop-1', 'ref-1', [1, 2]);

    expect(result).toEqual(new Map());
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[customers] nomi conflitti non leggibili dal database del merchant:',
      'Token expired',
    );

    consoleWarnSpy.mockRestore();
  });

  it('gestisce clienti parzialmente presenti (alcuni nel DB, altri no)', async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue('token-123');
    // Query ritorna solo 1 dei 3 clienti richiesti
    vi.mocked(runQueryRows).mockResolvedValue([
      { customer_id: 2, first_name: 'Luigi', email: 'luigi@example.com' },
    ]);

    const result = await fetchConflictCustomerNames('shop-1', 'ref-1', [1, 2, 3]);

    // Map contiene solo il cliente trovato
    expect(result.size).toBe(1);
    expect(result.get(2)).toEqual({ firstName: 'Luigi', email: 'luigi@example.com' });
    expect(result.has(1)).toBe(false);
    expect(result.has(3)).toBe(false);
  });
});
