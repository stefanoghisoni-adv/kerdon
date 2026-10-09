import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loader as oauthUrlLoader } from './api.integrations.klaviyo.oauth-url';
import { loader as callbackLoader } from './auth.klaviyo.callback';
import { action as connectAction } from './api.integrations.klaviyo.connect';
import { loader as providerLoader, action as providerAction } from './api.integrations.$provider';

// Mock all dependencies
vi.mock('~/shopify.server', () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      findUnique: vi.fn(),
    },
    integrationConnection: {
      findUnique: vi.fn(),
    },
    integrationImportRun: {
      findFirst: vi.fn(),
    },
    integrationConflict: {
      count: vi.fn(),
    },
    integrationFieldMapping: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('~/lib/authz/capabilities', () => ({
  can: vi.fn(() => true),
}));

vi.mock('~/lib/authz/shop-capabilities.server', () => ({
  shopCapabilities: vi.fn(() => Promise.resolve([])),
}));

vi.mock('~/lib/billing/find-plan.server', () => ({
  findPlanByName: vi.fn(),
}));

vi.mock('~/lib/integrations/klaviyo/oauth.server', () => ({
  buildAuthorizeUrl: vi.fn(),
  readState: vi.fn(),
  exchangeCode: vi.fn(),
}));

vi.mock('~/lib/integrations/klaviyo/api.server', () => ({
  accountName: vi.fn(),
  sampleProperties: vi.fn(),
  KlaviyoAuthError: class KlaviyoAuthError extends Error {
    constructor(message = 'Klaviyo auth error') {
      super(message);
      this.name = 'KlaviyoAuthError';
    }
  },
  KlaviyoUnavailableError: class KlaviyoUnavailableError extends Error {
    constructor(message = 'Klaviyo unavailable') {
      super(message);
      this.name = 'KlaviyoUnavailableError';
    }
  },
}));

vi.mock('~/lib/integrations/connections.server', () => ({
  saveConnection: vi.fn(),
  disconnect: vi.fn(),
  connectionStatus: vi.fn(),
  markNeedsReconnect: vi.fn(),
  getAccessToken: vi.fn(),
}));

vi.mock('~/lib/integrations/registry', () => ({
  getIntegration: vi.fn(),
}));

vi.mock('~/lib/i18n/server', () => ({
  dictionaryForShop: vi.fn(() => Promise.resolve({
    errors: { suspended: 'App sospesa' },
  })),
}));

import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { buildAuthorizeUrl, readState, exchangeCode } from '~/lib/integrations/klaviyo/oauth.server';
import { accountName, sampleProperties, KlaviyoAuthError, KlaviyoUnavailableError } from '~/lib/integrations/klaviyo/api.server';
import { can } from '~/lib/authz/capabilities';
import { saveConnection, disconnect, connectionStatus, markNeedsReconnect, getAccessToken } from '~/lib/integrations/connections.server';
import { getIntegration } from '~/lib/integrations/registry';

describe('api.integrations.klaviyo.oauth-url', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_APP_URL = 'https://example.com';
    process.env.KLAVIYO_CLIENT_ID = 'test-client-id';
    process.env.KLAVIYO_CLIENT_SECRET = 'test-client-secret';
  });

  it('403 se il piano non ha customersSyncEnabled', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Basic',
    } as any);
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: false,
    } as any);

    const request = new Request('https://example.com/api/integrations/klaviyo/oauth-url');
    const response = await oauthUrlLoader({ request, params: {}, context: {} });

    expect(response.status).toBe(403);
    const data = await response.json() as any;
    expect(data.error).toBeTruthy();
  });

  it('restituisce url se il piano ha customersSyncEnabled', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Growth',
    } as any);
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: true,
    } as any);
    vi.mocked(buildAuthorizeUrl).mockReturnValue('https://klaviyo.com/oauth/authorize?...');

    const request = new Request('https://example.com/api/integrations/klaviyo/oauth-url');
    const response = await oauthUrlLoader({ request, params: {}, context: {} });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.url).toBe('https://klaviyo.com/oauth/authorize?...');
    expect(buildAuthorizeUrl).toHaveBeenCalledWith('shop-1');
  });
});

