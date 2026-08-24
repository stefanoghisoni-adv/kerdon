import { describe, it, expect } from 'vitest';
import {
  allStepsComplete,
  resolveStepStates,
  type StepInput,
} from '~/components/Dashboard/stepper-state';

/**
 * La regola che governa il menu: finche' un passo e' aperto, l'app ha una voce
 * sola. Il calcolo vero legge il database (setup-state.server), ma la decisione
 * e' questa, ed e' la stessa che governa i passi nella dashboard — che e'
 * esattamente il punto: due parti dell'app non devono poter dire cose diverse
 * sullo stesso negozio.
 */
function input(overrides: Partial<StepInput> = {}): StepInput {
  return {
    accountConnected: true,
    databaseConnected: true,
    trackingChecked: true,
    planConfirmed: true,
    ...overrides,
  };
}

describe('menu durante la configurazione', () => {
  it('a configurazione conclusa il menu torna intero', () => {
    expect(allStepsComplete(resolveStepStates(input()))).toBe(true);
  });

  it('basta un passo aperto perche' + "'" + 'app abbia una voce sola', () => {
    for (const missing of [
      // L'accesso da solo non conta: un database collegato lo implica, ed e'
      // la regola che evita di far sembrare il flusso tornato indietro.
      { accountConnected: false, databaseConnected: false },
      { databaseConnected: false },
      { trackingChecked: false },
      { trackingChecked: false },
      { planConfirmed: false },
    ] as Partial<StepInput>[]) {
      expect(allStepsComplete(resolveStepStates(input(missing)))).toBe(false);
    }
  });
});
