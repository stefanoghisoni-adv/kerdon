// app/components/Shipping/packaging.ts
import type { PackagingCategory, FallbackRule } from '~/lib/shipping/types';

export interface PackagingInput {
  categories: PackagingCategory[];
  rules: FallbackRule[];
}

/** L'errore per dati che non hanno la forma di una configurazione packaging. */
export const INVALID_PACKAGING = 'shipping.packaging.errors.invalidData';

const numeroFinito = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * La forma di categorie e regole, prima delle regole di coerenza.
 *
 * Arrivano dal client come JSON: una stringa al posto del costo passerebbe il
 * controllo `cost < 0` e finirebbe salvata cosi' nel JSON della
 * configurazione, e il calcolo del costo la sommerebbe come testo.
 */
function formaValida(input: unknown): input is PackagingInput {
  if (typeof input !== 'object' || input === null) return false;
  const { categories, rules } = input as Record<string, unknown>;
  if (!Array.isArray(categories) || !Array.isArray(rules)) return false;
  const categorieOk = categories.every(
    (c) => typeof c === 'object' && c !== null && typeof c.name === 'string' && numeroFinito(c.cost),
  );
  const regoleOk = rules.every(
    (r) =>
      typeof r === 'object' &&
      r !== null &&
      typeof r.category === 'string' &&
      (r.weightMaxKg === null || numeroFinito(r.weightMaxKg)),
  );
  return categorieOk && regoleOk;
}

/**
 * Validates packaging configuration.
 *
 * Rules:
 * - Category names must be non-empty and unique
 * - Category costs must be >= 0
 * - Rules must reference existing categories
 * - Rule weights must be >= 0 (when not null)
 * - At most one "tutto il resto" rule (weightMaxKg = null)
 * - The "tutto il resto" rule, if present, must be last
 * - Every cost and weight must be a finite number (weights may be null)
 *
 * @param input The packaging configuration to validate
 * @returns The i18n key of the error, or null if valid
 */
export function validatePackaging(input: unknown): string | null {
  if (!formaValida(input)) return INVALID_PACKAGING;
  const { categories, rules } = input;

  // Validate categories
  const categoryNames = new Set<string>();

  for (const category of categories) {
    // Name must be non-empty
    if (!category.name || category.name.trim() === '') {
      return 'shipping.packaging.errors.categoryNameEmpty';
    }

    // Name must be unique
    if (categoryNames.has(category.name)) {
      return 'shipping.packaging.errors.categoryNameDuplicate';
    }
    categoryNames.add(category.name);

    // Cost must be non-negative
    if (category.cost < 0) {
      return 'shipping.packaging.errors.categoryCostNegative';
    }
  }

  // Validate rules
  let unlimitedRuleIndex = -1;

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];

    // Rule must reference an existing category
    if (!categoryNames.has(rule.category)) {
      return 'shipping.packaging.errors.ruleInvalidCategory';
    }

    // Weight must be non-negative (when not null)
    if (rule.weightMaxKg !== null && rule.weightMaxKg < 0) {
      return 'shipping.packaging.errors.ruleWeightNegative';
    }

    // Track unlimited rules
    if (rule.weightMaxKg === null) {
      if (unlimitedRuleIndex !== -1) {
        // Multiple unlimited rules
        return 'shipping.packaging.errors.multipleUnlimitedRules';
      }
      unlimitedRuleIndex = i;
    }
  }

  // If there's an unlimited rule, it must be the last one
  if (unlimitedRuleIndex !== -1 && unlimitedRuleIndex !== rules.length - 1) {
    return 'shipping.packaging.errors.unlimitedRuleMustBeLast';
  }

  return null;
}

/**
 * Categorie e regole dai campi del form, gia' validate.
 *
 * Come per le fasce: il JSON malformato torna come errore di validazione, non
 * come eccezione.
 */
export function parsePackaging(
  categoriesRaw: string | undefined,
  rulesRaw: string | undefined,
): { value: PackagingInput; error: null } | { value: null; error: string } {
  if (!categoriesRaw || !rulesRaw) return { value: null, error: INVALID_PACKAGING };
  let value: unknown;
  try {
    value = { categories: JSON.parse(categoriesRaw), rules: JSON.parse(rulesRaw) };
  } catch {
    return { value: null, error: INVALID_PACKAGING };
  }
  const error = validatePackaging(value);
  if (error) return { value: null, error };
  return { value: value as PackagingInput, error: null };
}