describe('auth.klaviyo.callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_APP_URL = 'https://example.com';
  });

  it('non chiama mai exchangeCode o saveConnection', async () => {
    const request = new Request('https://example.com/auth/klaviyo/callback?code=test-code&state=test-state');
    await callbackLoader({ request, params: {}, context: {} });

    expect(exchangeCode).not.toHaveBeenCalled();
    expect(saveConnection).not.toHaveBeenCalled();
  });

  it('la pagina col codice non si mette in cache e non passa il referrer', async () => {
    // Il codice OAuth e' nell'URL: niente cache (browser o proxy) e niente
    // Referer verso eventuali risorse esterne.
    for (const q of ['code=test-code&state=test-state', 'error=access_denied', '']) {
      const request = new Request(`https://example.com/auth/klaviyo/callback?${q}`);
      const response = await callbackLoader({ request, params: {}, context: {} });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    }
  });

  it('forward code e state a opener via postMessage', async () => {
    const request = new Request('https://example.com/auth/klaviyo/callback?code=test-code&state=test-state');
    const response = await callbackLoader({ request, params: {}, context: {} });

    const html = await response.text();
    expect(html).toContain('window.opener.postMessage');
    expect(html).toContain('"code"');
    expect(html).toContain('"state"');
    expect(html).toContain('https://example.com');
  });

  it('gestisce error=access_denied da Klaviyo', async () => {
    const request = new Request('https://example.com/auth/klaviyo/callback?error=access_denied');
    const response = await callbackLoader({ request, params: {}, context: {} });

    const html = await response.text();
    expect(html).toContain('ok');
    expect(html).toContain('false');
    expect(html).toContain('denied');
  });
});

describe('api.integrations.klaviyo.connect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_APP_URL = 'https://example.com';
    process.env.KLAVIYO_CLIENT_ID = 'test-client-id';
    process.env.KLAVIYO_CLIENT_SECRET = 'test-client-secret';
  });

  it('400 se state scaduto', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
    } as any);
    vi.mocked(readState).mockReturnValue(null);

    const request = new Request('https://example.com/api/integrations/klaviyo/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'test-code', state: 'expired-state' }),
    });
    const response = await connectAction({ request, params: {}, context: {} });

    expect(response.status).toBe(400);
    const data = await response.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBe('expired');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('403 se state.shopId !== shop.id della sessione, senza chiamare exchangeCode', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
    } as any);
    vi.mocked(readState).mockReturnValue({
      shopId: 'shop-2',
      verifier: 'test-verifier',
    });

    const request = new Request('https://example.com/api/integrations/klaviyo/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'test-code', state: 'other-shop-state' }),
    });
    const response = await connectAction({ request, params: {}, context: {} });

    expect(response.status).toBe(403);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('scambia code e salva connessione se tutto ok', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
    } as any);
    vi.mocked(readState).mockReturnValue({
      shopId: 'shop-1',
      verifier: 'test-verifier',
    });
    vi.mocked(exchangeCode).mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: new Date(),
    });
    vi.mocked(accountName).mockResolvedValue('Test Account');

    const request = new Request('https://example.com/api/integrations/klaviyo/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'test-code', state: 'valid-state' }),
    });
    const response = await connectAction({ request, params: {}, context: {} });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.ok).toBe(true);
    expect(data.accountName).toBe('Test Account');
    expect(exchangeCode).toHaveBeenCalledWith('test-code', 'test-verifier');
    expect(saveConnection).toHaveBeenCalledWith('shop-1', expect.any(Object), 'Test Account');
  });

  it('503 se KlaviyoUnavailableError senza toccare lo stato', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
    } as any);
    vi.mocked(readState).mockReturnValue({
      shopId: 'shop-1',
      verifier: 'test-verifier',
    });
    vi.mocked(exchangeCode).mockRejectedValue(new KlaviyoUnavailableError());

    const request = new Request('https://example.com/api/integrations/klaviyo/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'test-code', state: 'valid-state' }),
    });
    const response = await connectAction({ request, params: {}, context: {} });

    expect(response.status).toBe(503);
    const data = await response.json() as any;
    expect(data.error).toBe('unavailable');
    expect(markNeedsReconnect).not.toHaveBeenCalled();
  });
});

