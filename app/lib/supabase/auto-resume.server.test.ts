// app/lib/supabase/auto-resume.server.test.ts
//
// Il giro vero: a chi si chiede lo stato, a chi non lo si chiede affatto, e che
// cosa resta scritto dopo aver riacceso il database di qualcuno.
//
// La policy sui negozi NON e' finta qui dentro: `capabilities.ts` resta quello
// vero, perche' la cosa da provare e' che un negozio disinstallato o in
// cancellazione non venga toccato davvero — non che una finta risponda di no.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findManyShops = vi.fn();
const findManyPlans = vi.fn();
const findFirstSyncJob = vi.fn();
const readAutoResumeSettings = vi.fn();
const noteAutoResumeChecked = vi.fn();
const noteAutoResumeRequested = vi.fn();
const noteAutoResumeFailed = vi.fn();
const resetAutoResumeAttempts = vi.fn();
const getDatabasePauseState = vi.fn();
const refreshDatabasePauseState = vi.fn();
const noteResumeRequested = vi.fn();
const noteResumeBlocked = vi.fn();
const getValidAccessToken = vi.fn();
const restoreProject = vi.fn();
const notifyAutoResume = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findMany: (...a: unknown[]) => findManyShops(...a) },
    plan: { findMany: (...a: unknown[]) => findManyPlans(...a) },
    syncJob: { findFirst: (...a: unknown[]) => findFirstSyncJob(...a) },
  },
}));
vi.mock('./auto-resume-setting.server', () => ({
  readAutoResumeSettings: (...a: unknown[]) => readAutoResumeSettings(...a),
  noteAutoResumeChecked: (...a: unknown[]) => noteAutoResumeChecked(...a),
  noteAutoResumeRequested: (...a: unknown[]) => noteAutoResumeRequested(...a),
  noteAutoResumeFailed: (...a: unknown[]) => noteAutoResumeFailed(...a),
  resetAutoResumeAttempts: (...a: unknown[]) => resetAutoResumeAttempts(...a),
}));
vi.mock('~/lib/cache/database-pause-cache.server', () => ({
  getDatabasePauseState: (...a: unknown[]) => getDatabasePauseState(...a),
}));
vi.mock('./database-pause.server', () => ({
  refreshDatabasePauseState: (...a: unknown[]) => refreshDatabasePauseState(...a),
  noteResumeRequested: (...a: unknown[]) => noteResumeRequested(...a),
  noteResumeBlocked: (...a: unknown[]) => noteResumeBlocked(...a),
}));
vi.mock('~/lib/supabase-oauth.server', () => ({
  getValidAccessToken: (...a: unknown[]) => getValidAccessToken(...a),
}));
vi.mock('~/lib/supabase-management.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/supabase-management.server')>()),
  restoreProject: (...a: unknown[]) => restoreProject(...a),
}));
vi.mock('./auto-resume-notice.server', () => ({
  notifyAutoResume: (...a: unknown[]) => notifyAutoResume(...a),
}));

import { SupabaseApiError, SupabaseTokenError } from '~/lib/supabase-management.server';
import { runAutoResume } from './auto-resume.server';

const ORA = new Date('2026-09-18T12:00:00.000Z');
const REF = 'refdelmerchant0000';
const giorniFa = (n: number) => new Date(ORA.getTime() - n * 86_400_000);

/** Un negozio sano e operativo, con il collegamento verificato molto tempo fa. */
function negozio(over: Record<string, unknown> = {}) {
  return {
    id: 'shop-1',
    shopDomain: 'negozio.myshopify.com',
    lifecycleStatus: 'active',
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products,read_orders',
    currentPlan: 'Pro',
    isInTrial: false,
    trialEndsAt: null,
    activeChargeId: 'gid://charge/1',
    supabaseConfig: { connectionVerifiedAt: giorniFa(200), supabaseProjectRef: REF },
    ...over,
  };
}

/** Lo stato di un database fermo, appena riletto da Supabase. */
const IN_PAUSA = {
  status: 'INACTIVE',
  availability: 'in-pausa' as const,
  checkedAt: ORA.toISOString(),
  resumeRequestedAt: null,
  resumeBlocked: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  findManyShops.mockResolvedValue([negozio()]);
  findManyPlans.mockResolvedValue([
    { planName: 'Pro', customersSyncEnabled: true, productFeedsEnabled: true, trialDays: null },
  ]);
  // Nessuna corsa riuscita: la prova di vita e' la verifica del collegamento.
  findFirstSyncJob.mockResolvedValue(null);
  readAutoResumeSettings.mockResolvedValue(
    new Map([['shop-1', { enabled: null, lastAttemptAt: null, attempts: 0 }]]),
  );
  getDatabasePauseState.mockResolvedValue(null);
  refreshDatabasePauseState.mockResolvedValue(IN_PAUSA);
  getValidAccessToken.mockResolvedValue('token');
  restoreProject.mockResolvedValue(undefined);
  for (const m of [
    noteAutoResumeChecked,
    noteAutoResumeRequested,
    noteAutoResumeFailed,
    resetAutoResumeAttempts,
    noteResumeRequested,
    noteResumeBlocked,
    notifyAutoResume,
  ]) {
    m.mockResolvedValue(undefined);
  }
});

