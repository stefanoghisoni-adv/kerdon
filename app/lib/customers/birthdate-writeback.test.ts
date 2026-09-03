import { describe, it, expect } from 'vitest';
import {
  birthdateWritebackTarget,
  planBirthdateWriteback,
  toShopifyDate,
} from './birthdate-writeback';
import { BIRTHDATE_METAFIELD_KEY } from './birthdate-metafield';

/** Il campo standard, quello che l'app sa accendere sul negozio. */
const STANDARD = BIRTHDATE_METAFIELD_KEY;
/** Un campo scelto dal merchant fra i suoi: del tipo non sappiamo niente. */
const CUSTOM = { namespace: 'custom', key: 'data_di_nascita' };

describe('birthdateWritebackTarget', () => {
  it('col permesso e il campo standard si riscrive su facts.birth_date', () => {
    const target = birthdateWritebackTarget(STANDARD, true);
    expect(target).toEqual({ namespace: 'facts', key: 'birth_date', type: 'date' });
  });

  it('senza il permesso di scrittura si salta, e non e un errore', () => {
    // Il negozio installato quando l'app leggeva soltanto non ha dato
    // `write_customers`: tentare vorrebbe dire un 403 a ogni corsa.
    expect(birthdateWritebackTarget(STANDARD, false)).toBeNull();
  });

  it('senza un campo scelto non si riscrive: "vuoto" non lo sapremmo distinguere da "non chiesto"', () => {
    expect(birthdateWritebackTarget(null, true)).toBeNull();
    expect(birthdateWritebackTarget(undefined, true)).toBeNull();
  });

  it('su un campo del merchant di tipo data si riscrive, nel campo stesso', () => {
    // Il tipo arriva dalle definizioni del negozio, lette una volta per corsa:
    // e' l'unica cosa che mancava, perche' `metafieldsSet` col tipo sbagliato
    // non scrive, rifiuta.
    expect(birthdateWritebackTarget(CUSTOM, true, 'date')).toEqual({
      namespace: 'custom',
      key: 'data_di_nascita',
      type: 'date',
    });
  });

  it('senza sapere il tipo non si scrive: elenco non letto, o campo sparito dal negozio', () => {
    expect(birthdateWritebackTarget(CUSTOM, true)).toBeNull();
    expect(birthdateWritebackTarget(CUSTOM, true, null)).toBeNull();
    expect(birthdateWritebackTarget(CUSTOM, true, '   ')).toBeNull();
  });

  it('su un campo che non contiene una data si continua a leggere e basta', () => {
    // Da un testo libero la data si ricava quando e' scritta in modo
    // riconoscibile; scriverci dentro il nostro formato vorrebbe dire decidere
    // noi come il merchant tiene i suoi dati.
    expect(birthdateWritebackTarget(CUSTOM, true, 'single_line_text_field')).toBeNull();
    expect(birthdateWritebackTarget(CUSTOM, true, 'number_integer')).toBeNull();
  });

  it('su date_time si legge soltanto: l ora di una nascita non esiste', () => {
    // Shopify conserva date_time in UTC e lo mostra nel fuso del negozio: la
    // mezzanotte che scrivessimo diventerebbe il giorno prima per ogni negozio
    // a ovest di Greenwich.
    expect(birthdateWritebackTarget(CUSTOM, true, 'date_time')).toBeNull();
  });

  it('il tipo si legge come lo manda Shopify, spazi e maiuscole comprese', () => {
    expect(birthdateWritebackTarget(CUSTOM, true, ' Date ')).toEqual({
      namespace: 'custom',
      key: 'data_di_nascita',
      type: 'date',
    });
  });

  it('del campo standard il tipo non si chiede: si sa per definizione', () => {
    // Regge anche quando l'elenco delle definizioni non si e' potuto leggere,
    // ed e' voluto: il campo che questa app accende sul negozio e' `date`, e su
    // quello la riscrittura non deve dipendere da una domanda in piu'.
    expect(birthdateWritebackTarget(STANDARD, true, null)).toEqual({
      namespace: 'facts',
      key: 'birth_date',
      type: 'date',
    });
    // E nemmeno un tipo sbagliato arrivato dall'elenco lo smuove.
    expect(birthdateWritebackTarget(STANDARD, true, 'single_line_text_field')).toEqual({
      namespace: 'facts',
      key: 'birth_date',
      type: 'date',
    });
  });

  it('senza il permesso non si scrive nemmeno su un campo data del merchant', () => {
    expect(birthdateWritebackTarget(CUSTOM, false, 'date')).toBeNull();
  });
});