describe('api.integrations.$provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('404 se provider sconosciuto (loader)', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(getIntegration).mockReturnValue(null);

    const request = new Request('https://example.com/api/integrations/unknown-provider');
    const response = await providerLoader({ request, params: { provider: 'unknown-provider' }, context: {} });

    expect(response.status).toBe(404);
  });

  it('404 se provider sconosciuto (action)', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(getIntegration).mockReturnValue(null);

    const request = new Request('https://example.com/api/integrations/unknown-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'disconnect' }),
    });
    const response = await providerAction({ request, params: { provider: 'unknown-provider' }, context: {} });

    expect(response.status).toBe(404);
  });

  it('restituisce status con lastRun e openConflicts', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
    } as any);
    vi.mocked(getIntegration).mockReturnValue({
      id: 'klaviyo',
      name: 'Klaviyo',
    } as any);
    vi.mocked(connectionStatus).mockResolvedValue({
      status: 'connected',
      accountName: 'Test Account',
    });
    vi.mocked(prisma.integrationImportRun.findFirst).mockResolvedValue({
      status: 'completed',
      finishedAt: new Date('2026-10-03T10:00:00Z'),
      counters: { imported: 10, skipped: 2 },
    } as any);
    vi.mocked(prisma.integrationConflict.count).mockResolvedValue(3);

    const request = new Request('https://example.com/api/integrations/klaviyo');
    const response = await providerLoader({ request, params: { provider: 'klaviyo' }, context: {} });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.status).toBe('connected');
    expect(data.accountName).toBe('Test Account');
    expect(data.mapping).toBeNull();
    expect(data.lastRun).toEqual({
      status: 'completed',
      finishedAt: '2026-10-03T10:00:00.000Z',
      counters: { imported: 10, skipped: 2 },
    });
    expect(data.openConflicts).toBe(3);
    expect(data.running).toBe(false);
  });

  it('un import partito adesso: running true', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({ id: 'shop-1', shopDomain: 'test.myshopify.com' } as any);
    vi.mocked(getIntegration).mockReturnValue({ id: 'klaviyo', name: 'Klaviyo' } as any);
    vi.mocked(connectionStatus).mockResolvedValue({ status: 'connected', accountName: 'Test Account' });
    vi.mocked(prisma.integrationImportRun.findFirst).mockResolvedValue({
      status: 'running',
      startedAt: new Date(),
      finishedAt: null,
      counters: {},
    } as any);
    vi.mocked(prisma.integrationConflict.count).mockResolvedValue(0);

    const request = new Request('https://example.com/api/integrations/klaviyo');
    const response = await providerLoader({ request, params: { provider: 'klaviyo' }, context: {} });
    const data = (await response.json()) as any;
    expect(data.running).toBe(true);
  });

  it('disconnect chiama disconnect(shopId)', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
    } as any);
    vi.mocked(getIntegration).mockReturnValue({
      id: 'klaviyo',
      name: 'Klaviyo',
    } as any);

    const request = new Request('https://example.com/api/integrations/klaviyo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'disconnect' }),
    });
    const response = await providerAction({ request, params: { provider: 'klaviyo' }, context: {} });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.ok).toBe(true);
    expect(disconnect).toHaveBeenCalledWith('shop-1');
  });

  it('status e disconnect permessi su piano downgraded (no plan gate)', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Basic',
    } as any);
    vi.mocked(getIntegration).mockReturnValue({
      id: 'klaviyo',
      name: 'Klaviyo',
    } as any);
    vi.mocked(connectionStatus).mockResolvedValue({
      status: 'connected',
      accountName: 'Test Account',
    });
    vi.mocked(prisma.integrationImportRun.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.integrationConflict.count).mockResolvedValue(0);

    // Loader (status) - deve funzionare anche senza customersSyncEnabled
    const getRequest = new Request('https://example.com/api/integrations/klaviyo');
    const getResponse = await providerLoader({ request: getRequest, params: { provider: 'klaviyo' }, context: {} });
    expect(getResponse.status).toBe(200);

    // Action (disconnect) - deve funzionare anche senza customersSyncEnabled
    const postRequest = new Request('https://example.com/api/integrations/klaviyo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'disconnect' }),
    });
    const postResponse = await providerAction({ request: postRequest, params: { provider: 'klaviyo' }, context: {} });
    expect(postResponse.status).toBe(200);
  });
});

