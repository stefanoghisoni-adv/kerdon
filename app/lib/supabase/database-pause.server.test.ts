// app/lib/supabase/database-pause.server.test.ts
//
// Dove la pausa si scopre, quanto costa scoprirla, e che cosa succede quando il
// database torna.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueConfig = vi.fn();
const findUniqueShop = vi.fn();
const getState = vi.fn();
const setState = vi.fn();
const clearState = vi.fn();
const getProject = vi.fn();
const getValidAccessToken = vi.fn();
const enqueueManualSync = vi.fn();
const triggerSyncDrain = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    supabaseConfig: { findUnique: (...a: unknown[]) => findUniqueConfig(...a) },
    shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) },
  },
}));
vi.mock('~/lib/cache/database-pause-cache.server', () => ({
  getDatabasePauseState: (...a: unknown[]) => getState(...a),
  setDatabasePauseState: (...a: unknown[]) => setState(...a),
  clearDatabasePauseState: (...a: unknown[]) => clearState(...a),
}));
vi.mock('~/lib/supabase-oauth.server', () => ({
  getValidAccessToken: (...a: unknown[]) => getValidAccessToken(...a),
}));
vi.mock('~/lib/queue/trigger.server', () => ({
  enqueueManualSync: (...a: unknown[]) => enqueueManualSync(...a),
  triggerSyncDrain: (...a: unknown[]) => triggerSyncDrain(...a),
}));
vi.mock('~/lib/supabase-management.server', async (importOriginal) => ({
  // `isSupabaseCredentialDead` e `SupabaseTokenError` restano quelli veri: qui
  // si prova che il caso della credenziale morta venga riconosciuto davvero,
  // non che una finta risponda di si'.
  ...(await importOriginal<typeof import('~/lib/supabase-management.server')>()),
  getProject: (...a: unknown[]) => getProject(...a),
}));

import { SupabaseTokenError } from '~/lib/supabase-management.server';
import {
  noteDatabaseUnreachable,
  noteDatabaseUnreachableForShop,
  noteResumeRequested,
  readDatabasePause,
} from './database-pause.server';

const ORA = '2026-09-18T12:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(ORA));
  findUniqueConfig.mockResolvedValue({ supabaseProjectRef: 'refdelmerchant0000' });
  getValidAccessToken.mockResolvedValue('token');
  getState.mockResolvedValue(null);
  setState.mockResolvedValue(undefined);
  clearState.mockResolvedValue(undefined);
  enqueueManualSync.mockResolvedValue(undefined);
});

describe('la pausa si scopre da un fallimento, non da un loader', () => {
  it('una lettura fallita porta a chiedere lo stato, e la pausa viene scritta', () => {
    getProject.mockResolvedValue({ status: 'INACTIVE' });

    return noteDatabaseUnreachable('shop-1').then(() => {
      expect(getProject).toHaveBeenCalledWith('token', 'refdelmerchant0000');
      expect(setState).toHaveBeenCalledWith('shop-1', {
        status: 'INACTIVE',
        availability: 'in-pausa',
        checkedAt: ORA,
        resumeRequestedAt: null,
        resumeBlocked: null,
      });
    });
  });

  it('un progetto sano non lascia niente dietro di se', async () => {
    // Una lettura puo' fallire per mille ragioni che non sono la pausa. Se il
    // progetto sta bene, non deve restare acceso nessun avviso.
    getProject.mockResolvedValue({ status: 'ACTIVE_HEALTHY' });

    await noteDatabaseUnreachable('shop-1');

    expect(clearState).toHaveBeenCalledWith('shop-1');
    expect(setState).not.toHaveBeenCalled();
  });

  it('gia chiesto da poco: a Supabase non si torna', async () => {
    // IL FRENO. La dashboard ricarica le sue card a raffica: senza, un database
    // fermo produrrebbe una chiamata a Supabase per ogni giro.
    getState.mockResolvedValue({
      status: 'INACTIVE',
      availability: 'in-pausa',
      checkedAt: new Date(Date.now() - 10_000).toISOString(),
    });

    await noteDatabaseUnreachable('shop-1');

    expect(getProject).not.toHaveBeenCalled();
  });

  it('senza un progetto collegato non si chiede niente', async () => {
    findUniqueConfig.mockResolvedValue(null);

    await noteDatabaseUnreachable('shop-1');

    expect(getProject).not.toHaveBeenCalled();
  });

  it('un guasto dentro la rilevazione non risale mai a chi la chiama', async () => {
    // Chi chiama sta gia' dentro un `catch`: un secondo errore li' dentro
    // trasformerebbe una card vuota in una pagina rotta.
    getProject.mockRejectedValue(new Error('rete'));

    await expect(noteDatabaseUnreachable('shop-1')).resolves.toBeUndefined();
  });

  it('dal dominio del negozio si arriva allo stesso punto', async () => {
    findUniqueShop.mockResolvedValue({ id: 'shop-1' });
    getProject.mockResolvedValue({ status: 'INACTIVE' });

    await noteDatabaseUnreachableForShop('negozio.myshopify.com');

    expect(setState).toHaveBeenCalledWith('shop-1', expect.objectContaining({ availability: 'in-pausa' }));
  });
});

