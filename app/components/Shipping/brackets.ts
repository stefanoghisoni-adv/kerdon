// app/components/Shipping/brackets.ts
import type { RateBracket } from '~/lib/shipping/types';

/** L'errore per dati che non hanno la forma di una lista di fasce. */
export const INVALID_BRACKETS = 'shipping.errors.invalidBrackets';

/** Un numero vero: `typeof` scarta le stringhe, `isFinite` NaN e Infinity. */
const numeroFinito = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * La forma di una fascia, prima delle regole di contiguita'.
 *
 * Le fasce arrivano dal client come JSON: il tipo dichiarato non garantisce
 * niente. Una stringa al posto di un numero passerebbe i confronti (`'5' < 0`
 * e' falso) e finirebbe in un Decimal; `1e999` nel JSON diventa Infinity.
 */
function formaValida(b: unknown): b is RateBracket {
  if (typeof b !== 'object' || b === null) return false;
  const { weightFromKg, weightToKg, cost } = b as Record<string, unknown>;
  return (
    numeroFinito(cost) &&
    (weightFromKg === null || numeroFinito(weightFromKg)) &&
    (weightToKg === null || numeroFinito(weightToKg))
  );
}

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
 * - Every value must be a finite number (or null where allowed)
 *
 * @param brackets The rate brackets to validate
 * @returns The i18n key of the error, or null if valid
 */
export function validateBrackets(input: unknown): string | null {
  if (!Array.isArray(input) || !input.every(formaValida)) {
    return INVALID_BRACKETS;
  }
  const brackets: RateBracket[] = input;

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

/**
 * Le fasce dal campo del form, gia' validate.
 *
 * Il JSON malformato e' un errore di validazione come gli altri, non
 * un'eccezione: l'azione risponde con la chiave e il merchant vede un
 * messaggio, invece di una pagina di errore.
 */
export function parseBrackets(
  raw: string | undefined,
  /**
   * Porta il JSON letto nella forma delle fasce di zona prima di validarlo.
   * Serve alle fasce delle opzioni, che hanno gli stessi vincoli con campi
   * dal nome diverso: cosi' le regole restano scritte in un posto solo.
   */
  adatta: (dati: unknown) => unknown = (dati) => dati,
): { brackets: RateBracket[]; error: null } | { brackets: null; error: string } {
  if (!raw) return { brackets: null, error: INVALID_BRACKETS };
  let dati: unknown;
  try {
    dati = adatta(JSON.parse(raw));
  } catch {
    return { brackets: null, error: INVALID_BRACKETS };
  }
  const error = validateBrackets(dati);
  if (error) return { brackets: null, error };
  return { brackets: dati as RateBracket[], error: null };
}