describe('Nuovi test da review round 1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_APP_URL = 'https://example.com';
    process.env.KLAVIYO_CLIENT_ID = 'test-client-id';
    process.env.KLAVIYO_CLIENT_SECRET = 'test-client-secret';
  });

  it('oauth-url: 403 per shop sospeso', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Growth',
    } as any);
    vi.mocked(can).mockReturnValue(false); // Shop sospeso

    const request = new Request('https://example.com/api/integrations/klaviyo/oauth-url');
    const response = await oauthUrlLoader({ request, params: {}, context: {} });

    expect(response.status).toBe(403);
  });

  it('connect: 403 per piano senza customersSyncEnabled, exchangeCode mai chiamato', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Basic',
    } as any);
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: false,
    } as any);

    const request = new Request('https://example.com/api/integrations/klaviyo/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'test-code', state: 'test-state' }),
    });
    const response = await connectAction({ request, params: {}, context: {} });

    expect(response.status).toBe(403);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('connect: KlaviyoAuthError → 409 e markNeedsReconnect chiamato', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Growth',
    } as any);
    vi.mocked(can).mockReturnValue(true); // Shop non sospeso
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: true,
    } as any);
    vi.mocked(readState).mockReturnValue({
      shopId: 'shop-1',
      verifier: 'test-verifier',
    });
    vi.mocked(exchangeCode).mockRejectedValue(new KlaviyoAuthError('Token rifiutato'));

    const request = new Request('https://example.com/api/integrations/klaviyo/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'test-code', state: 'valid-state' }),
    });
    const response = await connectAction({ request, params: {}, context: {} });

    expect(response.status).toBe(409);
    const data = await response.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBe('denied');
    expect(markNeedsReconnect).toHaveBeenCalledWith('shop-1');
  });

  it('connect: JSON malformato → 400', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Growth',
    } as any);
    vi.mocked(can).mockReturnValue(true); // Shop non sospeso
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: true,
    } as any);

    const request = new Request('https://example.com/api/integrations/klaviyo/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json{',
    });
    const response = await connectAction({ request, params: {}, context: {} });

    expect(response.status).toBe(400);
    const data = await response.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBe('invalid_json');
  });

  it('callback: XSS test con </script><script>alert(1)</script>', async () => {
    const maliciousCode = '</script><script>alert(1)</script>';
    const request = new Request(`https://example.com/auth/klaviyo/callback?code=${encodeURIComponent(maliciousCode)}&state=test-state`);
    const response = await callbackLoader({ request, params: {}, context: {} });

    const html = await response.text();
    // Il raw </script><script> NON deve essere presente
    expect(html).not.toContain('</script><script>');
    // La forma escaped DEVE essere presente (come < ecc.)
    expect(html).toContain('\\u003c'); // <
    expect(html).toContain('\\u003e'); // >
  });

  it('callback: error non access_denied mappa a "failed"', async () => {
    const request = new Request('https://example.com/auth/klaviyo/callback?error=server_error');
    const response = await callbackLoader({ request, params: {}, context: {} });

    const html = await response.text();
    expect(html).toContain('"error"');
    expect(html).toContain('"failed"');
    expect(html).not.toContain('server_error'); // Raw error non deve passare
  });
});


