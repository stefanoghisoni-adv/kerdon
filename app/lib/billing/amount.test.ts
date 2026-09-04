import { describe, it, expect } from 'vitest';
import { minorUnits, notAbove, sameAmount } from './amount';

/**
 * I test degli importi.
 *
 * Quello che devono impedire e' una cosa sola: che due cifre diverse passino
 * per uguali. Il confronto che stava nella callback ("differiscono di meno di
 * mezzo centesimo") diceva uguali 29.999 e 30.001, e quello che tornava dalla
 * virgola mobile poteva dire diversi due 29.90 scritti in due modi.
 */

describe('minorUnits', () => {
  it('legge le tre forme in cui un importo arriva qui', () => {
    // number dallo state firmato, string da GraphQL, Decimal dalla riga.
    expect(minorUnits(29)).toBe(2900n);
    expect(minorUnits('29.00')).toBe(2900n);
    expect(minorUnits({ toString: () => '29.00' })).toBe(2900n);
  });

  it('non perde i centesimi', () => {
    expect(minorUnits('0.01')).toBe(1n);
    expect(minorUnits(29.9)).toBe(2990n);
    expect(minorUnits('29.99')).toBe(2999n);
  });

  it('arrotonda al centesimo, meta\' verso l\'alto', () => {
    // Le terze cifre arrivano dalle conversioni di valuta di Shopify.
    expect(minorUnits('29.994')).toBe(2999n);
    expect(minorUnits('29.995')).toBe(3000n);
  });

  it('regge cifre che un numero non reggerebbe', () => {
    expect(minorUnits('99999999999999999999.99')).toBe(9999999999999999999999n);
  });

  it("quel che non e' un importo non diventa zero", () => {
    // Zero sarebbe un importo, e "non lo so" non deve poter passare per
    // "gratis": e' la differenza fra rifiutare un confronto e regalare un piano.
    for (const valore of [null, undefined, '', '  ', 'ventinove', '29,00', '1e21', NaN, Infinity]) {
      expect(minorUnits(valore as never)).toBeNull();
    }
  });
});

describe('sameAmount', () => {
  it('stesso importo scritto in modi diversi', () => {
    expect(sameAmount(29, '29.00')).toBe(true);
    expect(sameAmount('29.0', 29)).toBe(true);
  });

  it('un centesimo di differenza e\' una differenza', () => {
    expect(sameAmount('29.00', '29.01')).toBe(false);
    expect(sameAmount(29, '28.99')).toBe(false);
  });

  it('la virgola mobile non fa dire diverso a cio\' che e\' uguale', () => {
    // 0.1 + 0.2 fa 0.30000000000000004, e sottrarre due cifre cosi' e' il modo
    // in cui un confronto fra prezzi comincia a rispondere a caso.
    expect(sameAmount(0.1 + 0.2, '0.30')).toBe(true);
  });

  it("un valore illeggibile non e' uguale a niente, nemmeno a un altro illeggibile", () => {
    expect(sameAmount(null, null)).toBe(false);
    expect(sameAmount('boh', 'boh')).toBe(false);
    expect(sameAmount(null, 0)).toBe(false);
  });
});

describe('notAbove', () => {
  it('il prezzo scontato sta sotto il listino, e va bene', () => {
    expect(notAbove('19.00', '29.00')).toBe(true);
    expect(notAbove('29.00', '29.00')).toBe(true);
  });

  it('un prezzo sopra il listino non e\' uno sconto', () => {
    expect(notAbove('29.01', '29.00')).toBe(false);
  });

  it('in dubbio non passa', () => {
    expect(notAbove(null, '29.00')).toBe(false);
    expect(notAbove('29.00', null)).toBe(false);
  });
});
