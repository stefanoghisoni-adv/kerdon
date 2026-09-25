import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const findUniqueSetup = vi.fn();
const updateSetup = vi.fn();
const verifyTrackingEndpoint = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'test-shop.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) },
    // Il cancello delle capacita' legge il piano del negozio: senza questa
    // riga la rotta rifiuterebbe per un motivo che non c'entra con la verifica.
    plan: { findFirst: async () => ({ planName: 'growth', customersSyncEnabled: true }) },
    trackingSetup: {
      findUnique: (...a: unknown[]) => findUniqueSetup(...a),
      update: (...a: unknown[]) => updateSetup(...a),
    },
  },
}));
vi.mock('~/lib/tracking/verify-endpoint.server', () => ({
  verifyTrackingEndpoint: (...a: unknown[]) => verifyTrackingEndpoint(...a),
}));

import { action } from './api.tracking.verify';
import { readInstallState } from '~/lib/tracking/install';

const ENDPOINT = 'https://negozio.it/kerdon/id';

const call = () =>
  action({
    request: new Request('https://app.example.com/api/tracking/verify', { method: 'POST' }),
    params: {},
    context: {},
  } as never) as Promise<Response>;

/** Il corpo, senza il tipo dell'unione: qui si guarda l'esito o l'errore. */
const bodyOf = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

/** Quel che la rotta ha scritto sulla riga. */
const written = () => updateSetup.mock.calls[0][0].data;

const configured = (verifiedAt: Date | null = null) => ({
  installPath: 'sgtm',
  endpoint: ENDPOINT,
  verifiedAt,
});

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueShop.mockResolvedValue({
    id: 'shop-1',
    primaryDomain: 'negozio.it',
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
  findUniqueSetup.mockResolvedValue(configured());
  updateSetup.mockResolvedValue({});
  verifyTrackingEndpoint.mockResolvedValue({ passed: true, checks: [] });
});

describe('la verifica dell installazione', () => {
  it('chiama l endpoint registrato, non uno scritto nella richiesta', async () => {
    await call();
    expect(verifyTrackingEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: ENDPOINT }),
    );
  });

  it('passa il dominio della vetrina, che e quello su cui il cookie deve valere', async () => {
    await call();
    expect(verifyTrackingEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ storefrontDomain: 'negozio.it' }),
    );
  });

  it('se passa, la configurazione risulta completa', async () => {
    const body = await bodyOf(await call());
    expect(body.passed).toBe(true);
    expect(body.complete).toBe(true);
    expect(readInstallState(written()).verifiedAt).not.toBeNull();
  });

  // Dire "verificato il mese scorso" di un giro che oggi non si chiude e' peggio
  // che non dire niente: si guarda quella riga proprio per sapere se funziona
  // adesso.
  it('se non passa, cancella anche la verifica precedente', async () => {
    findUniqueSetup.mockResolvedValue(configured(new Date('2026-01-01T00:00:00.000Z')));
    verifyTrackingEndpoint.mockResolvedValue({
      passed: false,
      checks: [{ id: 'consent_missing', ok: false, reason: 'cookie_without_consent' }],
    });

    const body = await bodyOf(await call());
    expect(body.complete).toBe(false);
    expect(body.verifiedAt).toBeNull();
    expect(readInstallState(written()).verifiedAt).toBeNull();
  });

  it('restituisce i singoli controlli, non un si o un no', async () => {
    verifyTrackingEndpoint.mockResolvedValue({
      passed: false,
      checks: [{ id: 'cookie_attributes', ok: false, reason: 'cookie_not_secure' }],
    });
    const body = await bodyOf(await call());
    expect((body.checks as { reason: string }[])[0].reason).toBe('cookie_not_secure');
  });

  // Non e' una verifica fallita: e' una verifica che non e' stata fatta, e le
  // due cose vanno dette in modo diverso a chi legge.
  it('senza indirizzo non chiama niente e non scrive niente', async () => {
    findUniqueSetup.mockResolvedValue({ installPath: null, endpoint: null, verifiedAt: null });
    const response = await call();

    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('no_endpoint');
    expect(verifyTrackingEndpoint).not.toHaveBeenCalled();
    expect(updateSetup).not.toHaveBeenCalled();
  });

  // Le piattaforme stanno in una colonna loro e questa rotta non le nomina
  // nemmeno: prima vivevano nello stesso elenco della strada scelta, e ogni
  // scrittura doveva ricordarsi di riportarle indietro.
  it('non tocca le piattaforme del merchant', async () => {
    await call();
    expect(Object.keys(written())).toEqual(['installPath', 'endpoint', 'verifiedAt']);
  });
});
