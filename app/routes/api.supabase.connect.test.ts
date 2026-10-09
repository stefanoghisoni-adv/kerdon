import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const exchangeCode = vi.fn();
const saveTokens = vi.fn();
const verifyState = vi.fn();
const canFn = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'negozio-a.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: { shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) } },
}));
vi.mock('~/lib/supabase-management.server', () => ({
  exchangeCode: (...a: unknown[]) => exchangeCode(...a),
}));
vi.mock('~/lib/supabase-oauth.server', () => ({
  verifyState: (...a: unknown[]) => verifyState(...a),
  saveTokens: (...a: unknown[]) => saveTokens(...a),
}));
vi.mock('~/lib/authz/capabilities', () => ({
  can: (...a: unknown[]) => canFn(...a),
}));
vi.mock('~/lib/authz/shop-capabilities.server', () => ({
  shopCapabilities: async () => ['use_app'],
}));
vi.mock('~/lib/i18n/server', () => ({
  dictionaryForShop: async () => ({ errors: { suspended: 'sospeso' } }),
}));

import { action } from './api.supabase.connect';

const APP = 'https://kerdon.example';
const TOKENS = { access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'bearer' };

function call(body: unknown) {
  return action({
    request: new Request(`${APP}/api/supabase/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as never) as Promise<Response>;
}

describe('POST /api/supabase/connect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_APP_URL = APP;
    process.env.SUPABASE_OAUTH_CLIENT_ID = 'cid';
    process.env.SUPABASE_OAUTH_CLIENT_SECRET = 'secret';
    findUniqueShop.mockResolvedValue({ id: 'shop-A', status: 'ENABLED' });
    canFn.mockReturnValue(true);
    verifyState.mockReturnValue({ shopId: 'shop-A' });
    exchangeCode.mockResolvedValue(TOKENS);
    saveTokens.mockResolvedValue(undefined);
  });

  it('stato emesso per un altro negozio → 403, e il codice NON si scambia', async () => {
    // L'attacco: il negozio B ha avviato il giro, il negozio A (questa
    // sessione) prova a completarlo — o viceversa. In nessun caso i token di
    // un account finiscono sul negozio sbagliato.
    verifyState.mockReturnValue({ shopId: 'shop-B' });

    const res = await call({ code: 'c', state: 's' });

    expect(res.status).toBe(403);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it('stato non valido o scaduto → 400, senza scambio', async () => {
    verifyState.mockReturnValue(null);

    const res = await call({ code: 'c', state: 'scaduto' });

    expect(res.status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('codice o stato mancanti → 400', async () => {
    expect((await call({ code: 'c' })).status).toBe(400);
    expect((await call({ state: 's' })).status).toBe(400);
    expect((await call('non-json')).status).toBe(400);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('negozio sospeso → 403, senza scambio', async () => {
    canFn.mockReturnValue(false);

    const res = await call({ code: 'c', state: 's' });

    expect(res.status).toBe(403);
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(verifyState).not.toHaveBeenCalled();
  });

  it('negozio sconosciuto → 404', async () => {
    findUniqueShop.mockResolvedValue(null);
    expect((await call({ code: 'c', state: 's' })).status).toBe(404);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('percorso buono: scambia con lo stesso redirect e salva sul negozio della sessione', async () => {
    const res = await call({ code: 'c0de', state: 'st4te' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(verifyState).toHaveBeenCalledWith('st4te');
    expect(exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'c0de',
        clientId: 'cid',
        clientSecret: 'secret',
        redirectUri: `${APP}/auth/supabase/callback`,
      }),
    );
    expect(saveTokens).toHaveBeenCalledWith('shop-A', TOKENS);
  });

  it('scambio rifiutato da Supabase → 502, niente salvato', async () => {
    exchangeCode.mockRejectedValue(new Error('Supabase token error: 400'));

    const res = await call({ code: 'c', state: 's' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'exchange_failed' });
    expect(saveTokens).not.toHaveBeenCalled();
  });
});
