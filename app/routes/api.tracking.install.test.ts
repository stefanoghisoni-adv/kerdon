import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const findUniqueSetup = vi.fn();
const upsertSetup = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'test-shop.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) },
    // Il cancello delle capacita' legge il piano del negozio.
    plan: { findFirst: async () => ({ planName: 'pro', customersSyncEnabled: true }) },
    trackingSetup: {
      findUnique: (...a: unknown[]) => findUniqueSetup(...a),
      upsert: (...a: unknown[]) => upsertSetup(...a),
    },
  },
}));

import { action } from './api.tracking.install';
import { readInstallState } from '~/lib/tracking/install';

const ENDPOINT = 'https://negozio.it/kerdon/id';

function call(body: unknown, method = 'POST') {
  const request = new Request('https://app.example.com/api/tracking/install', {
    method,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
  return action({ request, params: {}, context: {} } as never) as Promise<Response>;
}

/**
 * Il corpo della risposta, senza il tipo dell'unione.
 *
 * La rotta risponde con due forme diverse — l'esito o l'errore — e da qui si
 * guarda l'una o l'altra a seconda del caso: e' esattamente cio' che il test
 * deve poter fare.
 */
const bodyOf = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

/** Cosa e' finito nella riga, qualunque ramo dell'upsert. */
const written = () => upsertSetup.mock.calls[0][0].update;

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueShop.mockResolvedValue({
    id: 'shop-1',
    currentPlan: 'pro',
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
  findUniqueSetup.mockResolvedValue({ installPath: null, endpoint: null, verifiedAt: null });
  upsertSetup.mockImplementation(async (args: { update: Record<string, unknown> }) => ({
    ...args.update,
  }));
});

describe('salvare la strada di installazione', () => {
  it('registra scelta e indirizzo', async () => {
    const response = await call({ path: 'sgtm', endpoint: ENDPOINT });
    const body = await bodyOf(response);

    expect(body.ok).toBe(true);
    expect(body.path).toBe('sgtm');
    expect(body.endpoint).toBe(ENDPOINT);
  });

  // Salvare registra un'intenzione. Che quell'indirizzo risponda, e risponda
  // bene, lo dice solo la verifica: e' la separazione che impedisce a una
  // configurazione dichiarata di passare per una funzionante.
  it('non risulta mai completa per il solo fatto di essere stata salvata', async () => {
    const body = await bodyOf(await call({ path: 'sgtm', endpoint: ENDPOINT }));
    expect(body.complete).toBe(false);
    expect(body.verifiedAt).toBeNull();
  });

  // Le piattaforme stanno in una colonna loro, e questa rotta non la nomina:
  // prima vivevano nello stesso elenco della strada scelta, e ogni scrittura
  // doveva ricordarsi di riportarle indietro per non cancellarle.
  it('non tocca le piattaforme del merchant', async () => {
    await call({ path: 'sgtm', endpoint: ENDPOINT });
    expect(Object.keys(written())).toEqual(['installPath', 'endpoint', 'verifiedAt']);
  });

  it('cambiare indirizzo annulla la verifica di prima', async () => {
    findUniqueSetup.mockResolvedValue({
      installPath: 'sgtm',
      endpoint: ENDPOINT,
      verifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await call({ path: 'sgtm', endpoint: 'https://altro.negozio.it/kerdon/id' });
    expect(readInstallState(written()).verifiedAt).toBeNull();
  });

  it('rifiuta un indirizzo che non e https', async () => {
    const response = await call({ path: 'sgtm', endpoint: 'http://negozio.it/kerdon/id' });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('invalid_endpoint');
    expect(upsertSetup).not.toHaveBeenCalled();
  });

  it('rifiuta una strada che non esiste', async () => {
    const response = await call({ path: 'fastly', endpoint: ENDPOINT });
    expect(response.status).toBe(400);
    expect((await bodyOf(response)).error).toBe('unknown_path');
  });

  it('si puo scegliere la strada prima di avere un indirizzo', async () => {
    const body = await bodyOf(await call({ path: 'sgtm' }));
    expect(body.ok).toBe(true);
    expect(body.endpoint).toBeNull();
  });

  // 403 e non 404: vedi la nota gemella in api.tracking.ingest-key.test.ts —
  // un negozio che non si e' potuto identificare non si distingue da uno che
  // non puo'.
  it('un negozio che non c e non scrive niente', async () => {
    findUniqueShop.mockResolvedValue(null);

    const response = (await call({ path: 'sgtm', endpoint: ENDPOINT }).catch(
      (e) => e,
    )) as Response;

    expect(response.status).toBe(403);
    expect(upsertSetup).not.toHaveBeenCalled();
  });
});
