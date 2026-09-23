// app/components/Shipping/packaging.ts
import type { PackagingCategory, FallbackRule } from '~/lib/shipping/types';

export interface PackagingInput {
  categories: PackagingCategory[];
  rules: FallbackRule[];
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
 *
 * @param input The packaging configuration to validate
 * @returns The i18n key of the error, or null if valid
 */
export function validatePackaging(input: PackagingInput): string | null {
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