describe('il database fermo da troppo lo riaccende l app', () => {
  it('lo riattiva, lo segna, e lo mette in conto per dirlo al merchant', async () => {
    const report = await runAutoResume(ORA);

    expect(restoreProject).toHaveBeenCalledWith('token', REF);
    expect(report.riattivati).toBe(1);
    // `true` = a premere e' stata l'app: e' cio' che fa cambiare il testo del
    // banner, che e' l'unico modo in cui il merchant lo viene a sapere.
    expect(noteResumeRequested).toHaveBeenCalledWith('shop-1', 'INACTIVE', true);
    expect(noteAutoResumeRequested).toHaveBeenCalledWith('shop-1', ORA);
    expect(notifyAutoResume).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-1', shopDomain: 'negozio.myshopify.com' }),
    );
  });

  it('un database fermo da poco non viene nemmeno chiesto a Supabase', async () => {
    findManyShops.mockResolvedValue([
      negozio({ supabaseConfig: { connectionVerifiedAt: giorniFa(3), supabaseProjectRef: REF } }),
    ]);

    const report = await runAutoResume(ORA);

    expect(refreshDatabasePauseState).not.toHaveBeenCalled();
    expect(restoreProject).not.toHaveBeenCalled();
    expect(report.interrogati).toBe(0);
  });

  it('l ultima sincronizzazione riuscita e una prova di vita, e conta', async () => {
    // Collegamento verificato duecento giorni fa ma sincronizzato ieri: il
    // database rispondeva ieri, quindi non c'e' niente da riaccendere.
    findFirstSyncJob.mockResolvedValue({ completedAt: giorniFa(1) });

    await runAutoResume(ORA);

    expect(refreshDatabasePauseState).not.toHaveBeenCalled();
  });
});

describe('chi non va toccato', () => {
  it('il negozio che ha disinstallato non viene interrogato ne riattivato', async () => {
    findManyShops.mockResolvedValue([negozio({ uninstalledAt: giorniFa(10) })]);

    const report = await runAutoResume(ORA);

    expect(refreshDatabasePauseState).not.toHaveBeenCalled();
    expect(restoreProject).not.toHaveBeenCalled();
    expect(report.interrogati).toBe(0);
  });

  it('il negozio in cancellazione nemmeno', async () => {
    // La cancellazione e' la ragione piu' definitiva di tutte: di questo
    // negozio non deve restare niente, figurarsi un database riacceso.
    findManyShops.mockResolvedValue([negozio({ lifecycleStatus: 'erasing' })]);

    await runAutoResume(ORA);

    expect(refreshDatabasePauseState).not.toHaveBeenCalled();
    expect(restoreProject).not.toHaveBeenCalled();
  });

  it('il negozio la cui autorizzazione e decaduta nemmeno', async () => {
    findManyShops.mockResolvedValue([negozio({ authorization: 'PENDING' })]);

    await runAutoResume(ORA);

    expect(restoreProject).not.toHaveBeenCalled();
  });

  it('il negozio con la prova finita e senza abbonamento nemmeno', async () => {
    findManyShops.mockResolvedValue([
      negozio({ isInTrial: true, trialEndsAt: giorniFa(5), activeChargeId: null }),
    ]);

    await runAutoResume(ORA);

    expect(restoreProject).not.toHaveBeenCalled();
  });
});

