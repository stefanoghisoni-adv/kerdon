import { describe, it, expect } from 'vitest';
import {
  BIRTHDATE_METAFIELD,
  BIRTHDATE_METAFIELD_ACCESS,
  BIRTHDATE_METAFIELD_KEY,
  birthdateFieldState,
  birthdateMetafieldOf,
  formatMetafieldKey,
  isDateMetafieldType,
  parseMetafieldKey,
  supportedCapabilities,
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
    expect(formatMetafieldKey(BIRTHDATE_METAFIELD_KEY)).toBe('facts.birth_date');
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

describe('la definizione che l app abilita', () => {
  // Se uno dei tre punti che la usano battesse una chiave diversa, il campo
  // resterebbe sempre vuoto senza che niente segnali un errore. E non e' una
  // chiave qualsiasi: `facts.birth_date` e' quella che Shopify prevede, quindi
  // quella che temi, segmenti e altre app sanno gia' leggere.
  it('e quella standard di Shopify, facts.birth_date', () => {
    expect(formatMetafieldKey(BIRTHDATE_METAFIELD_KEY)).toBe('facts.birth_date');
  });

  // Data e non data-e-ora: una persona nasce in un giorno, non a un'ora.
  it('e di tipo data, non data e ora', () => {
    expect(BIRTHDATE_METAFIELD.type).toBe('date');
  });

  // `admin` non si manda: su una definizione standard il livello
  // amministratore lo decide Shopify, e mandarlo fa rifiutare l'input.
  // La vetrina non la legge: nessuna parte dell'app passa di li', e una data di
  // nascita concessa in lettura "per ogni evenienza" e' un dato personale
  // esposto per un'ipotesi. L'account cliente si', perche' e' la persona che
  // legge e corregge il proprio dato.
  it('non apre la vetrina, e lascia al cliente il proprio dato', () => {
    expect(BIRTHDATE_METAFIELD_ACCESS).toEqual({
      storefront: 'NONE',
      customerAccount: 'READ_WRITE',
    });
    expect(BIRTHDATE_METAFIELD_ACCESS).not.toHaveProperty('admin');
  });
});

describe('supportedCapabilities', () => {
  // Il punto di tutta la funzione: una capability che la versione dell'API in
  // uso non conosce non viene ignorata, fa fallire la mutation prima ancora di
  // eseguirla. E' successo con analyticsQueryable sulla 2026-07.
  it('lascia fuori quello che la versione dell API non conosce', () => {
    expect(
      supportedCapabilities({ analyticsQueryable: { enabled: true } }, new Set(['uniqueValues'])),
    ).toBeUndefined();
  });

  it('tiene quello che c e', () => {
    expect(
      supportedCapabilities(
        { analyticsQueryable: { enabled: true } },
        new Set(['analyticsQueryable', 'uniqueValues']),
      ),
    ).toEqual({ analyticsQueryable: { enabled: true } });
  });

  // Non sapere non autorizza a tentare: senza l'elenco si manda il minimo, che
  // e' l'unica cosa che non rompe la mutation.
  it('senza elenco non manda niente', () => {
    expect(supportedCapabilities({ analyticsQueryable: { enabled: true } }, null)).toBeUndefined();
  });
});

describe('birthdateFieldState', () => {
  it('niente di scelto: nessun campo in uso', () => {
    expect(birthdateFieldState('', ['facts.birth_date'])).toBe('none');
    expect(birthdateFieldState('   ', null)).toBe('none');
  });

  it('scelto e presente sul negozio: in uso', () => {
    expect(birthdateFieldState('facts.birth_date', ['facts.birth_date'])).toBe('in_use');
  });

  // Il caso che faceva mentire la card: una chiave salvata che sul negozio non
  // corrisponde a niente veniva annunciata come attiva, e il merchant credeva
  // di raccogliere una data che non sarebbe mai arrivata.
  it('scelto ma sul negozio non c e: lo dice', () => {
    expect(birthdateFieldState('custom.data_di_nascita', ['facts.birth_date'])).toBe('missing');
    expect(birthdateFieldState('custom.data_di_nascita', [])).toBe('missing');
  });

  // Non sapere non e' lo stesso che sapere di no: su un elenco che non si e'
  // potuto leggere non si smentisce una scelta fatta davvero.
  it('elenco non letto: non smentisce niente', () => {
    expect(birthdateFieldState('custom.data_di_nascita', null)).toBe('in_use');
  });
});
