import { describe, it, expect } from 'vitest';
import { isValidOAuthMessage } from './oauth-popup-message';

const APP = 'https://app.example.com';
const TYPE = 'supabase-oauth';
const popup = {} as Window;

function evt(over: Partial<{ origin: string; source: unknown; data: unknown }>): MessageEvent {
  return {
    origin: APP,
    source: popup,
    data: { type: TYPE, code: 'c', state: 's' },
    ...over,
  } as MessageEvent;
}

describe('isValidOAuthMessage (condivisa da Supabase e Klaviyo)', () => {
  it('accetta codice e stato dalla finestra aperta da questo clic', () => {
    expect(isValidOAuthMessage(evt({}), popup, APP, TYPE)).toEqual({
      ok: true,
      data: { code: 'c', state: 's' },
    });
  });

  it("rifiuta un'origine diversa", () => {
    expect(isValidOAuthMessage(evt({ origin: 'https://evil.com' }), popup, APP, TYPE)).toEqual({
      ok: false,
    });
  });

  it('rifiuta un mittente che non e la finestra aperta', () => {
    expect(isValidOAuthMessage(evt({ source: {} }), popup, APP, TYPE)).toEqual({ ok: false });
  });

  it('rifiuta tutto se nessuna finestra e aperta', () => {
    expect(isValidOAuthMessage(evt({}), null, APP, TYPE)).toEqual({ ok: false });
  });

  it('rifiuta un tipo diverso (anche quello di un altro flusso)', () => {
    expect(
      isValidOAuthMessage(evt({ data: { type: 'klaviyo-oauth', code: 'c', state: 's' } }), popup, APP, TYPE),
    ).toEqual({ ok: false });
  });

  it('rifiuta senza codice o senza stato', () => {
    expect(isValidOAuthMessage(evt({ data: { type: TYPE, state: 's' } }), popup, APP, TYPE)).toEqual({ ok: false });
    expect(isValidOAuthMessage(evt({ data: { type: TYPE, code: 'c' } }), popup, APP, TYPE)).toEqual({ ok: false });
  });

  it('rifiuta dati non oggetto o null', () => {
    expect(isValidOAuthMessage(evt({ data: 'x' }), popup, APP, TYPE)).toEqual({ ok: false });
    expect(isValidOAuthMessage(evt({ data: null }), popup, APP, TYPE)).toEqual({ ok: false });
  });

  it("accetta l'esito negativo, con gli stessi controlli", () => {
    const data = { type: TYPE, ok: false, error: 'denied' };
    expect(isValidOAuthMessage(evt({ data }), popup, APP, TYPE)).toEqual({ ok: false, error: 'denied' });
    expect(isValidOAuthMessage(evt({ data, origin: 'https://evil.com' }), popup, APP, TYPE)).toEqual({ ok: false });
    expect(isValidOAuthMessage(evt({ data, source: {} }), popup, APP, TYPE)).toEqual({ ok: false });
  });
});