describe('l interruttore e il freno', () => {
  it('interruttore spento: non si chiede niente a nessuno', async () => {
    readAutoResumeSettings.mockResolvedValue(
      new Map([['shop-1', { enabled: false, lastAttemptAt: null, attempts: 0 }]]),
    );

    const report = await runAutoResume(ORA);

    expect(refreshDatabasePauseState).not.toHaveBeenCalled();
    expect(restoreProject).not.toHaveBeenCalled();
    expect(report.interrogati).toBe(0);
  });

  it('senza un posto dove leggere le scelte il giro non parte', async () => {
    // E' lo stato normale fra il rilascio del codice e l'esecuzione della
    // migrazione. Il difetto da evitare e' il suo opposto: riattivare tutti
    // "tanto nessuno ha detto di no", quando nessuno ha nemmeno potuto dirlo.
    readAutoResumeSettings.mockResolvedValue(null);

    const report = await runAutoResume(ORA);

    expect(report.nonConfigurato).toBe(true);
    expect(refreshDatabasePauseState).not.toHaveBeenCalled();
    expect(restoreProject).not.toHaveBeenCalled();
  });

  it('tentato da poco: non si torna a bussare', async () => {
    readAutoResumeSettings.mockResolvedValue(
      new Map([
        ['shop-1', { enabled: null, lastAttemptAt: new Date(ORA.getTime() - 60_000), attempts: 0 }],
      ]),
    );

    await runAutoResume(ORA);

    expect(refreshDatabasePauseState).not.toHaveBeenCalled();
    expect(restoreProject).not.toHaveBeenCalled();
  });

  it('tentativi esauriti: si guarda ma non si preme piu', async () => {
    readAutoResumeSettings.mockResolvedValue(
      new Map([['shop-1', { enabled: null, lastAttemptAt: null, attempts: 10 }]]),
    );

    await runAutoResume(ORA);

    expect(restoreProject).not.toHaveBeenCalled();
    // Il passaggio si segna comunque: senza, il giro successivo ripartirebbe da
    // capo mezz'ora dopo.
    expect(noteAutoResumeChecked).toHaveBeenCalledWith('shop-1', ORA);
  });

  it('una riattivazione gia in corso non si richiede', async () => {
    refreshDatabasePauseState.mockResolvedValue({
      ...IN_PAUSA,
      availability: 'in-riattivazione',
      status: 'RESTORING',
    });

    await runAutoResume(ORA);

    expect(restoreProject).not.toHaveBeenCalled();
  });

  it('se Supabase non ha risposto non si preme al buio', async () => {
    // `refreshDatabasePauseState` restituisce quel che gia' si sapeva quando la
    // lettura fallisce: agire su quello vorrebbe dire chiedere la riattivazione
    // di un progetto che magari e' tornato su da settimane.
    refreshDatabasePauseState.mockResolvedValue({
      ...IN_PAUSA,
      checkedAt: giorniFa(2).toISOString(),
    });

    await runAutoResume(ORA);

    expect(restoreProject).not.toHaveBeenCalled();
    expect(noteAutoResumeChecked).toHaveBeenCalledWith('shop-1', ORA);
  });

  it('database tornato attivo: il budget dei tentativi si azzera', async () => {
    refreshDatabasePauseState.mockResolvedValue(null);

    await runAutoResume(ORA);

    expect(resetAutoResumeAttempts).toHaveBeenCalledWith('shop-1', ORA);
    expect(restoreProject).not.toHaveBeenCalled();
  });
});

describe('quando Supabase rifiuta', () => {
  it('il rifiuto conta come tentativo', async () => {
    restoreProject.mockRejectedValue(new SupabaseApiError('429', 429, ''));

    const report = await runAutoResume(ORA);

    expect(report.rifiutati).toBe(1);
    expect(noteAutoResumeFailed).toHaveBeenCalledWith('shop-1', ORA);
    // 429 passa da solo: il pulsante nel banner non si spegne.
    expect(noteResumeBlocked).not.toHaveBeenCalled();
  });

  it('senza permesso il banner smette di offrire il pulsante', async () => {
    restoreProject.mockRejectedValue(new SupabaseApiError('403', 403, ''));

    await runAutoResume(ORA);

    expect(noteResumeBlocked).toHaveBeenCalledWith('shop-1', 'no_permission');
    expect(noteResumeRequested).not.toHaveBeenCalled();
  });

  it('collegamento decaduto: si chiede di ricollegare, e c e ancora tempo', async () => {
    getValidAccessToken.mockRejectedValue(new SupabaseTokenError(401));

    await runAutoResume(ORA);

    expect(noteResumeBlocked).toHaveBeenCalledWith('shop-1', 'reconnect');
    expect(noteAutoResumeFailed).toHaveBeenCalledWith('shop-1', ORA);
  });

  it('un negozio che fallisce non ferma gli altri', async () => {
    findManyShops.mockResolvedValue([
      negozio({ id: 'shop-1', shopDomain: 'uno.myshopify.com' }),
      negozio({ id: 'shop-2', shopDomain: 'due.myshopify.com' }),
    ]);
    readAutoResumeSettings.mockResolvedValue(
      new Map([
        ['shop-1', { enabled: null, lastAttemptAt: null, attempts: 0 }],
        ['shop-2', { enabled: null, lastAttemptAt: null, attempts: 0 }],
      ]),
    );
    refreshDatabasePauseState
      .mockRejectedValueOnce(new Error('rete'))
      .mockResolvedValue(IN_PAUSA);

    const report = await runAutoResume(ORA);

    expect(report.errori).toHaveLength(1);
    expect(report.riattivati).toBe(1);
  });
});