describe('api.integrations.$provider - properties view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('403 se il piano non ha customersSyncEnabled', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Basic',
    } as any);
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: false,
    } as any);
    vi.mocked(getIntegration).mockReturnValue({ id: 'klaviyo' } as any);

    const request = new Request('https://example.com/api/integrations/klaviyo?view=properties');
    const response = await providerLoader({ request, params: { provider: 'klaviyo' }, context: {} });

    expect(response.status).toBe(403);
    const data = await response.json() as any;
    expect(data.error).toBe('plan_missing_customers_sync');
  });

  it('restituisce proprietà con date ambigue marcate', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Growth',
    } as any);
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: true,
    } as any);
    vi.mocked(getIntegration).mockReturnValue({ id: 'klaviyo' } as any);
    vi.mocked(getAccessToken).mockResolvedValue('klaviyo-token-123');
    vi.mocked(sampleProperties).mockResolvedValue({
      keys: ['Birthday', 'SignupDate', 'InvalidDate'],
      samples: {
        Birthday: ['01/02/1990', '03/04/1985', '05/06/1992'],
        SignupDate: ['2020-01-15', '2021-03-20'],
        InvalidDate: ['not-a-date', 'xyz'],
      },
    });

    const request = new Request('https://example.com/api/integrations/klaviyo?view=properties');
    const response = await providerLoader({ request, params: { provider: 'klaviyo' }, context: {} });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.properties).toBeDefined();
    expect(Array.isArray(data.properties)).toBe(true);

    // Trova Birthday
    const birthday = data.properties.find((p: any) => p.key === 'Birthday');
    expect(birthday).toBeDefined();
    expect(birthday.ambiguous).toBe(true);
    expect(birthday.samples).toBeDefined();
    expect(birthday.samples.length).toBe(3);

    // Trova SignupDate
    const signupDate = data.properties.find((p: any) => p.key === 'SignupDate');
    expect(signupDate).toBeDefined();
    expect(signupDate.ambiguous).toBe(false);
    expect(signupDate.format).toBe('YMD');

    // InvalidDate non dovrebbe esserci perché tutti i valori sono invalid
    const invalidDate = data.properties.find((p: any) => p.key === 'InvalidDate');
    expect(invalidDate).toBeUndefined();
  });

  it('401 Klaviyo → 409 e needs_reconnect', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Growth',
    } as any);
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: true,
    } as any);
    vi.mocked(getIntegration).mockReturnValue({ id: 'klaviyo' } as any);
    vi.mocked(getAccessToken).mockRejectedValue(new KlaviyoAuthError());

    const request = new Request('https://example.com/api/integrations/klaviyo?view=properties');
    const response = await providerLoader({ request, params: { provider: 'klaviyo' }, context: {} });

    expect(response.status).toBe(409);
    const data = await response.json() as any;
    expect(data.error).toBe('reconnect');
    expect(markNeedsReconnect).toHaveBeenCalledWith('shop-1');
  });

  it('503 se Klaviyo non disponibile', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Growth',
    } as any);
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: true,
    } as any);
    vi.mocked(getIntegration).mockReturnValue({ id: 'klaviyo' } as any);
    vi.mocked(getAccessToken).mockRejectedValue(new KlaviyoUnavailableError());

    const request = new Request('https://example.com/api/integrations/klaviyo?view=properties');
    const response = await providerLoader({ request, params: { provider: 'klaviyo' }, context: {} });

    expect(response.status).toBe(503);
    const data = await response.json() as any;
    expect(data.error).toBe('unavailable');
    expect(markNeedsReconnect).not.toHaveBeenCalled();
  });
});

