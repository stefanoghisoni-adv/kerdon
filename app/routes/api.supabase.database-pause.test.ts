// app/routes/api.supabase.database-pause.test.ts
//
// Il pulsante "Riattiva database": che cosa risponde al merchant in ognuno dei
// modi in cui puo' non funzionare, e che cosa resta scritto dopo il clic.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const readDatabasePause = vi.fn();
const noteResumeRequested = vi.fn();
const noteResumeBlocked = vi.fn();
const getValidAccessToken = vi.fn();
const restoreProject = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'negozio.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: { shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) } },
}));
vi.mock('~/lib/supabase/database-pause.server', () => ({
  readDatabasePause: (...a: unknown[]) => readDatabasePause(...a),
  noteResumeRequested: (...a: unknown[]) => noteResumeRequested(...a),
  noteResumeBlocked: (...a: unknown[]) => noteResumeBlocked(...a),
}));
vi.mock('~/lib/supabase-oauth.server', () => ({
  getValidAccessToken: (...a: unknown[]) => getValidAccessToken(...a),
}));
vi.mock('~/lib/supabase-management.server', async (importOriginal) => ({
  // Errori e URL restano quelli veri: il riconoscimento del caso "credenziale
  // morta" e' meta' di cio' che questo file prova.
  ...(await importOriginal<typeof import('~/lib/supabase-management.server')>()),
  restoreProject: (...a: unknown[]) => restoreProject(...a),
}));

import { SupabaseApiError, SupabaseTokenError } from '~/lib/supabase-management.server';
import { action, loader } from './api.supabase.database-pause';

const REF = 'refdelmerchant0000';
const DASHBOARD = `https://supabase.com/dashboard/project/${REF}/editor`;

const chiedi = () =>
  loader({
    request: new Request('https://app/api/supabase/database-pause'),
    params: {},
    context: {},
  } as never);

const premi = () =>
  action({
    request: new Request('https://app/api/supabase/database-pause', { method: 'POST' }),
    params: {},
    context: {},
  } as never);

/**
 * Il corpo della risposta, letto come lo legge il browser.
 *
 * L'action risponde con forme diverse a seconda del rifiuto — ed e' il punto:
 * ogni caso ha il suo messaggio. Qui si guarda il JSON per quello che e', senza
 * far dipendere la prova dall'unione di tipi che il compilatore ne ricava.
 */
const corpo = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueShop.mockResolvedValue({
    id: 'shop-1',
    supabaseConfig: { supabaseProjectRef: REF },
  });
  getValidAccessToken.mockResolvedValue('token');
  readDatabasePause.mockResolvedValue(null);
  noteResumeRequested.mockResolvedValue(undefined);
  noteResumeBlocked.mockResolvedValue(undefined);
});

describe('lo stato che il banner legge', () => {
  it('database acceso: niente da segnalare e nessun pulsante', async () => {
    const body = await corpo(await chiedi());
    expect(body.availability).toBe('attivo');
    expect(body.canResume).toBe(false);
  });

  it('database in pausa: pulsante offerto, e comunque la strada alternativa', async () => {
    readDatabasePause.mockResolvedValue({
      status: 'INACTIVE',
      availability: 'in-pausa',
      checkedAt: new Date().toISOString(),
    });

    const body = await corpo(await chiedi());

    expect(body.availability).toBe('in-pausa');
    expect(body.canResume).toBe(true);
    // Il link c'e' anche quando il pulsante c'e': se la riattivazione
    // dall'app non riesce, l'altra strada deve essere gia' davanti agli occhi.
    expect(body.dashboardUrl).toBe(DASHBOARD);
  });

  it('riattivazione gia chiesta: nessun pulsante da premere di nuovo', async () => {
    readDatabasePause.mockResolvedValue({
      status: 'INACTIVE',
      availability: 'in-pausa',
      checkedAt: new Date().toISOString(),
      resumeRequestedAt: new Date().toISOString(),
    });

    const body = await corpo(await chiedi());

    expect(body.availability).toBe('in-riattivazione');
    expect(body.canResume).toBe(false);
  });

  it('senza un database collegato non c e niente in pausa', async () => {
    findUniqueShop.mockResolvedValue({ id: 'shop-1', supabaseConfig: null });

    const body = await corpo(await chiedi());

    expect(body.availability).toBe('attivo');
    expect(body.dashboardUrl).toBeNull();
  });
});

