import { describe, it, expect } from 'vitest';
import { parseBrackets, validateBrackets } from './brackets';
import type { RateBracket } from '~/lib/shipping/types';

describe('validateBrackets', () => {
  it('accepts a valid bracket set', () => {
    const brackets: RateBracket[] = [
      { weightFromKg: 0, weightToKg: 1, cost: 5 },
      { weightFromKg: 1, weightToKg: 5, cost: 8 },
      { weightFromKg: 5, weightToKg: null, cost: 15 },
    ];
    expect(validateBrackets(brackets)).toBeNull();
  });

  it('rejects when first bracket does not start at 0', () => {
    const brackets: RateBracket[] = [
      { weightFromKg: 1, weightToKg: 5, cost: 8 },
      { weightFromKg: 5, weightToKg: null, cost: 15 },
    ];
    expect(validateBrackets(brackets)).toBe('shipping.errors.firstBracketMustStartAtZero');
  });

  it('rejects when brackets have gaps', () => {
    const brackets: RateBracket[] = [
      { weightFromKg: 0, weightToKg: 1, cost: 5 },
      { weightFromKg: 2, weightToKg: 5, cost: 8 },
      { weightFromKg: 5, weightToKg: null, cost: 15 },
    ];
    expect(validateBrackets(brackets)).toBe('shipping.errors.bracketsHaveGaps');
  });

  it('rejects when brackets overlap', () => {
    const brackets: RateBracket[] = [
      { weightFromKg: 0, weightToKg: 2, cost: 5 },
      { weightFromKg: 1, weightToKg: 5, cost: 8 },
      { weightFromKg: 5, weightToKg: null, cost: 15 },
    ];
    expect(validateBrackets(brackets)).toBe('shipping.errors.bracketsOverlap');
  });

  it('rejects when a non-last bracket has no upper limit', () => {
    const brackets: RateBracket[] = [
      { weightFromKg: 0, weightToKg: 1, cost: 5 },
      { weightFromKg: 1, weightToKg: null, cost: 8 },
      { weightFromKg: 5, weightToKg: 10, cost: 15 },
    ];
    expect(validateBrackets(brackets)).toBe('shipping.errors.onlyLastBracketCanBeUnlimited');
  });

  it('rejects when cost is negative', () => {
    const brackets: RateBracket[] = [
      { weightFromKg: 0, weightToKg: 1, cost: -5 },
      { weightFromKg: 1, weightToKg: null, cost: 8 },
    ];
    expect(validateBrackets(brackets)).toBe('shipping.errors.costMustBeNonNegative');
  });

  it('rejects empty bracket list', () => {
    expect(validateBrackets([])).toBe('shipping.errors.atLeastOneBracket');
  });

  it('accepts single unlimited bracket starting at 0', () => {
    const brackets: RateBracket[] = [
      { weightFromKg: 0, weightToKg: null, cost: 10 },
    ];
    expect(validateBrackets(brackets)).toBeNull();
  });

  it('rejects when weightFrom is greater than weightTo', () => {
    const brackets: RateBracket[] = [
      { weightFromKg: 5, weightToKg: 1, cost: 5 },
    ];
    expect(validateBrackets(brackets)).toBe('shipping.errors.weightFromGreaterThanWeightTo');
  });
});

// I dati arrivano dal client come JSON: il tipo dichiarato non garantisce
// niente, e un valore sbagliato deve tornare come errore di validazione, non
// come un 500 o come un Decimal costruito su una stringa.
describe('validateBrackets — tipi', () => {
  it('rifiuta cio che non e una lista', () => {
    expect(validateBrackets({} as unknown)).toBe('shipping.errors.invalidBrackets');
    expect(validateBrackets(null as unknown)).toBe('shipping.errors.invalidBrackets');
  });
  it('rifiuta un costo stringa', () => {
    expect(validateBrackets([{ weightFromKg: 0, weightToKg: null, cost: '5' }] as unknown)).toBe(
      'shipping.errors.invalidBrackets',
    );
  });
  it('rifiuta un costo non finito', () => {
    expect(validateBrackets([{ weightFromKg: 0, weightToKg: null, cost: Infinity }])).toBe(
      'shipping.errors.invalidBrackets',
    );
    expect(validateBrackets([{ weightFromKg: 0, weightToKg: null, cost: NaN }])).toBe(
      'shipping.errors.invalidBrackets',
    );
  });
  it('rifiuta un peso che non e un numero ne null', () => {
    expect(validateBrackets([{ weightFromKg: 0, weightToKg: '5', cost: 1 }] as unknown)).toBe(
      'shipping.errors.invalidBrackets',
    );
    expect(validateBrackets([{ weightFromKg: 'zero', weightToKg: null, cost: 1 }] as unknown)).toBe(
      'shipping.errors.invalidBrackets',
    );
  });
  it('rifiuta un elemento che non e un oggetto', () => {
    expect(validateBrackets([5] as unknown)).toBe('shipping.errors.invalidBrackets');
  });
});

describe('parseBrackets', () => {
  it('JSON valido e fasce valide: le restituisce', () => {
    const raw = JSON.stringify([{ weightFromKg: 0, weightToKg: null, cost: 5 }]);
    expect(parseBrackets(raw)).toEqual({ brackets: [{ weightFromKg: 0, weightToKg: null, cost: 5 }], error: null });
  });
  it('JSON malformato: errore tipizzato, nessuna eccezione', () => {
    expect(parseBrackets('[{ rotto')).toEqual({ brackets: null, error: 'shipping.errors.invalidBrackets' });
  });
  it('campo assente: errore tipizzato', () => {
    expect(parseBrackets(undefined)).toEqual({ brackets: null, error: 'shipping.errors.invalidBrackets' });
  });
  it('numero oltre il float (1e999 diventa Infinity): rifiutato', () => {
    expect(parseBrackets('[{"weightFromKg":0,"weightToKg":null,"cost":1e999}]').error).toBe(
      'shipping.errors.invalidBrackets',
    );
  });
  it('JSON valido ma fasce incoerenti: l errore di validazione', () => {
    const raw = JSON.stringify([{ weightFromKg: 1, weightToKg: null, cost: 5 }]);
    expect(parseBrackets(raw).error).toBe('shipping.errors.firstBracketMustStartAtZero');
  });
});