describe('api.integrations.$provider - save-mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('403 se il piano non ha customersSyncEnabled', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Basic',
    } as any);
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: false,
    } as any);
    vi.mocked(getIntegration).mockReturnValue({ id: 'klaviyo' } as any);

    const request = new Request('https://example.com/api/integrations/klaviyo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'save-mapping',
        sourceKey: 'Birthday',
        targetField: 'birthdate',
        dateFormat: 'DMY',
      }),
    });
    const response = await providerAction({ request, params: { provider: 'klaviyo' }, context: {} });

    expect(response.status).toBe(403);
    const data = await response.json() as any;
    expect(data.error).toBe('plan_missing_customers_sync');
  });

  it('400 se targetField non è birthdate', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Growth',
    } as any);
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: true,
    } as any);
    vi.mocked(getIntegration).mockReturnValue({ id: 'klaviyo' } as any);

    const request = new Request('https://example.com/api/integrations/klaviyo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'save-mapping',
        sourceKey: 'Birthday',
        targetField: 'email',
        dateFormat: 'DMY',
      }),
    });
    const response = await providerAction({ request, params: { provider: 'klaviyo' }, context: {} });

    expect(response.status).toBe(400);
    const data = await response.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBe('invalid_target_field');
  });

  it('400 se dateFormat non valido', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Growth',
    } as any);
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: true,
    } as any);
    vi.mocked(getIntegration).mockReturnValue({ id: 'klaviyo' } as any);

    const request = new Request('https://example.com/api/integrations/klaviyo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'save-mapping',
        sourceKey: 'Birthday',
        targetField: 'birthdate',
        dateFormat: 'INVALID',
      }),
    });
    const response = await providerAction({ request, params: { provider: 'klaviyo' }, context: {} });

    expect(response.status).toBe(400);
    const data = await response.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBe('invalid_date_format');
  });

  it('400 se ambiguous=true e dateFormat è auto', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Growth',
    } as any);
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: true,
    } as any);
    vi.mocked(getIntegration).mockReturnValue({ id: 'klaviyo' } as any);

    const request = new Request('https://example.com/api/integrations/klaviyo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'save-mapping',
        sourceKey: 'Birthday',
        targetField: 'birthdate',
        dateFormat: 'auto',
        ambiguous: true,
      }),
    });
    const response = await providerAction({ request, params: { provider: 'klaviyo' }, context: {} });

    expect(response.status).toBe(400);
    const data = await response.json() as any;
    expect(data.ok).toBe(false);
    expect(data.error).toBe('ambiguous_requires_format');
  });

  it('salva mapping con successo', async () => {
    vi.mocked(authenticate.admin).mockResolvedValue({
      session: { shop: 'test.myshopify.com', accessToken: 'token' },
    } as any);
    vi.mocked(prisma.shop.findUnique).mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test.myshopify.com',
      currentPlan: 'Growth',
    } as any);
    vi.mocked(can).mockReturnValue(true);
    vi.mocked(findPlanByName).mockResolvedValue({
      customersSyncEnabled: true,
    } as any);
    vi.mocked(getIntegration).mockReturnValue({ id: 'klaviyo' } as any);
    vi.mocked(prisma.integrationFieldMapping.upsert).mockResolvedValue({} as any);

    const request = new Request('https://example.com/api/integrations/klaviyo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'save-mapping',
        sourceKey: 'Birthday',
        targetField: 'birthdate',
        dateFormat: 'DMY',
      }),
    });
    const response = await providerAction({ request, params: { provider: 'klaviyo' }, context: {} });

    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.ok).toBe(true);
    expect(prisma.integrationFieldMapping.upsert).toHaveBeenCalledWith({
      where: {
        shopId_provider_targetField: {
          shopId: 'shop-1',
          provider: 'klaviyo',
          targetField: 'birthdate',
        },
      },
      create: {
        shopId: 'shop-1',
        provider: 'klaviyo',
        sourceKey: 'Birthday',
        targetField: 'birthdate',
        dateFormat: 'DMY',
      },
      update: {
        sourceKey: 'Birthday',
        dateFormat: 'DMY',
      },
    });
  });
});
