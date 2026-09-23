import { describe, it, expect } from 'vitest';
import { validateBrackets } from './brackets';
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
