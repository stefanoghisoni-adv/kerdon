import { describe, it, expect } from 'vitest';
import { isPublicName, registrableDomain } from './endpoint-host.server';

describe('registrableDomain', () => {
  it('tiene insieme i sottodomini dello stesso sito', () => {
    expect(registrableDomain('sgtm.negozio.it')).toBe('negozio.it');
    expect(registrableDomain('www.negozio.it')).toBe('negozio.it');
  });

  it('due siti diversi restano diversi', () => {
    expect(registrableDomain('sgtm.altro.it')).not.toBe(registrableDomain('www.negozio.it'));
  });

  it('rispetta i suffissi a piu livelli', () => {
    expect(registrableDomain('sgtm.negozio.co.uk')).toBe('negozio.co.uk');
    expect(registrableDomain('a.b.negozio.com.au')).toBe('negozio.com.au');
  });

  // Il caso per cui serve la lista pubblica intera: due persone diverse sotto
  // lo stesso suffisso privato non sono lo stesso sito.
  it('due sottodomini github.io diversi NON sono lo stesso sito', () => {
    expect(registrableDomain('negozio.github.io')).toBe('negozio.github.io');
    expect(registrableDomain('altro.github.io')).toBe('altro.github.io');
    expect(registrableDomain('negozio.github.io')).not.toBe(registrableDomain('altro.github.io'));
  });

  it('idem per vercel.app', () => {
    expect(registrableDomain('sgtm.negozio.vercel.app')).toBe('negozio.vercel.app');
    expect(registrableDomain('altro.vercel.app')).not.toBe(registrableDomain('negozio.vercel.app'));
  });

  it('un suffisso da solo non e il sito di nessuno', () => {
    expect(registrableDomain('github.io')).toBeNull();
    expect(registrableDomain('co.uk')).toBeNull();
  });

  it('un IP non ha dominio registrabile', () => {
    expect(registrableDomain('10.0.0.5')).toBeNull();
    expect(registrableDomain('[::1]')).toBeNull();
  });
});

describe('isPublicName', () => {
  it('accetta nomi pubblici', () => {
    expect(isPublicName('negozio.it')).toBe(true);
    expect(isPublicName('sgtm.negozio.co.uk')).toBe(true);
    expect(isPublicName('negozio.github.io')).toBe(true);
  });

  it.each(['localhost', 'stampante.local', 'db.internal', 'nas.lan', 'x.localhost', '10.0.0.5', '[::1]', '[fd00::1]', 'github.io'])(
    'rifiuta %s',
    (host) => {
      expect(isPublicName(host)).toBe(false);
    },
  );
});
