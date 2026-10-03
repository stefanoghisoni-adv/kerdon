// app/lib/integrations/connections.test.ts
//
// L'archivio delle connessioni, e soprattutto il rinnovo del token sotto
// concorrenza: due richieste che rinnovano insieme possono bruciare il refresh
// token. Le istanze diverse di Vercel si simulano importando il modulo due
// volte (`vi.resetModules`): due memorie, un solo database.
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Riga {
  id: string;
  shopId: string;
  provider: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  accountName: string | null;
  status: string;
  updatedAt: Date;
}

let righe: Riga[] = [];
const refreshTokens = vi.fn();
const revokeToken = vi.fn();

function trova(where: { shopId_provider?: { shopId: string; provider: string }; shopId?: string; provider?: string }) {
  const chiave = where.shopId_provider ?? { shopId: where.shopId!, provider: where.provider! };
  return righe.find((r) => r.shopId === chiave.shopId && r.provider === chiave.provider) ?? null;
}

vi.mock('~/db.server', () => ({
  prisma: {
    integrationConnection: {
      findUnique: async ({ where }: { where: Parameters<typeof trova>[0] }) => {
        const r = trova(where);
        return r ? { ...r } : null;
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: Parameters<typeof trova>[0];
        create: Partial<Riga>;
        update: Partial<Riga>;
      }) => {
        const r = trova(where);
        if (r) Object.assign(r, update, { updatedAt: new Date() });
        else righe.push({ ...({ id: `id-${righe.length}`, accountName: null } as Partial<Riga>), ...(create as Riga), updatedAt: new Date() });
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { shopId: string; provider: string; status?: string; updatedAt?: Date };
        data: Partial<Riga>;
      }) => {
        const r = trova(where);
        if (!r) return { count: 0 };
        if (where.status !== undefined && r.status !== where.status) return { count: 0 };
        if (where.updatedAt && r.updatedAt.getTime() !== where.updatedAt.getTime()) {
          return { count: 0 };
        }
        Object.assign(r, { updatedAt: new Date() }, data);
        return { count: 1 };
      },
    },
  },
}));

vi.mock('~/utils/crypto.server', () => ({
  encrypt: (v: string) => `enc(${v})`,
  decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, '$1'),
}));

vi.mock('./klaviyo/oauth.server', () => ({
  refreshTokens: (...a: unknown[]) => refreshTokens(...a),
  revokeToken: (...a: unknown[]) => revokeToken(...a),
}));

type Modulo = typeof import('./connections.server');

async function istanza(): Promise<Modulo> {
  vi.resetModules();
  return import('./connections.server');
}

const ORA = Date.now();

function rigaInScadenza(): Riga {
  return {
    id: 'id-0',
    shopId: 'shop-1',
    provider: 'klaviyo',
    accessToken: 'enc(at-vecchio)',
    refreshToken: 'enc(rt-vecchio)',
    // Scade fra 30 s: dentro il margine di 60 s, va rinnovato.
    expiresAt: new Date(ORA + 30_000),
    accountName: 'Negozio',
    status: 'connected',
    updatedAt: new Date(ORA - 60 * 60 * 1000),
  };
}

function tokenNuovo() {
  return {
    accessToken: 'at-nuovo',
    refreshToken: 'rt-nuovo',
    expiresAt: new Date(Date.now() + 3600_000),
  };
}

