import { describe, it, expect, vi, beforeEach } from 'vitest';

const issueIngestKey = vi.fn();
const revokeIngestKey = vi.fn();
const revokeAllIngestKeys = vi.fn();
const listIngestKeys = vi.fn();
const findUniqueShop = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'test-shop.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) },
    // Il cancello delle capacita' legge il piano del negozio.
    plan: { findFirst: async () => ({ planName: 'growth', customersSyncEnabled: true }) },
  },
}));
vi.mock('~/lib/ingest/ingest-key.server', () => ({
  issueIngestKey: (...a: unknown[]) => issueIngestKey(...a),
  revokeIngestKey: (...a: unknown[]) => revokeIngestKey(...a),
  revokeAllIngestKeys: (...a: unknown[]) => revokeAllIngestKeys(...a),
  listIngestKeys: (...a: unknown[]) => listIngestKeys(...a),
}));

import { action } from './api.tracking.ingest-key';

function call(body: unknown, method = 'POST') {
  return action({
    request: new Request('https://app.example.com/api/tracking/ingest-key', {
      method,
      body: method === 'POST' ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json' },
    }),
    params: {},
    context: {},
  } as never) as Promise<Response>;
}

const corpo = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueShop.mockResolvedValue({
    id: 'negozio-1',
    currentPlan: 'growth',
  // Le colonne da cui la policy decide: senza, il cancello di `use_app`
  // rifiuterebbe prima ancora che il test cominci — ed e' proprio quello che
  // deve fare a un negozio fermo.
  lifecycleStatus: 'active',
  uninstalledAt: null,
  authorization: 'ENABLED',
  trackingAuthorization: 'ENABLED',
  scopes: 'read_products,write_products',
  isInTrial: false,
  trialEndsAt: null,
  activeChargeId: null,
  });
  issueIngestKey.mockResolvedValue({
    value: 'kin_pubblico.segretissimo',
    keyId: 'pubblico',
    secret: 'segretissimo',
  });
  revokeIngestKey.mockResolvedValue(true);
  revokeAllIngestKeys.mockResolvedValue(2);
  listIngestKeys.mockResolvedValue([
    {
      id: 'riga-1',
      keyId: 'pubblico',
      scopes: ['ingest:identity'],
      issuedAt: new Date('2026-09-11T12:00:00.000Z'),
      supersededAt: null,
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    },
  ]);
});

describe('emettere la chiave di invio', () => {
  it('il valore esce una volta sola, qui', async () => {
    const risposta = await call({ intent: 'issue' });
    const body = await corpo(risposta);

    expect(risposta.status).toBe(200);
    expect(body.value).toBe('kin_pubblico.segretissimo');
    // E con quanto tempo resta per pubblicarlo prima che la vecchia scada.
    expect(typeof body.previousValidUntil).toBe('string');
  });

  it('l elenco che torna non contiene ne il valore ne il segreto', async () => {
    // E' la sola cosa che la schermata rilegge a ogni apertura: se il segreto
    // passasse di qui, la chiave non sarebbe piu' "mostrata una volta sola".
    const body = await corpo(await call({ intent: 'issue' }));
    const elenco = JSON.stringify(body.keys);

    expect(elenco).not.toContain('segretissimo');
    expect(elenco).not.toContain('kin_pubblico.segretissimo');
    expect(elenco).toContain('pubblico');
  });
});

describe('revocare', () => {
  it('una sola credenziale quando si sa quale', async () => {
    const body = await corpo(await call({ intent: 'revoke', keyId: 'pubblico' }));

    expect(revokeIngestKey).toHaveBeenCalledWith('negozio-1', 'pubblico', expect.any(Date));
    expect(revokeAllIngestKeys).not.toHaveBeenCalled();
    expect(body.revoked).toBe(1);
  });

  it('tutte quando non si sa: e il caso del "l ho persa"', async () => {
    // Chi non sa dove sia finita non sa nemmeno quale fosse, e chiedergli di
    // sceglierla da un elenco sarebbe chiedergli proprio quel che non ha.
    const body = await corpo(await call({ intent: 'revoke' }));

    expect(revokeAllIngestKeys).toHaveBeenCalledWith('negozio-1', expect.any(Date));
    expect(body.revoked).toBe(2);
  });
});

describe('cosa la rotta non fa', () => {
  it('in GET non risponde', async () => {
    const risposta = await call(null, 'GET');
    expect(risposta.status).toBe(405);
    expect(issueIngestKey).not.toHaveBeenCalled();
  });

  // Non piu' 404 ma 403, e non e' un dettaglio: "negozio non trovato" a chi
  // chiama la rotta a mano racconta, per differenza, quali domini esistono. Un
  // negozio che non si sa chi sia non puo' fare niente, e il rifiuto e' quello.
  it('un negozio che non conosciamo non emette niente', async () => {
    findUniqueShop.mockResolvedValue(null);

    const risposta = (await call({ intent: 'issue' }).catch((e) => e)) as Response;

    expect(risposta.status).toBe(403);
    expect(issueIngestKey).not.toHaveBeenCalled();
  });

  it('un intento che non esiste non emette niente per sbaglio', async () => {
    const risposta = await call({ intent: 'ruota-tutto' });

    expect(risposta.status).toBe(400);
    expect(issueIngestKey).not.toHaveBeenCalled();
    expect(revokeAllIngestKeys).not.toHaveBeenCalled();
  });

  it('un corpo assente non vale come "emetti"', async () => {
    const risposta = await action({
      request: new Request('https://app.example.com/api/tracking/ingest-key', { method: 'POST' }),
      params: {},
      context: {},
    } as never) as Response;

    expect(risposta.status).toBe(400);
    expect(issueIngestKey).not.toHaveBeenCalled();
  });
});