describe('toShopifyDate', () => {
  it('dalla forma compatta del database del merchant a quella del metafield', () => {
    expect(toShopifyDate('19850423')).toBe('1985-04-23');
  });

  it('una data gia con i trattini resta se stessa', () => {
    // Serve all'idempotenza: quello che si e' appena scritto, riletto, non deve
    // sembrare una cosa diversa.
    expect(toShopifyDate('1985-04-23')).toBe('1985-04-23');
  });

  it('quello che non e una data non parte per Shopify', () => {
    expect(toShopifyDate('boh')).toBeNull();
    expect(toShopifyDate('1985-13-45')).toBeNull();
    expect(toShopifyDate('')).toBeNull();
    expect(toShopifyDate(null)).toBeNull();
  });
});

describe('planBirthdateWriteback', () => {
  it('Shopify ha un valore: vince lui, non c e niente da riscrivere', () => {
    const plan = planBirthdateWriteback(
      [{ id: 1, date_of_birth: '1990-01-01' }],
      new Map([[1, '19850423']]),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.invalid).toEqual([]);
  });

  it('Shopify vuoto e database del merchant pieno: la data torna su Shopify', () => {
    const plan = planBirthdateWriteback(
      [{ id: 7, date_of_birth: null }],
      new Map([[7, '19850423']]),
    );
    expect(plan.writes).toEqual([{ customerId: 7, date: '1985-04-23' }]);
  });

  it('Shopify vuoto e database del merchant vuoto: non succede niente', () => {
    const plan = planBirthdateWriteback(
      [
        { id: 1, date_of_birth: null },
        { id: 2, date_of_birth: null },
        { id: 3, date_of_birth: null },
      ],
      new Map<number, string | null>([
        [1, null],
        [2, '   '],
        // Il 3 non c'e' proprio: e' un cliente che questa corsa sta aggiungendo,
        // quindi di suo sul database del merchant non c'era niente.
      ]),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.invalid).toEqual([]);
  });

  it('una data malformata sul database del merchant si ignora, e si dice quale', () => {
    const plan = planBirthdateWriteback(
      [
        { id: 1, date_of_birth: null },
        { id: 2, date_of_birth: null },
      ],
      new Map([
        [1, 'boh'],
        [2, '1985-13-45'],
      ]),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.invalid).toEqual([1, 2]);
  });

  it('senza la lettura del database del merchant non si riscrive niente', () => {
    // Non sapere cosa c'e' di la' non autorizza a indovinare cosa mandare qua.
    const plan = planBirthdateWriteback([{ id: 1, date_of_birth: null }], null);
    expect(plan.writes).toEqual([]);
  });

  it('alla corsa successiva non resta niente da fare: e cio che la rende ripetibile', () => {
    const customers = [{ id: 7, date_of_birth: null as string | null }];
    const stored = new Map([[7, '19850423']]);

    const first = planBirthdateWriteback(customers, stored);
    expect(first.writes).toEqual([{ customerId: 7, date: '1985-04-23' }]);

    // Scritto il metafield, alla corsa dopo Shopify quel valore ce l'ha: rientra
    // dalla porta principale e questa riscrittura non ha piu' nulla da dire.
    const second = planBirthdateWriteback(
      [{ id: 7, date_of_birth: first.writes[0].date }],
      stored,
    );
    expect(second.writes).toEqual([]);
  });

  it('col campo del merchant la catena si chiude uguale: si scrive dove si legge', () => {
    // E' la ragione per cui il campo personalizzato si puo' riscrivere senza
    // ripetere la stessa mutation per sempre: il bersaglio della scrittura e'
    // lo stesso campo da cui la corsa successiva legge, quindi al giro dopo
    // Shopify quel valore ce l'ha e qui non resta niente da fare.
    const campo = { namespace: 'custom', key: 'data_di_nascita' };
    const target = birthdateWritebackTarget(campo, true, 'date');
    expect(target).toEqual({ ...campo, type: 'date' });

    const stored = new Map([[7, '19850423']]);
    const first = planBirthdateWriteback([{ id: 7, date_of_birth: null }], stored);
    expect(first.writes).toEqual([{ customerId: 7, date: '1985-04-23' }]);

    // Il valore appena scritto rientra dalla lettura del campo `custom.…`,
    // perche' e' quello indicato nella configurazione del negozio.
    const second = planBirthdateWriteback(
      [{ id: 7, date_of_birth: first.writes[0].date }],
      stored,
    );
    expect(second.writes).toEqual([]);
  });
});
