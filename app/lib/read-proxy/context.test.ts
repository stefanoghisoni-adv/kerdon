import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const findPlanMock = vi.fn();
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: (...a: unknown[]) => findUnique(...a) },
    plan: { findFirst: (...a: unknown[]) => findPlanMock(...a) },
  },
}));
vi.mock('~/utils/crypto.server', () => ({ decrypt: (v: string) => v.replace(/^enc\(|\)$/g, '') }));

import { resolveShopReadContext, clearReadContextCache } from './context.server';

// `uninstalledAt` e `connectionVerifiedAt` non erano in questa riga finta
// perche' finora nessuno li guardava: il gate leggeva la sola colonna del
// tracciamento. Adesso la decisione passa dalla policy, che li pretende — ed e'
// giusto che il negozio di prova debba dichiararsi installato e collegato,
// invece di esserlo per omissione.
const shopRow = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  uninstalledAt: null,
  authorization: 'ENABLED',
  trackingAuthorization: 'ENABLED',
  scopes: 'read_products',
  currentPlan: 'free',
  supabaseConfig: {
    supabaseProjectRef: 'abcref',
    supabaseServiceRoleKey: 'enc(svc)',
    connectionVerifiedAt: new Date('2026-01-01T00:00:00Z'),
  },
  ...over,
});

describe('resolveShopReadContext', () => {
  beforeEach(() => {
    findUnique.mockReset();
    findPlanMock.mockReset();
    clearReadContextCache();
  });

  it('token sconosciuto → kind unknown', async () => {
    findUnique.mockResolvedValueOnce(null);
    const r = await resolveShopReadContext('spx_x');
    expect(r).toEqual({ kind: 'unknown' });
  });

  it('shop senza config → not_configured', async () => {
    findUnique.mockResolvedValueOnce(shopRow({ supabaseConfig: null }));
    const r = await resolveShopReadContext('spx_x');
    expect(r).toEqual({ kind: 'not_configured' });
  });

  it('ok → ctx con service_role decifrata e customersEnabled dal piano', async () => {
    findUnique.mockResolvedValueOnce(shopRow());
    findPlanMock.mockResolvedValueOnce({ customersSyncEnabled: true });
    const r = await resolveShopReadContext('spx_x');
    expect(r).toEqual({
      kind: 'ok',
      ctx: {
        shopId: 's1',
        trackingAuthorization: 'ENABLED',
        canReadData: true,
        projectRef: 'abcref',
        serviceRoleKey: 'svc',
        customersEnabled: true,
      },
    });
  });

  // Il gate deve fallire CHIUSO: la colonna è editata a mano dall'owner, e un
  // refuso non deve concedere accesso.
  it.each([
    ['DISABLED', false],
    ['PENDING', false],
    ['disabled', false],
    ['  ENABLED  ', true],
    ['enabled', true],
    ['DISABLD', false],
    ['BANNED', false],
    ['SUSPENDED', false],
    ['', false],
    [null, false],
  ])('trackingAuthorization %j → canReadData %s', async (value, expected) => {
    findUnique.mockResolvedValueOnce(shopRow({ trackingAuthorization: value }));
    findPlanMock.mockResolvedValueOnce({ customersSyncEnabled: false });
    const r = await resolveShopReadContext(`spx_${String(value)}`);
    expect(r.kind).toBe('ok');
    expect((r as { ctx: { canReadData: boolean } }).ctx.canReadData).toBe(expected);
  });

  // Il senso dello sdoppiamento: chi ha l'app sospesa puo' continuare a
  // tracciare con i dati gia' sincronizzati, e chi ha l'app attiva puo' avere
  // il solo tracciamento fermo.
  it('app sospesa ma tracciamento attivo → le letture passano', async () => {
    findUnique.mockResolvedValueOnce(
      shopRow({ authorization: 'DISABLED', trackingAuthorization: 'ENABLED' }),
    );
    findPlanMock.mockResolvedValueOnce({ customersSyncEnabled: false });
    const r = await resolveShopReadContext('spx_app_off');
    expect((r as { ctx: { canReadData: boolean } }).ctx.canReadData).toBe(true);
  });

  it('app attiva ma tracciamento sospeso → le letture no', async () => {
    findUnique.mockResolvedValueOnce(
      shopRow({ authorization: 'ENABLED', trackingAuthorization: 'DISABLED' }),
    );
    findPlanMock.mockResolvedValueOnce({ customersSyncEnabled: false });
    const r = await resolveShopReadContext('spx_track_off');
    expect((r as { ctx: { canReadData: boolean } }).ctx.canReadData).toBe(false);
  });

  // Il buco che questa rotta aveva: la disinstallazione non tocca la colonna
  // del tracciamento — spegne l'app — quindi il vecchio gate la lasciava
  // passare. Il token resta incollato nel container della vetrina e continuava
  // a rispondere a un negozio che se n'era andato.
  it('app disinstallata → le letture non passano, comunque stia la colonna', async () => {
    findUnique.mockResolvedValueOnce(
      shopRow({ uninstalledAt: new Date('2026-03-01T00:00:00Z'), trackingAuthorization: 'ENABLED' }),
    );
    findPlanMock.mockResolvedValueOnce({ customersSyncEnabled: false });
    const r = await resolveShopReadContext('spx_uninstalled');
    expect((r as { ctx: { canReadData: boolean } }).ctx.canReadData).toBe(false);
  });

  // Chiave e ref ci sono ma il collegamento non e' mai stato verificato: la
  // configurazione e' a meta', e con la service_role in mano non si inoltra una
  // lettura verso un progetto che non sappiamo di saper leggere.
  it('collegamento mai verificato → le letture non passano', async () => {
    findUnique.mockResolvedValueOnce(
      shopRow({
        supabaseConfig: {
          supabaseProjectRef: 'abcref',
          supabaseServiceRoleKey: 'enc(svc)',
          connectionVerifiedAt: null,
        },
      }),
    );
    findPlanMock.mockResolvedValueOnce({ customersSyncEnabled: false });
    const r = await resolveShopReadContext('spx_unverified');
    expect((r as { ctx: { canReadData: boolean } }).ctx.canReadData).toBe(false);
  });

  it('usa la cache entro il TTL (una sola query per token)', async () => {
    findUnique.mockResolvedValue(shopRow());
    findPlanMock.mockResolvedValue({ customersSyncEnabled: false });
    await resolveShopReadContext('spx_same');
    await resolveShopReadContext('spx_same');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  // I token sconosciuti sono l'unico esito che un chiamante ostile può
  // generare a volontà: cacharli gli lascerebbe far crescere la Map.
  it('non mette in cache i token sconosciuti', async () => {
    findUnique.mockResolvedValue(null);
    await resolveShopReadContext('spx_ignoto');
    await resolveShopReadContext('spx_ignoto');
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
