import { describe, it, expect } from 'vitest';
import { allStepsComplete, resolveStepStates, type StepInput } from './stepper-state';

function input(overrides: Partial<StepInput> = {}): StepInput {
  return {
    accountConnected: false,
    databaseConnected: false,
    trackingChecked: false,
    planConfirmed: false,
    ...overrides,
  };
}

describe('resolveStepStates', () => {
  it('niente di fatto: si parte dall accesso, il resto e bloccato', () => {
    expect(resolveStepStates(input())).toEqual({
      connectAccount: 'active',
      connectDatabase: 'locked',
      trackingCheck: 'locked',
      plan: 'locked',
    });
  });

  it('account collegato: tocca al database, il resto resta bloccato', () => {
    expect(resolveStepStates(input({ accountConnected: true }))).toEqual({
      connectAccount: 'complete',
      connectDatabase: 'active',
      trackingCheck: 'locked',
      plan: 'locked',
    });
  });

  it('database collegato: si controlla cosa gia trasmette dati', () => {
    expect(
      resolveStepStates(input({ accountConnected: true, databaseConnected: true })),
    ).toEqual({
      connectAccount: 'complete',
      connectDatabase: 'complete',
      trackingCheck: 'active',
      plan: 'locked',
    });
  });

  it('controllo fatto: resta il piano, che e la fine', () => {
    expect(
      resolveStepStates(
        input({ accountConnected: true, databaseConnected: true, trackingChecked: true }),
      ),
    ).toEqual({
      connectAccount: 'complete',
      connectDatabase: 'complete',
      trackingCheck: 'complete',
      plan: 'active',
    });
  });

  it('database collegato senza account: vale il passo piu avanti', () => {
    // Non dovrebbe capitare, ma se capita e' meglio non far sembrare il flusso
    // tornato indietro di un passo.
    const steps = resolveStepStates(input({ databaseConnected: true }));
    expect(steps.connectAccount).toBe('complete');
    expect(steps.connectDatabase).toBe('complete');
  });

  it('un passo saltato non ne sblocca uno successivo', () => {
    // Il piano risulta confermato ma il controllo no: puo' succedere a un
    // negozio che aveva gia' un piano attivo. Il passo che manca resta quello
    // aperto, e quelli dopo non si aprono al posto suo.
    const steps = resolveStepStates(
      input({ accountConnected: true, databaseConnected: true, planConfirmed: true }),
    );
    expect(steps.trackingCheck).toBe('active');
    expect(steps.plan).toBe('complete');
  });
});

describe('allStepsComplete', () => {
  it('vero solo quando non resta niente da fare', () => {
    const done = resolveStepStates(
      input({
        accountConnected: true,
        databaseConnected: true,
        trackingChecked: true,
        planConfirmed: true,
      }),
    );
    expect(allStepsComplete(done)).toBe(true);
    expect(allStepsComplete(resolveStepStates(input()))).toBe(false);
  });
});
