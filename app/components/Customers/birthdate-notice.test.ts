import { describe, it, expect } from 'vitest';
import { birthdateView } from './birthdate-notice';

/** Il caso normale: campo scelto, presente sul negozio, nessuno sta scegliendo. */
const inUse = {
  state: 'in_use' as const,
  configured: 'facts.birth_date',
  reopened: false,
};

describe('birthdateView', () => {
  it('appena collegato l avviso compare: e la conferma di quel campo li', () => {
    expect(birthdateView({ ...inUse, dismissedFor: null })).toBe('notice');
  });

  it('chiuso una volta non torna: al suo posto la riga di stato', () => {
    // La riga resta, l'avviso no: una conferma gia' letta ripetuta a ogni
    // apertura smette di essere una conferma e diventa un ingombro.
    expect(birthdateView({ ...inUse, dismissedFor: 'facts.birth_date' })).toBe('status');
  });

  it('cambiato il campo l avviso torna: e un campo diverso, quindi una conferma nuova', () => {
    expect(
      birthdateView({
        ...inUse,
        configured: 'custom.data_di_nascita',
        dismissedFor: 'facts.birth_date',
      }),
    ).toBe('notice');
  });

  it('nessun campo scelto: la riga di stato, non il riquadro', () => {
    // Il riquadro si apre a richiesta. Aperto da solo sarebbe un modulo da
    // compilare piazzato davanti a chi era venuto a guardare i clienti.
    expect(
      birthdateView({ state: 'none', configured: '', reopened: false, dismissedFor: null }),
    ).toBe('status');
  });

  it('chi ha chiesto di scegliere vede il riquadro, e solo quello', () => {
    expect(birthdateView({ ...inUse, reopened: true, dismissedFor: null })).toBe('card');
    expect(
      birthdateView({ ...inUse, reopened: true, dismissedFor: 'facts.birth_date' }),
    ).toBe('card');
    expect(
      birthdateView({ state: 'none', configured: '', reopened: true, dismissedFor: null }),
    ).toBe('card');
  });

  it('campo scelto ma sparito dal negozio: resta il riquadro, che dice cosa non va', () => {
    // Ridurre quel guasto a un badge grigio vorrebbe dire nasconderlo: il
    // merchant crederebbe di raccogliere una data che non arrivera' mai.
    expect(
      birthdateView({
        state: 'missing',
        configured: 'custom.sparito',
        reopened: false,
        dismissedFor: 'custom.sparito',
      }),
    ).toBe('card');
  });

  // Non c'e' piu' un `pending`. Serviva quando la memoria di cio' che era stato
  // chiuso stava nel browser e non esisteva durante il render sul server:
  // servivano due render, e in mezzo si vedeva il lampo. Ora il valore arriva
  // col loader, quindi il primo render sa gia' e le due meta' non discordano.
  it('il primo render decide gia, perche il valore arriva dal server', () => {
    expect(birthdateView({ ...inUse, dismissedFor: null })).toBe('notice');
    expect(birthdateView({ ...inUse, dismissedFor: 'facts.birth_date' })).toBe('status');
  });
});
