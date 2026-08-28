import { describe, it, expect, vi, afterEach } from 'vitest';
import { runQueryRows } from './supabase-management.server';

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe('runQueryRows', () => {
  it('restituisce le righe della SELECT', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ table_name: 'products' }, { table_name: 'customers' }],
    }) as unknown as typeof fetch;

    const rows = await runQueryRows<{ table_name: string }>('tok', 'ref123', 'SELECT 1;');
    expect(rows.map((r) => r.table_name)).toEqual(['products', 'customers']);
  });

  it('risposta non-array → lista vuota', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'nope' }),
    }) as unknown as typeof fetch;

    expect(await runQueryRows('tok', 'ref123', 'SELECT 1;')).toEqual([]);
  });

  it('errore HTTP → eccezione', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '',
    }) as unknown as typeof fetch;
    await expect(runQueryRows('tok', 'ref123', 'SELECT 1;')).rejects.toThrow('500');
  });

  // Il numero da solo non dice niente: 400 e' la risposta a una tabella che non
  // esiste, a una colonna sbagliata e a una sintassi storta. Il messaggio di
  // Postgres deve arrivare fino ai log, o la diagnosi si fa a tentoni.
  it('il motivo vero del rifiuto finisce nel messaggio', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"message":"relation \\"orders\\" does not exist"}',
    }) as unknown as typeof fetch;

    await expect(runQueryRows('tok', 'ref123', 'SELECT 1;')).rejects.toThrow(
      /does not exist/,
    );
  });
});
