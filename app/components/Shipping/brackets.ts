// app/components/Shipping/brackets.ts
import type { RateBracket } from '~/lib/shipping/types';

/**
 * Validates a list of rate brackets for a shipping zone.
 *
 * Rules:
 * - At least one bracket required
 * - First bracket must start at 0
 * - Brackets must be contiguous (no gaps, no overlaps)
 * - Only the last bracket can have weightToKg = null (unlimited)
 * - All costs must be >= 0
 * - weightFrom must be <= weightTo (when weightTo is not null)
 *
 * @param brackets The rate brackets to validate
 * @returns The i18n key of the error, or null if valid
 */
export function validateBrackets(brackets: RateBracket[]): string | null {
  if (brackets.length === 0) {
    return 'shipping.errors.atLeastOneBracket';
  }

  // First pass: check each bracket's internal validity
  for (const bracket of brackets) {
    // Cost must be non-negative
    if (bracket.cost < 0) {
      return 'shipping.errors.costMustBeNonNegative';
    }

    // weightFrom must be <= weightTo (when weightTo is not null)
    if (bracket.weightToKg !== null && (bracket.weightFromKg ?? 0) > bracket.weightToKg) {
      return 'shipping.errors.weightFromGreaterThanWeightTo';
    }
  }

  // Sort by weightFromKg to check for gaps/overlaps
  const sorted = [...brackets].sort((a, b) => {
    const aFrom = a.weightFromKg ?? 0;
    const bFrom = b.weightFromKg ?? 0;
    return aFrom - bFrom;
  });

  // First bracket must start at 0
  if ((sorted[0].weightFromKg ?? 0) !== 0) {
    return 'shipping.errors.firstBracketMustStartAtZero';
  }

  for (let i = 0; i < sorted.length; i++) {
    const bracket = sorted[i];
    const isLast = i === sorted.length - 1;

    // Only the last bracket can be unlimited
    if (!isLast && bracket.weightToKg === null) {
      return 'shipping.errors.onlyLastBracketCanBeUnlimited';
    }

    // Check contiguity with next bracket
    if (!isLast) {
      const nextBracket = sorted[i + 1];
      const currentTo = bracket.weightToKg;
      const nextFrom = nextBracket.weightFromKg ?? 0;

      if (currentTo === null) {
        // Already caught by "only last can be unlimited" check
        continue;
      }

      if (currentTo < nextFrom) {
        // Gap between brackets
        return 'shipping.errors.bracketsHaveGaps';
      }

      if (currentTo > nextFrom) {
        // Overlap between brackets
        return 'shipping.errors.bracketsOverlap';
      }
    }
  }

  return null;
}
