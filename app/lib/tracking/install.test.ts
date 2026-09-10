import { describe, it, expect } from 'vitest';
import {
  isInstallPath,
  isTrackingInstallComplete,
  installStateData,
  normalizeEndpoint,
  readInstallState,
  withInstall,
} from './install';

describe('normalizeEndpoint', () => {
  it('tiene solo https: su http il cookie non puo essere Secure', () => {
    expect(normalizeEndpoint('http://negozio.it/kerdon/id')).toBeNull();
    expect(normalizeEndpoint('https://negozio.it/kerdon/id')).toBe('https://negozio.it/kerdon/id');
  });

  it('rifiuta quel che non e un indirizzo', () => {
    expect(normalizeEndpoint('negozio.it/kerdon')).toBeNull();
    expect(normalizeEndpoint('')).toBeNull();
    expect(normalizeEndpoint('   ')).toBeNull();
    expect(normalizeEndpoint(null)).toBeNull();
    expect(normalizeEndpoint(42)).toBeNull();
  });

  it('vuole un dominio, non un nome secco', () => {
    expect(normalizeEndpoint('https://localhost/kerdon')).toBeNull();
  });

  // Lo slash finale e la querystring non fanno un endpoint diverso: se li
  // trattassimo come diversi, un salvataggio identico annullerebbe una verifica
  // appena passata.
  it('lo stesso endpoint scritto in due modi resta lo stesso', () => {
    expect(normalizeEndpoint('https://negozio.it/kerdon/id/')).toBe('https://negozio.it/kerdon/id');
    expect(normalizeEndpoint('https://negozio.it/kerdon/id?a=1#x')).toBe(
      'https://negozio.it/kerdon/id',
    );
  });
});

describe('lo stato letto dalla riga', () => {
  const riga = {
    installPath: 'cloudflare',
    endpoint: 'https://negozio.it/kerdon/id',
    verifiedAt: new Date('2026-05-01T10:00:00.000Z'),
  };

  it('si rilegge intero', () => {
    const state = readInstallState(riga);
    expect(state.path).toBe('cloudflare');
    expect(state.endpoint).toBe('https://negozio.it/kerdon/id');
    expect(state.verifiedAt?.toISOString()).toBe('2026-05-01T10:00:00.000Z');
  });

  it('senza niente scritto, non c e niente da leggere', () => {
    expect(readInstallState({})).toEqual({ path: null, endpoint: null, verifiedAt: null });
    expect(readInstallState(null)).toEqual({ path: null, endpoint: null, verifiedAt: null });
    expect(readInstallState(undefined)).toEqual({ path: null, endpoint: null, verifiedAt: null });
  });

  // Una strada inventata non e' una strada: leggerla come valida vorrebbe dire
  // mostrare istruzioni che non esistono.
  it('una strada che non conosciamo vale come nessuna', () => {
    expect(readInstallState({ installPath: 'fastly' }).path).toBeNull();
    expect(isInstallPath('fastly')).toBe(false);
  });

  it('una data illeggibile vale come nessuna verifica', () => {
    expect(readInstallState({ verifiedAt: new Date('domani') }).verifiedAt).toBeNull();
  });

  it('lo stato torna nella forma che il database vuole', () => {
    expect(installStateData(readInstallState(riga))).toEqual({
      installPath: 'cloudflare',
      endpoint: 'https://negozio.it/kerdon/id',
      verifiedAt: new Date('2026-05-01T10:00:00.000Z'),
    });
  });
});

describe('withInstall', () => {
  const verified = readInstallState({
    installPath: 'sgtm',
    endpoint: 'https://sgtm.negozio.it/kerdon/id',
    verifiedAt: new Date('2026-05-01T10:00:00.000Z'),
  });

  it('salvare la stessa scelta non butta via la verifica', () => {
    const after = withInstall(verified, {
      path: 'sgtm',
      endpoint: 'https://sgtm.negozio.it/kerdon/id',
    });
    expect(after.verifiedAt).not.toBeNull();
  });

  // E' il cuore della cosa: una verifica e' una frase su UNA configurazione, e
  // tenerla dopo un cambio dichiarerebbe funzionante un giro mai provato.
  it('cambiare strada annulla la verifica', () => {
    const after = withInstall(verified, {
      path: 'cloudflare',
      endpoint: 'https://sgtm.negozio.it/kerdon/id',
    });
    expect(after.verifiedAt).toBeNull();
  });

  it('cambiare indirizzo annulla la verifica', () => {
    const after = withInstall(verified, {
      path: 'sgtm',
      endpoint: 'https://altro.negozio.it/kerdon/id',
    });
    expect(after.verifiedAt).toBeNull();
  });

  it('togliere tutto lascia lo stato vuoto', () => {
    expect(withInstall(verified, { path: null, endpoint: null })).toEqual({
      path: null,
      endpoint: null,
      verifiedAt: null,
    });
  });
});
