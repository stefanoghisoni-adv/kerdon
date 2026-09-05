import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const recordRevocation = vi.fn();
const processRevocation = vi.fn();
// I getter sono necessari, non una civetteria: `vi.mock` viene issato in cima
// al file, quindi la fabbrica gira prima che le due spie esistano.
vi.mock('./revocation-register.server', () => ({
  get recordRevocation() {
    return recordRevocation;
  },
  get processRevocation() {
    return processRevocation;
  },
}));

import { revokeTrackingIdentity } from './revoke-tracking.server';

const VISITATORE = 'corew_1700000000000_abcdefghijklmnopqrstuvwxyz012345';
const chiamata = () => revokeTrackingIdentity({ shopId: 'negozio-1', externalId: VISITATORE });

beforeEach(() => {
  vi.clearAllMocks();
  recordRevocation.mockResolvedValue({ id: 'revoca-1', duplicate: false, alreadyDone: false });
  processRevocation.mockResolvedValue('done');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('la revoca dal lato delle rotte', () => {
  it('prima scrive, poi prova ad applicare', async () => {
    const ordine: string[] = [];
    recordRevocation.mockImplementation(async () => {
      ordine.push('scrive');
      return { id: 'revoca-1', duplicate: false, alreadyDone: false };
    });
    processRevocation.mockImplementation(async () => {
      ordine.push('applica');
      return 'done';
    });

    const esito = await chiamata();

    expect(ordine).toEqual(['scrive', 'applica']);
    expect(esito).toEqual({ outcome: 'applied', retriable: false });
  });

  it('registra lo scopo del tracciamento, e passa il negozio', async () => {
    await chiamata();

    expect(recordRevocation).toHaveBeenCalledWith({
      shopId: 'negozio-1',
      scope: 'tracking_identity',
      externalId: VISITATORE,
      shopifyCustomerId: null,
    });
  });

  // Il caso che tutto il lavoro esiste per coprire: se la riga non si scrive,
  // chi chiama DEVE saperlo, perche' il cookie e' gia' scaduto e il riferimento
  // non lo tiene piu' nessuno.
  it('riga non scritta: non_registrata e ritentabile', async () => {
    const errore = vi.spyOn(console, 'error').mockImplementation(() => {});
    recordRevocation.mockRejectedValue(new Error('database owner giu'));

    const esito = await chiamata();

    expect(esito).toEqual({ outcome: 'not_recorded', retriable: true });
    // Non si prova nemmeno ad applicare: senza riga, un tentativo riuscito
    // sarebbe indistinguibile da uno mai avvenuto.
    expect(processRevocation).not.toHaveBeenCalled();
    expect(errore).toHaveBeenCalled();
    expect(String(errore.mock.calls[0][1])).not.toContain(VISITATORE);
  });

  // Scritta ma non applicata NON e' un errore per chi chiama: il drenaggio la
  // riprende, e far ritentare il container non aggiungerebbe niente.
  it('riga scritta e tentativo fallito: presa in carico, non ritentabile', async () => {
    processRevocation.mockResolvedValue('retried');

    expect(await chiamata()).toEqual({ outcome: 'recorded', retriable: false });
  });

  it('revoca gia conclusa: non si rifa niente', async () => {
    recordRevocation.mockResolvedValue({ id: 'revoca-1', duplicate: true, alreadyDone: true });

    expect(await chiamata()).toEqual({ outcome: 'already_done', retriable: false });
    expect(processRevocation).not.toHaveBeenCalled();
  });

  it('due revoche identiche: il secondo giro riusa la stessa riga', async () => {
    recordRevocation.mockResolvedValue({ id: 'revoca-1', duplicate: true, alreadyDone: false });

    await chiamata();

    expect(processRevocation).toHaveBeenCalledWith('revoca-1', undefined);
  });
});