describe('connessioni alle integrazioni', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    righe = [];
  });

  it('saveConnection salva i token cifrati con stato connected, e riscrive la riga esistente', async () => {
    const m = await istanza();
    await m.saveConnection('shop-1', tokenNuovo(), 'Negozio');
    expect(righe).toHaveLength(1);
    expect(righe[0]).toMatchObject({
      shopId: 'shop-1',
      provider: 'klaviyo',
      accessToken: 'enc(at-nuovo)',
      refreshToken: 'enc(rt-nuovo)',
      accountName: 'Negozio',
      status: 'connected',
    });

    righe[0].status = 'disconnected';
    await m.saveConnection('shop-1', { ...tokenNuovo(), accessToken: 'at-2' }, null);
    expect(righe).toHaveLength(1);
    expect(righe[0]).toMatchObject({ accessToken: 'enc(at-2)', status: 'connected', accountName: null });
  });

  it('getAccessToken restituisce il token buono senza rinnovarlo', async () => {
    righe = [{ ...rigaInScadenza(), expiresAt: new Date(ORA + 3600_000) }];
    const m = await istanza();
    expect(await m.getAccessToken('shop-1')).toBe('at-vecchio');
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it('getAccessToken lancia KlaviyoAuthError se non c e collegamento attivo', async () => {
    const m = await istanza();
    // Dopo `istanza()`: la classe deve essere quella del registro di moduli nuovo.
    const { KlaviyoAuthError } = await import('./klaviyo/api.server');
    await expect(m.getAccessToken('shop-1')).rejects.toBeInstanceOf(KlaviyoAuthError);
    righe = [{ ...rigaInScadenza(), status: 'needs_reconnect' }];
    await expect(m.getAccessToken('shop-1')).rejects.toBeInstanceOf(KlaviyoAuthError);
  });

  it('due chiamate concorrenti nella stessa istanza rinnovano una volta sola', async () => {
    righe = [rigaInScadenza()];
    refreshTokens.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return tokenNuovo();
    });
    const m = await istanza();
    const [a, b] = await Promise.all([m.getAccessToken('shop-1'), m.getAccessToken('shop-1')]);
    expect([a, b]).toEqual(['at-nuovo', 'at-nuovo']);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(refreshTokens).toHaveBeenCalledWith('rt-vecchio');
    expect(righe[0]).toMatchObject({ accessToken: 'enc(at-nuovo)', refreshToken: 'enc(rt-nuovo)' });
  });

  it('due istanze diverse rinnovano una volta sola: chi perde il turno aspetta il token dell altra', async () => {
    righe = [rigaInScadenza()];
    refreshTokens.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150));
      return tokenNuovo();
    });
    const a = await istanza();
    const b = await istanza();
    const [ta, tb] = await Promise.all([a.getAccessToken('shop-1'), b.getAccessToken('shop-1')]);
    expect([ta, tb]).toEqual(['at-nuovo', 'at-nuovo']);
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('refresh rifiutato da Klaviyo: needs_reconnect e KlaviyoAuthError', async () => {
    righe = [rigaInScadenza()];
    const m = await istanza();
    const { KlaviyoAuthError } = await import('./klaviyo/api.server');
    refreshTokens.mockRejectedValueOnce(new KlaviyoAuthError('invalid_grant'));
    const errore = await m.getAccessToken('shop-1').catch((e) => e);
    expect(errore).toBeInstanceOf(KlaviyoAuthError);
    expect(righe[0].status).toBe('needs_reconnect');
  });

  it('refresh fallito ma un altro ha gia salvato un token buono: si usa quello', async () => {
    righe = [rigaInScadenza()];
    const m = await istanza();
    const { KlaviyoAuthError } = await import('./klaviyo/api.server');
    refreshTokens.mockImplementationOnce(async () => {
      // Nel frattempo un'altra istanza ha salvato il suo rinnovo.
      Object.assign(righe[0], {
        accessToken: 'enc(at-altrui)',
        expiresAt: new Date(Date.now() + 3600_000),
      });
      throw new KlaviyoAuthError('invalid_grant');
    });
    expect(await m.getAccessToken('shop-1')).toBe('at-altrui');
    expect(righe[0].status).toBe('connected');
  });

  it('refresh fallito per un guasto passeggero: non chiede di ricollegare', async () => {
    righe = [rigaInScadenza()];
    const m = await istanza();
    const { KlaviyoUnavailableError } = await import('./klaviyo/api.server');
    refreshTokens.mockRejectedValueOnce(new KlaviyoUnavailableError('503'));
    await expect(m.getAccessToken('shop-1')).rejects.toBeInstanceOf(KlaviyoUnavailableError);
    expect(righe[0].status).toBe('connected');
  });

  it('markNeedsReconnect cambia solo lo stato', async () => {
    righe = [rigaInScadenza()];
    const m = await istanza();
    await m.markNeedsReconnect('shop-1');
    expect(righe[0]).toMatchObject({ status: 'needs_reconnect', accessToken: 'enc(at-vecchio)' });
  });

  it('markNeedsReconnect su una riga scollegata la lascia disconnected', async () => {
    righe = [{ ...rigaInScadenza(), status: 'disconnected', accessToken: null, refreshToken: null }];
    const m = await istanza();
    await m.markNeedsReconnect('shop-1');
    expect(righe[0].status).toBe('disconnected');
  });

  it('un rinnovo che finisce dopo il disconnect non riscrive i token', async () => {
    righe = [rigaInScadenza()];
    const m = await istanza();
    const { KlaviyoAuthError } = await import('./klaviyo/api.server');
    let finisci: (v: unknown) => void = () => {};
    refreshTokens.mockImplementationOnce(
      () => new Promise((resolve) => (finisci = () => resolve(tokenNuovo()))),
    );
    const giro = m.getAccessToken('shop-1').catch((e) => e);
    await vi.waitFor(() => expect(refreshTokens).toHaveBeenCalledTimes(1));
    await m.disconnect('shop-1');
    finisci(undefined);
    expect(await giro).toBeInstanceOf(KlaviyoAuthError);
    expect(righe[0]).toMatchObject({
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      status: 'disconnected',
    });
  });

  it('disconnect revoca il refresh token, azzera i token e lascia la riga', async () => {
    righe = [rigaInScadenza()];
    const m = await istanza();
    await m.disconnect('shop-1');
    expect(revokeToken).toHaveBeenCalledWith('rt-vecchio');
    expect(righe).toHaveLength(1);
    expect(righe[0]).toMatchObject({
      accessToken: null,
      refreshToken: null,
      expiresAt: null,
      status: 'disconnected',
      accountName: 'Negozio',
    });
  });

  it('disconnect su un negozio mai collegato non fa niente', async () => {
    const m = await istanza();
    await expect(m.disconnect('shop-1')).resolves.toBeUndefined();
    expect(revokeToken).not.toHaveBeenCalled();
  });

  it('connectionStatus', async () => {
    const m = await istanza();
    expect(await m.connectionStatus('shop-1')).toEqual({ status: 'none', accountName: null });
    righe = [rigaInScadenza()];
    expect(await m.connectionStatus('shop-1')).toEqual({ status: 'connected', accountName: 'Negozio' });
  });
});