describe('il clic sul pulsante', () => {
  it('riattivazione accettata: si dice in corso, non fatta', async () => {
    restoreProject.mockResolvedValue(undefined);

    const res = await premi();
    const body = await corpo(res);

    expect(restoreProject).toHaveBeenCalledWith('token', REF);
    expect(body.ok).toBe(true);
    // Non "riattivato": Supabase ha accettato la richiesta e ci mettera' dei
    // minuti. Dire "fatto" qui sarebbe la bugia piu' facile da raccontare.
    expect(body.availability).toBe('in-riattivazione');
  });

  it('il clic resta scritto sul server, non nella pagina', async () => {
    restoreProject.mockResolvedValue(undefined);

    await premi();

    // E' questo che sopravvive al cambio di scheda: senza, tornando indietro il
    // merchant ritroverebbe il pulsante acceso sopra una riattivazione in corso.
    expect(noteResumeRequested).toHaveBeenCalledWith('shop-1', 'INACTIVE');
  });
});

describe('ogni modo di fallire ha la sua risposta', () => {
  it('403: il pulsante non tornera a funzionare, e il banner porta alla dashboard', async () => {
    restoreProject.mockRejectedValue(new SupabaseApiError('403', 403, 'forbidden'));

    const res = await premi();
    const body = await corpo(res);

    expect(body.code).toBe('no_permission');
    expect(body.dashboardUrl).toBe(DASHBOARD);
    // Si scrive, cosi' il banner smette di offrire un gesto che fallisce:
    // un pulsante che non riattiva niente e' peggio di nessun pulsante.
    expect(noteResumeBlocked).toHaveBeenCalledWith('shop-1', 'no_permission');
  });

  it('429: si riprova fra poco, e il pulsante NON si spegne', async () => {
    restoreProject.mockRejectedValue(new SupabaseApiError('429', 429, 'rate limited'));

    const res = await premi();
    const body = await corpo(res);

    expect(res.status).toBe(429);
    expect(body.code).toBe('rate_limited');
    // E' l'unico rifiuto che passa da solo: toglierlo per un'attesa di qualche
    // minuto lascerebbe il merchant senza il gesto proprio quando basta
    // ripeterlo.
    expect(noteResumeBlocked).not.toHaveBeenCalled();
  });

  it('401: il collegamento non vale piu, e va rifatto', async () => {
    restoreProject.mockRejectedValue(new SupabaseApiError('401', 401, 'unauthorized'));

    const body = await corpo(await premi());

    expect(body.code).toBe('reconnect');
    expect(noteResumeBlocked).toHaveBeenCalledWith('shop-1', 'reconnect');
  });

  it('credenziale morta prima ancora di chiedere: stessa strada', async () => {
    // Qui non si arriva nemmeno a Supabase: il rinnovo del permesso fallisce
    // per primo. Per il merchant e' la stessa cosa da fare — ricollegare — e
    // deve leggere la stessa frase.
    getValidAccessToken.mockRejectedValue(new SupabaseTokenError(400));

    const body = await corpo(await premi());

    expect(restoreProject).not.toHaveBeenCalled();
    expect(body.code).toBe('reconnect');
    expect(noteResumeBlocked).toHaveBeenCalledWith('shop-1', 'reconnect');
  });

  it('un guasto qualunque: si riprova, oppure si passa dalla dashboard', async () => {
    restoreProject.mockRejectedValue(new Error('rete'));

    const body = await corpo(await premi());

    expect(body.code).toBe('failed');
    expect(body.dashboardUrl).toBe(DASHBOARD);
    // Non si blocca niente: non sappiamo che sia un impedimento duraturo, e
    // spegnere il pulsante su un guasto passeggero toglierebbe al merchant
    // l'unico gesto che ha.
    expect(noteResumeBlocked).not.toHaveBeenCalled();
  });

  it('senza un database collegato non si chiede niente a nessuno', async () => {
    findUniqueShop.mockResolvedValue({ id: 'shop-1', supabaseConfig: null });

    const res = await premi();

    expect(res.status).toBe(400);
    expect(restoreProject).not.toHaveBeenCalled();
  });
});
