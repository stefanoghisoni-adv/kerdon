// app/components/Shipping/option-cost.test.ts
//
// TDD: tests for option cost formatting and validation (TASK 5)

import { describe, it, expect } from 'vitest';
import { formatIndicativeOptionCost, validateOptionBrackets, parseOptionBrackets } from './option-cost';
import type { OptionCostType } from '~/lib/shipping/types';

describe('formatIndicativeOptionCost', () => {
  it('flat: single rate with null range', () => {
    const rates = [{ from: null, to: null, cost: 5.5 }];
    expect(formatIndicativeOptionCost('flat', rates, 'EUR', 'it')).toBe('€ 5,50');
  });

  it('linear: single rate with null range, shows per kg', () => {
    const rates = [{ from: null, to: null, cost: 2.3 }];
    expect(formatIndicativeOptionCost('linear', rates, 'EUR', 'it')).toBe('€ 2,30/kg');
  });

  it('weight_brackets: shows min-max range', () => {
    const rates = [
      { from: 0, to: 1, cost: 3 },
      { from: 1, to: 5, cost: 6 },
      { from: 5, to: null, cost: 10 },
    ];
    expect(formatIndicativeOptionCost('weight_brackets', rates, 'EUR', 'it')).toBe('€ 3,00 – € 10,00');
  });

  it('value_brackets: shows min-max range in currency', () => {
    const rates = [
      { from: 0, to: 50, cost: 5 },
      { from: 50, to: 100, cost: 3 },
      { from: 100, to: null, cost: 0 },
    ];
    expect(formatIndicativeOptionCost('value_brackets', rates, 'EUR', 'it')).toBe('€ 0,00 – € 5,00');
  });

  it('empty rates: returns dash', () => {
    expect(formatIndicativeOptionCost('flat', [], 'EUR', 'it')).toBe('—');
  });

  it('weight_brackets with single rate: shows that cost', () => {
    const rates = [{ from: 0, to: null, cost: 7.5 }];
    expect(formatIndicativeOptionCost('weight_brackets', rates, 'EUR', 'it')).toBe('€ 7,50');
  });
});

describe('validateOptionBrackets', () => {
  it('weight_brackets: valid contiguous from 0', () => {
    const brackets = [
      { from: 0, to: 1, cost: 5 },
      { from: 1, to: 5, cost: 8 },
      { from: 5, to: null, cost: 12 },
    ];
    expect(validateOptionBrackets('weight_brackets', brackets)).toBeNull();
  });

  it('value_brackets: valid contiguous from 0', () => {
    const brackets = [
      { from: 0, to: 50, cost: 5 },
      { from: 50, to: 100, cost: 3 },
      { from: 100, to: null, cost: 0 },
    ];
    expect(validateOptionBrackets('value_brackets', brackets)).toBeNull();
  });

  it('flat/linear: skips bracket validation', () => {
    // For flat/linear the brackets validation doesn't apply
    expect(validateOptionBrackets('flat', [])).toBeNull();
    expect(validateOptionBrackets('linear', [])).toBeNull();
  });

  it('brackets: rejects empty list', () => {
    expect(validateOptionBrackets('weight_brackets', [])).toBe('shipping.errors.atLeastOneBracket');
  });

  it('brackets: rejects first not starting at 0', () => {
    const brackets = [
      { from: 1, to: 5, cost: 8 },
      { from: 5, to: null, cost: 12 },
    ];
    expect(validateOptionBrackets('weight_brackets', brackets)).toBe('shipping.errors.firstBracketMustStartAtZero');
  });

  it('brackets: rejects gap', () => {
    const brackets = [
      { from: 0, to: 1, cost: 5 },
      { from: 2, to: null, cost: 12 },
    ];
    expect(validateOptionBrackets('value_brackets', brackets)).toBe('shipping.errors.bracketsHaveGaps');
  });

  it('brackets: rejects overlap', () => {
    const brackets = [
      { from: 0, to: 2, cost: 5 },
      { from: 1, to: null, cost: 12 },
    ];
    expect(validateOptionBrackets('weight_brackets', brackets)).toBe('shipping.errors.bracketsOverlap');
  });

  it('brackets: rejects negative cost', () => {
    const brackets = [
      { from: 0, to: 1, cost: -5 },
      { from: 1, to: null, cost: 12 },
    ];
    expect(validateOptionBrackets('weight_brackets', brackets)).toBe('shipping.errors.costMustBeNonNegative');
  });

  it('brackets: rejects non-last unlimited', () => {
    const brackets = [
      { from: 0, to: null, cost: 5 },
      { from: 1, to: null, cost: 12 },
    ];
    expect(validateOptionBrackets('value_brackets', brackets)).toBe('shipping.errors.onlyLastBracketCanBeUnlimited');
  });

  it('brackets: rejects from > to', () => {
    const brackets = [
      { from: 0, to: 1, cost: 5 },
      { from: 5, to: 2, cost: 8 },
    ];
    expect(validateOptionBrackets('weight_brackets', brackets)).toBe('shipping.errors.weightFromGreaterThanWeightTo');
  });
});

describe('parseOptionBrackets', () => {
  it('parses valid JSON', () => {
    const json = '[{"from":0,"to":1,"cost":5},{"from":1,"to":null,"cost":10}]';
    const result = parseOptionBrackets('weight_brackets', json);
    expect(result.error).toBeNull();
    expect(result.brackets).toEqual([
      { from: 0, to: 1, cost: 5 },
      { from: 1, to: null, cost: 10 },
    ]);
  });

  it('rejects malformed JSON', () => {
    const result = parseOptionBrackets('weight_brackets', 'not json');
    expect(result.error).toBe('shipping.errors.invalidBrackets');
    expect(result.brackets).toBeNull();
  });

  it('rejects invalid brackets', () => {
    const json = '[{"from":1,"to":null,"cost":5}]'; // doesn't start at 0
    const result = parseOptionBrackets('value_brackets', json);
    expect(result.error).toBe('shipping.errors.firstBracketMustStartAtZero');
  });

  it('rejects non-array', () => {
    const result = parseOptionBrackets('weight_brackets', '{}');
    expect(result.error).toBe('shipping.errors.invalidBrackets');
  });

  it('rejects wrong shape', () => {
    const json = '[{"x":0,"y":1,"z":5}]';
    const result = parseOptionBrackets('weight_brackets', json);
    expect(result.error).toBe('shipping.errors.invalidBrackets');
  });
});
