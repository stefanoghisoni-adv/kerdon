import { describe, it, expect } from 'vitest';
import {
  RESUME_IN_PROGRESS_WINDOW_MS,
  SUPABASE_PROJECT_STATUSES,
  classifyProjectStatus,
  databaseIsStopped,
  effectiveAvailability,
  shouldOfferResume,
  stateIsStale,
  syncShouldRestart,
  type DatabasePauseState,
} from './database-pause';

const ADESSO = new Date('2026-09-18T12:00:00.000Z');

function stato(over: Partial<DatabasePauseState> = {}): DatabasePauseState {
  return {
    status: 'INACTIVE',
    availability: 'in-pausa',
    checkedAt: ADESSO.toISOString(),
    resumeRequestedAt: null,
    resumeBlocked: null,
    ...over,
  };
}

describe('come si legge lo stato di un progetto Supabase', () => {
  it('attivo e solo ACTIVE_HEALTHY', () => {
    expect(classifyProjectStatus('ACTIVE_HEALTHY')).toBe('attivo');
  });

  it('in pausa sono INACTIVE e PAUSING', () => {
    // INACTIVE e' lo stato che la documentazione mostra per un progetto in
    // pausa. PAUSING e' la pausa che sta scendendo: li' le letture falliscono
    // gia', e aspettare il numero successivo vorrebbe dire lasciare il merchant
    // davanti alle card vuote proprio quando l'avviso serve.
    expect(classifyProjectStatus('INACTIVE')).toBe('in-pausa');
    expect(classifyProjectStatus('PAUSING')).toBe('in-pausa');
  });

  it('in riattivazione sono RESTORING e COMING_UP', () => {
    expect(classifyProjectStatus('RESTORING')).toBe('in-riattivazione');
    expect(classifyProjectStatus('COMING_UP')).toBe('in-riattivazione');
  });

  it('tutto il resto e sconosciuto: non si afferma una pausa che non si e letta', () => {
    // Questo e' il cuore della difensivita'. Un progetto che si sta
    // ridimensionando o aggiornando non e' in pausa, e un fallimento del piano
    // di controllo di Supabase non e' una cosa su cui il nostro pulsante abbia
    // presa. Dichiararli "fermi" offrirebbe al merchant un gesto che non
    // risolve; dichiararli "attivi" direbbe che la sincronizzazione sta
    // lavorando quando non e' detto.
    const noti = new Set([
      'ACTIVE_HEALTHY',
      'INACTIVE',
      'PAUSING',
      'RESTORING',
      'COMING_UP',
    ]);
    for (const s of SUPABASE_PROJECT_STATUSES) {
      if (noti.has(s)) continue;
      expect(classifyProjectStatus(s), s).toBe('sconosciuto');
    }
    // E anche un valore che l'enum non contiene affatto: una versione futura
    // dell'API non deve poter accendere un allarme per conto suo.
    expect(classifyProjectStatus('QUALCOSA_DI_NUOVO')).toBe('sconosciuto');
  });

  it('il maiuscolo non e una condizione', () => {
    expect(classifyProjectStatus('active_healthy')).toBe('attivo');
    expect(classifyProjectStatus('inactive')).toBe('in-pausa');
  });

  it('fermo vuol dire in pausa o in riattivazione, e nientaltro', () => {
    expect(databaseIsStopped('in-pausa')).toBe(true);
    expect(databaseIsStopped('in-riattivazione')).toBe(true);
    expect(databaseIsStopped('attivo')).toBe(false);
    expect(databaseIsStopped('sconosciuto')).toBe(false);
  });
});

