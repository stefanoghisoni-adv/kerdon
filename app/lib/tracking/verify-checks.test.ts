import { describe, it, expect } from 'vitest';
import {
  cookieAttributeProblem,
  isExpiredCookie,
  isPublicHost,
  parseSetCookie,
  registrableDomain,
} from './verify-checks';

const cookie = (raw: string) => parseSetCookie([raw], 'corew_eid')!;

describe('parseSetCookie', () => {
  it('trova il nostro fra gli altri', () => {
    const found = parseSetCookie(
      ['_shopify_y=abc; Path=/', 'corew_eid=corew_x; Path=/; Secure'],
      'corew_eid',
    );
    expect(found?.value).toBe('corew_x');
    expect(found?.attributes.secure).toBe('');
  });

  it('se non c e, non c e', () => {
    expect(parseSetCookie(['_shopify_y=abc'], 'corew_eid')).toBeNull();
    expect(parseSetCookie([], 'corew_eid')).toBeNull();
  });

  // Le date di Expires contengono una virgola: un parser che spezza li si
  // ritrova mezzo cookie e boccia una configurazione buona.
  it('la virgola dentro Expires non spezza niente', () => {
    const found = cookie('corew_eid=v; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure');
    expect(found.attributes.expires).toBe('Wed, 21 Oct 2026 07:28:00 GMT');
  });
});

describe('isExpiredCookie', () => {
  it('Max-Age a zero e scaduto', () => {
    expect(isExpiredCookie(cookie('corew_eid=; Path=/; Max-Age=0'))).toBe(true);
  });

  it('una data passata e scaduta', () => {
    expect(
      isExpiredCookie(cookie('corew_eid=v; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT')),
    ).toBe(true);
  });

  it('un valore vuoto e scaduto anche senza attributi', () => {
    expect(isExpiredCookie(cookie('corew_eid=; Path=/'))).toBe(true);
  });

  it('un anno davanti non e scaduto', () => {
    expect(isExpiredCookie(cookie('corew_eid=corew_x; Path=/; Max-Age=31536000'))).toBe(false);
  });
});

describe('cookieAttributeProblem', () => {
  const buono = 'corew_eid=corew_x; Path=/; Max-Age=31536000; SameSite=Lax; Secure';

  it('un cookie fatto come si deve non ha problemi', () => {
    expect(cookieAttributeProblem(cookie(buono))).toBeNull();
  });

  it('senza Secure viaggia in chiaro', () => {
    expect(cookieAttributeProblem(cookie('corew_eid=x; Path=/; Max-Age=1; SameSite=Lax'))).toBe(
      'cookie_not_secure',
    );
  });

  it('un Path stretto lo fa sparire nel resto del negozio', () => {
    expect(
      cookieAttributeProblem(cookie('corew_eid=x; Path=/kerdon; Max-Age=1; SameSite=Lax; Secure')),
    ).toBe('cookie_path');
  });

  it('senza SameSite decide il browser, e ognuno decide diverso', () => {
    expect(cookieAttributeProblem(cookie('corew_eid=x; Path=/; Max-Age=1; Secure'))).toBe(
      'cookie_samesite',
    );
  });

  // Il caso che non si vede: tutto sembra a posto, e l'attribuzione muore alla
  // chiusura della scheda.
  it('senza durata muore chiudendo la scheda', () => {
    expect(cookieAttributeProblem(cookie('corew_eid=x; Path=/; SameSite=Lax; Secure'))).toBe(
      'cookie_session_only',
    );
  });

  // HttpOnly non si pretende: lo script in vetrina deve poterlo leggere per
  // attaccare lo stesso identificativo al carrello.
  it('HttpOnly non e un problema, e non e nemmeno richiesto', () => {
    expect(cookieAttributeProblem(cookie(`${buono}; HttpOnly`))).toBeNull();
  });
});

describe('registrableDomain', () => {
  it('due nomi dello stesso sito danno lo stesso dominio', () => {
    expect(registrableDomain('sgtm.negozio.it')).toBe('negozio.it');
    expect(registrableDomain('www.negozio.it')).toBe('negozio.it');
  });

  it('due siti diversi restano diversi', () => {
    expect(registrableDomain('sgtm.altro.it')).not.toBe(registrableDomain('www.negozio.it'));
  });

  // Senza questo, due negozi britannici diversi risulterebbero lo stesso sito.
  it('i suffissi a due livelli non diventano il dominio di tutti', () => {
    expect(registrableDomain('shop.negozio.co.uk')).toBe('negozio.co.uk');
    expect(registrableDomain('www.altro.co.uk')).toBe('altro.co.uk');
  });
});

describe('isPublicHost', () => {
  it('un dominio vero si puo chiamare', () => {
    expect(isPublicHost('negozio.it')).toBe(true);
  });

  // Il nostro server chiama questo indirizzo: senza filtro, chiunque abbia un
  // negozio potrebbe farci bussare dentro la nostra rete.
  it('quel che punta in casa nostra no', () => {
    expect(isPublicHost('localhost')).toBe(false);
    expect(isPublicHost('10.0.0.1')).toBe(false);
    expect(isPublicHost('macchina.local')).toBe(false);
    expect(isPublicHost('api.internal')).toBe(false);
  });
});
