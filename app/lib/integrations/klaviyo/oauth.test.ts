import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import {
  buildAuthorizeUrl,
  readState,
  exchangeCode,
  refreshTokens,
  revokeToken,
} from './oauth.server';
import { KlaviyoAuthError, KlaviyoUnavailableError } from './api.server';

const salvate = { ...process.env };
const fetchMock = vi.fn();

function risposta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OAuth Klaviyo', () => {
  beforeEach(() => {
    process.env.KLAVIYO_CLIENT_ID = 'cid';
    process.env.KLAVIYO_CLIENT_SECRET = 'segreto';
    process.env.SHOPIFY_APP_URL = 'https://api.kerdon.io';
    // encrypt vuole 64 caratteri esadecimali: quella del setup non li ha.
    process.env.ENCRYPTION_SECRET = 'ab'.repeat(32);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    process.env = { ...salvate };
    vi.unstubAllGlobals();
  });

  describe('buildAuthorizeUrl e readState', () => {
    it('porta PKCE S256 e uno state che restituisce shopId e verifier', () => {
      const now = new Date('2026-10-03T10:00:00Z');
      const url = new URL(buildAuthorizeUrl('shop-1', now));

      expect(url.origin + url.pathname).toBe('https://www.klaviyo.com/oauth/authorize');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('cid');
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://api.kerdon.io/auth/klaviyo/callback',
      );
      expect(url.searchParams.get('scope')).toBe('profiles:read accounts:read');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');

      const stato = readState(url.searchParams.get('state')!, now);
      expect(stato?.shopId).toBe('shop-1');
      // 64 byte in base64url = 86 caratteri, dentro i 43-128 di PKCE.
      expect(stato?.verifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
      const atteso = createHash('sha256').update(stato!.verifier).digest('base64url');
      expect(url.searchParams.get('code_challenge')).toBe(atteso);
    });

    it('uno state scaduto vale null', () => {
      const now = new Date('2026-10-03T10:00:00Z');
      const state = new URL(buildAuthorizeUrl('shop-1', now)).searchParams.get('state')!;
      expect(readState(state, new Date(now.getTime() + 9 * 60_000))).not.toBeNull();
      expect(readState(state, new Date(now.getTime() + 11 * 60_000))).toBeNull();
    });

    it('uno state manomesso vale null', () => {
      const now = new Date();
      const state = new URL(buildAuthorizeUrl('shop-1', now)).searchParams.get('state')!;
      const ultimo = state.at(-1) === 'A' ? 'B' : 'A';
      expect(readState(state.slice(0, -1) + ultimo, now)).toBeNull();
      expect(readState('spazzatura', now)).toBeNull();
      expect(readState('', now)).toBeNull();
    });
  });

  describe('endpoint dei token', () => {
    it('scambia il codice con Basic auth e corpo form-urlencoded', async () => {
      fetchMock.mockResolvedValueOnce(
        risposta(200, {
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          token_type: 'bearer',
        }),
      );
      const prima = Date.now();
      const t = await exchangeCode('codice', 'verificatore');

      expect(t.accessToken).toBe('at');
      expect(t.refreshToken).toBe('rt');
      expect(t.expiresAt.getTime()).toBeGreaterThanOrEqual(prima + 3600_000);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://a.klaviyo.com/oauth/token');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(
        `Basic ${Buffer.from('cid:segreto').toString('base64')}`,
      );
      expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      const corpo = new URLSearchParams(init.body);
      expect(corpo.get('grant_type')).toBe('authorization_code');
      expect(corpo.get('code')).toBe('codice');
      expect(corpo.get('code_verifier')).toBe('verificatore');
      expect(corpo.get('redirect_uri')).toBe('https://api.kerdon.io/auth/klaviyo/callback');
    });

    it('il rinnovo tiene il refresh token vecchio se Klaviyo non ne manda uno nuovo', async () => {
      fetchMock.mockResolvedValueOnce(risposta(200, { access_token: 'at2', expires_in: 3600 }));
      const t = await refreshTokens('rt-vecchio');
      expect(t).toMatchObject({ accessToken: 'at2', refreshToken: 'rt-vecchio' });
      const corpo = new URLSearchParams(fetchMock.mock.calls[0][1].body);
      expect(corpo.get('grant_type')).toBe('refresh_token');
      expect(corpo.get('refresh_token')).toBe('rt-vecchio');
    });

    it('invalid_grant e un errore di autorizzazione', async () => {
      fetchMock.mockResolvedValueOnce(risposta(400, { error: 'invalid_grant' }));
      await expect(refreshTokens('rt')).rejects.toBeInstanceOf(KlaviyoAuthError);
    });

    it('un 5xx o la rete giu sono un guasto passeggero, non una revoca', async () => {
      fetchMock.mockResolvedValueOnce(risposta(503, {}));
      await expect(refreshTokens('rt')).rejects.toBeInstanceOf(KlaviyoUnavailableError);
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      await expect(refreshTokens('rt')).rejects.toBeInstanceOf(KlaviyoUnavailableError);
    });

    it('la revoca non lancia mai', async () => {
      fetchMock.mockResolvedValueOnce(risposta(500, {}));
      await expect(revokeToken('rt')).resolves.toBeUndefined();
      fetchMock.mockRejectedValueOnce(new Error('rete'));
      await expect(revokeToken('rt')).resolves.toBeUndefined();

      fetchMock.mockResolvedValueOnce(risposta(200, {}));
      await revokeToken('rt');
      const [url, init] = fetchMock.mock.calls[2];
      expect(url).toBe('https://a.klaviyo.com/oauth/revoke');
      const corpo = new URLSearchParams(init.body);
      expect(corpo.get('token')).toBe('rt');
      expect(corpo.get('token_type_hint')).toBe('refresh_token');
    });
  });
});
