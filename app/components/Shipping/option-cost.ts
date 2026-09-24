// app/components/Shipping/option-cost.ts
//
// Formatting and validation for shipping option costs (TASK 5)

import type { OptionCostType, OptionBracket } from '~/lib/shipping/types';
import type { Locale } from '~/lib/i18n/locales';
import { formatMoneyExact } from '~/lib/billing/money';

/** L'errore per dati che non hanno la forma di una lista di fasce. */
export const INVALID_BRACKETS = 'shipping.errors.invalidBrackets';

/** Un numero vero: `typeof` scarta le stringhe, `isFinite` NaN e Infinity. */
const numeroFinito = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * La forma di una fascia opzione, prima delle regole di contiguita'.
 */
function formaValida(b: unknown): b is OptionBracket {
  if (typeof b !== 'object' || b === null) return false;
  const { from, to, cost } = b as Record<string, unknown>;
  return (
    numeroFinito(cost) &&
    (from === null || numeroFinito(from)) &&
    (to === null || numeroFinito(to))
  );
}

/**
 * Formats the indicative cost of a shipping option based on its cost type and rates.
 *
 * - flat: shows the single cost
 * - linear: shows cost/kg
 * - weight_brackets/value_brackets: shows min-max range
 * - empty rates: returns "—"
 */
export function formatIndicativeOptionCost(
  costType: OptionCostType,
  rates: OptionBracket[],
  currency: string,
  locale: Locale,
): string {
  if (rates.length === 0) return '—';

  if (costType === 'flat') {
    return formatMoneyExact(rates[0].cost, currency, locale);
  }

  if (costType === 'linear') {
    return `${formatMoneyExact(rates[0].cost, currency, locale)}/kg`;
  }

  // Brackets: show min-max range
  const costs = rates.map((r) => r.cost);
  const min = Math.min(...costs);
  const max = Math.max(...costs);

  if (min === max) {
    return formatMoneyExact(min, currency, locale);
  }

  return `${formatMoneyExact(min, currency, locale)} – ${formatMoneyExact(max, currency, locale)}`;
}

/**
 * Validates option brackets for weight_brackets or value_brackets cost types.
 *
 * Rules:
 * - For flat/linear: no validation needed (they don't use brackets)
 * - For brackets types:
 *   - At least one bracket required
 *   - First bracket must start at 0
 *   - Brackets must be contiguous (no gaps, no overlaps)
 *   - Only the last bracket can have to = null (unlimited)
 *   - All costs must be >= 0
 *   - from must be <= to (when to is not null)
 *   - Every value must be a finite number (or null where allowed)
 *
 * @param costType The cost type of the option
 * @param input The option brackets to validate
 * @returns The i18n key of the error, or null if valid
 */
export function validateOptionBrackets(costType: OptionCostType, input: unknown): string | null {
  // For flat/linear, no bracket validation
  if (costType === 'flat' || costType === 'linear') {
    return null;
  }

  if (!Array.isArray(input) || !input.every(formaValida)) {
    return INVALID_BRACKETS;
  }
  const brackets: OptionBracket[] = input;

  if (brackets.length === 0) {
    return 'shipping.errors.atLeastOneBracket';
  }

  // First pass: check each bracket's internal validity
  for (const bracket of brackets) {
    // Cost must be non-negative
    if (bracket.cost < 0) {
      return 'shipping.errors.costMustBeNonNegative';
    }

    // from must be <= to (when to is not null)
    if (bracket.to !== null && (bracket.from ?? 0) > bracket.to) {
      return 'shipping.errors.weightFromGreaterThanWeightTo';
    }
  }

  // Sort by from to check for gaps/overlaps
  const sorted = [...brackets].sort((a, b) => {
    const aFrom = a.from ?? 0;
    const bFrom = b.from ?? 0;
    return aFrom - bFrom;
  });

  // First bracket must start at 0
  if ((sorted[0].from ?? 0) !== 0) {
    return 'shipping.errors.firstBracketMustStartAtZero';
  }

  for (let i = 0; i < sorted.length; i++) {
    const bracket = sorted[i];
    const isLast = i === sorted.length - 1;

    // Only the last bracket can be unlimited
    if (!isLast && bracket.to === null) {
      return 'shipping.errors.onlyLastBracketCanBeUnlimited';
    }

    // Check contiguity with next bracket
    if (!isLast) {
      const nextBracket = sorted[i + 1];
      const currentTo = bracket.to;
      const nextFrom = nextBracket.from ?? 0;

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

/**
 * Le fasce opzione dal campo del form, gia' validate.
 *
 * Il JSON malformato e' un errore di validazione come gli altri, non
 * un'eccezione: l'azione risponde con la chiave e il merchant vede un
 * messaggio, invece di una pagina di errore.
 */
export function parseOptionBrackets(
  costType: OptionCostType,
  raw: string | undefined,
): { brackets: OptionBracket[]; error: null } | { brackets: null; error: string } {
  if (!raw) return { brackets: null, error: INVALID_BRACKETS };
  let dati: unknown;
  try {
    dati = JSON.parse(raw);
  } catch {
    return { brackets: null, error: INVALID_BRACKETS };
  }
  const error = validateOptionBrackets(costType, dati);
  if (error) return { brackets: null, error };
  return { brackets: dati as OptionBracket[], error: null };
}
