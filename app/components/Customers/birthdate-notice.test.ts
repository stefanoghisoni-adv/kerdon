import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DISMISSED_KEY,
  birthdateView,
  readDismissedFor,
  rememberDismissedFor,
} from './birthdate-notice';

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

  it('finche non si e letto il browser non si mostra niente, invece di mostrarlo sbagliato', () => {
    // Sul server la memoria di cio' che e' stato chiuso non esiste. Senza
    // questo stato la pagina renderebbe l'avviso di la' e la riga di qua, e
    // l'idratazione lo farebbe vedere: un lampo a ogni apertura.
    expect(birthdateView({ ...inUse, dismissedFor: undefined })).toBe('pending');
    // Solo dove la risposta dipende davvero da quella memoria: senza campo
    // scelto la riga di stato si sa gia' che ci va.
    expect(
      birthdateView({ state: 'none', configured: '', reopened: false, dismissedFor: undefined }),
    ).toBe('status');
  });
});

describe('memoria di cio che e stato chiuso', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('si ricorda per quale campo, non un si o no', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });

    rememberDismissedFor('custom.data_di_nascita');
    expect(store.get(DISMISSED_KEY)).toBe('custom.data_di_nascita');
    expect(readDismissedFor()).toBe('custom.data_di_nascita');
  });

  it('senza memoria l avviso ricompare, che e il male minore', () => {
    // Finestra anonima, o dati dei siti bloccati: l'accesso stesso lancia.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('accesso negato');
      },
      setItem: () => {
        throw new Error('accesso negato');
      },
    });

    expect(readDismissedFor()).toBeNull();
    expect(() => rememberDismissedFor('facts.birth_date')).not.toThrow();
  });
});
