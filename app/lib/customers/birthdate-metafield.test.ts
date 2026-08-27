import { describe, it, expect } from 'vitest';
import {
  BIRTHDATE_METAFIELD,
  BIRTHDATE_METAFIELD_KEY,
  birthdateMetafieldOf,
  formatMetafieldKey,
  isDateMetafieldType,
  parseMetafieldKey,
} from './birthdate-metafield';

describe('parseMetafieldKey', () => {
  // Il gesto vero: nell'admin, sotto il nome della definizione, Shopify mostra
  // `custom.data_di_nascita` con accanto il pulsante che la copia. Il merchant
  // la incolla, e deve funzionare.
  it('divide quello che si copia dall admin', () => {
    expect(parseMetafieldKey('custom.data_di_nascita')).toEqual({
      namespace: 'custom',
      key: 'data_di_nascita',
    });
  });

  it('tollera gli spazi che si portano dietro gli appunti', () => {
    expect(parseMetafieldKey('  custom.data_di_nascita  ')).toEqual({
      namespace: 'custom',
      key: 'data_di_nascita',
    });
  });

  it('senza namespace sottintende custom, che e dove l admin mette le definizioni del merchant', () => {
    expect(parseMetafieldKey('data_di_nascita')).toEqual({
      namespace: 'custom',
      key: 'data_di_nascita',
    });
  });

  it('un namespace diverso da custom si rispetta', () => {
    expect(parseMetafieldKey('mio_app.birthday')).toEqual({
      namespace: 'mio_app',
      key: 'birthday',
    });
  });

  // Un secondo punto e' un errore di battitura, non una chiave con un punto
  // dentro: Shopify nelle chiavi il punto non lo ammette proprio.
  it('due punti sono un errore, non una chiave annidata', () => {
    expect(parseMetafieldKey('custom.data.nascita')).toBeNull();
  });

  it.each([
    ['stringa vuota', ''],
    ['solo spazi', '   '],
    ['null', null],
    ['undefined', undefined],
    ['solo il punto', '.'],
    ['namespace vuoto', '.chiave'],
    ['chiave vuota', 'custom.'],
    ['caratteri non ammessi', 'custom.data di nascita'],
    ['accenti', 'custom.età'],
  ])('%s non da una coppia utilizzabile', (_caso, valore) => {
    expect(parseMetafieldKey(valore as string | null | undefined)).toBeNull();
  });

  it('oltre i limiti di lunghezza di Shopify si rifiuta', () => {
    expect(parseMetafieldKey(`custom.${'a'.repeat(65)}`)).toBeNull();
    expect(parseMetafieldKey(`${'n'.repeat(256)}.chiave`)).toBeNull();
  });
});

describe('formatMetafieldKey', () => {
  it('rimette insieme la forma che l admin mostra', () => {
    expect(formatMetafieldKey(BIRTHDATE_METAFIELD_KEY)).toBe('custom.data_di_nascita');
  });

  it('senza campo non inventa niente', () => {
    expect(formatMetafieldKey(null)).toBe('');
  });

  // Quello che si incolla deve tornare identico dopo un giro completo,
  // altrimenti la tendina e il campo di testo mostrerebbero cose diverse.
  it('andata e ritorno non cambiano il valore', () => {
    const testo = 'custom.data_di_nascita';
    expect(formatMetafieldKey(parseMetafieldKey(testo))).toBe(testo);
  });
});

describe('isDateMetafieldType', () => {
  it('date e date_time sono date vere', () => {
    expect(isDateMetafieldType('date')).toBe(true);
    expect(isDateMetafieldType('date_time')).toBe(true);
    expect(isDateMetafieldType('  DATE  ')).toBe(true);
  });

  it('un campo di testo non lo e', () => {
    expect(isDateMetafieldType('single_line_text_field')).toBe(false);
    expect(isDateMetafieldType('list.date')).toBe(false);
    expect(isDateMetafieldType(null)).toBe(false);
  });
});

describe('birthdateMetafieldOf', () => {
  it('il negozio che ne ha scelto uno', () => {
    expect(
      birthdateMetafieldOf({
        birthdateMetafieldNamespace: 'custom',
        birthdateMetafieldKey: 'data_di_nascita',
      }),
    ).toEqual({ namespace: 'custom', key: 'data_di_nascita' });
  });

  it.each([
    ['nessuna configurazione', {}],
    ['solo il namespace', { birthdateMetafieldNamespace: 'custom' }],
    ['solo la chiave', { birthdateMetafieldKey: 'data_di_nascita' }],
    ['valori vuoti', { birthdateMetafieldNamespace: '  ', birthdateMetafieldKey: '  ' }],
    ['negozio assente', null],
  ])('%s: nessun campo da leggere', (_caso, shop) => {
    expect(birthdateMetafieldOf(shop as never)).toBeNull();
  });
});

describe('la definizione che crea l app', () => {
  // Se uno dei tre punti che la usano battesse una chiave diversa, il campo
  // resterebbe sempre vuoto senza che niente segnali un errore.
  it('e quella che il merchant vede come custom.data_di_nascita', () => {
    expect(formatMetafieldKey(BIRTHDATE_METAFIELD_KEY)).toBe('custom.data_di_nascita');
    expect(BIRTHDATE_METAFIELD.type).toBe('date');
  });
});
