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

  it('su un campo personalizzato si continua a leggere e basta', () => {
    // Di un campo del merchant non conosciamo il tipo — sulla riga del negozio
    // stanno namespace e chiave — e `metafieldsSet` col tipo sbagliato non
    // scrive, rifiuta. E scrivere altrove da dove si legge ripeterebbe la
    // stessa mutation a ogni corsa, per sempre.
    expect(birthdateWritebackTarget(CUSTOM, true)).toBeNull();
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
});