describe('il ritorno del database', () => {
  it('da fermo ad attivo la sincronizzazione riparte da sola', async () => {
    // Il merchant ha premuto il pulsante e se n'e' andato: quando il database
    // torna, chiedergli un secondo gesto per avere i dati aggiornati vorrebbe
    // dire fargli pagare il fatto che la riattivazione duri dei minuti.
    getState.mockResolvedValue({
      status: 'INACTIVE',
      availability: 'in-pausa',
      checkedAt: new Date(Date.now() - 120_000).toISOString(),
      resumeRequestedAt: new Date(Date.now() - 120_000).toISOString(),
    });
    getProject.mockResolvedValue({ status: 'ACTIVE_HEALTHY' });

    await readDatabasePause('shop-1');

    expect(enqueueManualSync).toHaveBeenCalledWith('shop-1');
    expect(triggerSyncDrain).toHaveBeenCalledWith('shop-1');
    expect(clearState).toHaveBeenCalledWith('shop-1');
  });

  it('un database che era gia attivo non accoda niente', async () => {
    getState.mockResolvedValue(null);

    await readDatabasePause('shop-1');

    expect(getProject).not.toHaveBeenCalled();
    expect(enqueueManualSync).not.toHaveBeenCalled();
  });

  it('finche resta fermo si ricontrolla, ma non piu di una volta al minuto', async () => {
    getState.mockResolvedValue({
      status: 'INACTIVE',
      availability: 'in-pausa',
      checkedAt: new Date(Date.now() - 5_000).toISOString(),
    });

    await readDatabasePause('shop-1');

    expect(getProject).not.toHaveBeenCalled();
  });
});

describe('il collegamento che non vale piu', () => {
  it('il pulsante smette di essere offerto, e lo stato non viene inventato', async () => {
    getState.mockResolvedValue({
      status: 'INACTIVE',
      availability: 'in-pausa',
      checkedAt: new Date(Date.now() - 120_000).toISOString(),
    });
    getValidAccessToken.mockRejectedValue(new SupabaseTokenError(401));

    const state = await readDatabasePause('shop-1');

    expect(state?.resumeBlocked).toBe('reconnect');
    // Resta "in pausa": non sappiamo niente di nuovo sul progetto, e
    // dichiararlo attivo o riattivabile sarebbe inventare.
    expect(state?.availability).toBe('in-pausa');
  });

  it('un guasto passeggero lascia tutto comera', async () => {
    const precedente = {
      status: 'INACTIVE',
      availability: 'in-pausa' as const,
      checkedAt: new Date(Date.now() - 120_000).toISOString(),
    };
    getState.mockResolvedValue(precedente);
    getProject.mockRejectedValue(new Error('502'));

    const state = await readDatabasePause('shop-1');

    expect(state).toEqual(precedente);
    expect(setState).not.toHaveBeenCalled();
  });
});

describe('la richiesta di riattivazione e un fatto scritto sul server', () => {
  it('il clic si segna con la sua ora, non nella pagina', async () => {
    getState.mockResolvedValue({
      status: 'INACTIVE',
      availability: 'in-pausa',
      checkedAt: ORA,
    });

    await noteResumeRequested('shop-1', 'INACTIVE');

    expect(setState).toHaveBeenCalledWith('shop-1', {
      status: 'INACTIVE',
      availability: 'in-pausa',
      checkedAt: ORA,
      resumeRequestedAt: ORA,
      resumeBlocked: null,
    });
  });

  it('una rilettura successiva non perde il clic', async () => {
    // Se la rilettura buttasse via la data, il banner tornerebbe a dire "in
    // pausa" con il pulsante acceso appena Supabase risponde ancora INACTIVE —
    // cioe' quasi subito.
    getState.mockResolvedValue({
      status: 'INACTIVE',
      availability: 'in-pausa',
      checkedAt: new Date(Date.now() - 120_000).toISOString(),
      resumeRequestedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    getProject.mockResolvedValue({ status: 'INACTIVE' });

    const state = await readDatabasePause('shop-1');

    expect(state?.resumeRequestedAt).toBe(new Date(Date.now() - 60_000).toISOString());
  });
});
