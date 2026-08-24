export type StepState = 'complete' | 'active' | 'locked';

export interface DashboardStepStates {
  /** 1. Accesso all'account Supabase. */
  connectAccount: StepState;
  /** 2. Database scelto o creato, con le tabelle pronte. */
  connectDatabase: StepState;
  /** 3. Controllo dei canali collegati e del codice nel tema. */
  trackingCheck: StepState;
  /** 4. Piano scelto o confermato, e prima sincronizzazione: e' la fine. */
  plan: StepState;
}

export interface StepInput {
  accountConnected: boolean;
  databaseConnected: boolean;
  /** Il controllo delle altre fonti ha dato una risposta. */
  trackingChecked: boolean;
  /** Il piano e' stato scelto o confermato e la sincronizzazione e' partita. */
  planConfirmed: boolean;
}

/**
 * Avanzamento dei quattro passi della dashboard.
 *
 * I due collegamenti sono distinti perche' lo sono anche nei fatti: si puo'
 * avere l'account collegato e nessun database scelto — e' lo stato in cui si
 * resta chiudendo l'app a meta' flusso. Il database collegato implica l'account:
 * se il secondo risulta fatto e il primo no, si crede al database, che e' il
 * passo piu' avanti.
 *
 * Da li' in poi ogni passo si apre quando il precedente e' concluso: nessuno di
 * essi ha senso da solo — non si controlla cosa legge gia' il catalogo prima di
 * avere un database, e non si sceglie un piano prima di sapere quanti prodotti
 * entreranno davvero.
 *
 * Il piano e' l'ultimo perche' e' la fine vera: confermandolo parte la
 * sincronizzazione, e da quel momento l'app lavora. Tutto cio' che viene prima
 * serve a sapere cosa si sta comprando.
 */
export function resolveStepStates(input: StepInput): DashboardStepStates {
  const account = input.accountConnected || input.databaseConnected;

  const state = (done: boolean, previousDone: boolean): StepState =>
    done ? 'complete' : previousDone ? 'active' : 'locked';

  return {
    connectAccount: account ? 'complete' : 'active',
    connectDatabase: state(input.databaseConnected, account),
    trackingCheck: state(input.trackingChecked, input.databaseConnected),
    plan: state(
      input.planConfirmed,
      input.databaseConnected && input.trackingChecked,
    ),
  };
}

/** Tutti e quattro conclusi: la configurazione non ha piu' niente da chiedere. */
export function allStepsComplete(steps: DashboardStepStates): boolean {
  return Object.values(steps).every((state) => state === 'complete');
}