describe('la riattivazione chiesta sopravvive alla navigazione', () => {
  it('subito dopo il clic il database risulta in riattivazione, anche se Supabase lo dice ancora fermo', () => {
    // E' IL DIFETTO CHE QUESTO STATO CHIUDE. Supabase accetta la richiesta e
    // risponde 200, ma per qualche istante continua a dichiarare il progetto
    // INACTIVE. Senza la data del clic scritta sul server, chi cambia scheda e
    // torna indietro ritroverebbe "in pausa" con il pulsante acceso sopra una
    // riattivazione gia' in corso — e premerebbe di nuovo credendo di non aver
    // premuto.
    const dopoIlClic = stato({
      status: 'INACTIVE',
      availability: 'in-pausa',
      resumeRequestedAt: new Date(ADESSO.getTime() - 30_000).toISOString(),
    });
    expect(effectiveAvailability(dopoIlClic, ADESSO)).toBe('in-riattivazione');
    // E il pulsante non si ripropone: premere di nuovo non aggiunge niente.
    expect(shouldOfferResume(dopoIlClic, ADESSO)).toBe(false);
  });

  it('passata la finestra il pulsante torna al merchant', () => {
    // Se dopo venti minuti il progetto e' ancora fermo, la richiesta non ha
    // attecchito. Continuare a dire "sta ripartendo" sarebbe una bugia che
    // nessuno smentisce mai, con il pulsante spento dentro e il merchant senza
    // piu' nessun gesto da fare.
    const vecchio = stato({
      resumeRequestedAt: new Date(
        ADESSO.getTime() - RESUME_IN_PROGRESS_WINDOW_MS - 1,
      ).toISOString(),
    });
    expect(effectiveAvailability(vecchio, ADESSO)).toBe('in-pausa');
    expect(shouldOfferResume(vecchio, ADESSO)).toBe(true);
  });

  it('un progetto che Supabase dichiara gia in risalita resta tale anche senza clic', () => {
    // La riattivazione puo' essere partita dalla dashboard Supabase, senza che
    // l'app ne sappia niente: l'avviso deve dirlo lo stesso.
    const senzaClic = stato({ status: 'RESTORING', availability: 'in-riattivazione' });
    expect(effectiveAvailability(senzaClic, ADESSO)).toBe('in-riattivazione');
    expect(shouldOfferResume(senzaClic, ADESSO)).toBe(false);
  });
});

describe('quando il pulsante non va offerto', () => {
  it('permesso mancante: niente pulsante, resta la strada della dashboard', () => {
    expect(shouldOfferResume(stato({ resumeBlocked: 'no_permission' }), ADESSO)).toBe(false);
  });

  it('collegamento da rifare: niente pulsante', () => {
    expect(shouldOfferResume(stato({ resumeBlocked: 'reconnect' }), ADESSO)).toBe(false);
  });

  it('database fermo e nessun impedimento: il pulsante c e', () => {
    expect(shouldOfferResume(stato(), ADESSO)).toBe(true);
  });
});

describe('quando la sincronizzazione riparte da sola', () => {
  it('da fermo ad attivo: si riparte', () => {
    expect(syncShouldRestart('in-pausa', 'attivo')).toBe(true);
    expect(syncShouldRestart('in-riattivazione', 'attivo')).toBe(true);
  });

  it('da attivo ad attivo: non si accoda niente', () => {
    // Questo controllo passa anche da una pagina che si ricarica da sola:
    // accodare a ogni giro sarebbe una sincronizzazione ogni pochi secondi.
    expect(syncShouldRestart('attivo', 'attivo')).toBe(false);
  });

  it('da fermo a uno stato che non sappiamo leggere: non si riparte', () => {
    expect(syncShouldRestart('in-pausa', 'sconosciuto')).toBe(false);
    expect(syncShouldRestart('in-pausa', 'in-riattivazione')).toBe(false);
  });
});

describe('il freno alle chiamate verso Supabase', () => {
  it('uno stato appena letto non si richiede', () => {
    expect(stateIsStale(stato(), ADESSO, 60_000)).toBe(false);
  });

  it('uno stato vecchio si richiede', () => {
    const vecchio = stato({ checkedAt: new Date(ADESSO.getTime() - 61_000).toISOString() });
    expect(stateIsStale(vecchio, ADESSO, 60_000)).toBe(true);
  });
});
