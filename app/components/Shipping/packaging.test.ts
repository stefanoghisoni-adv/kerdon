import { describe, it, expect } from 'vitest';
import { validatePackaging } from './packaging';
import type { PackagingCategory, FallbackRule } from '~/lib/shipping/types';

describe('validatePackaging', () => {
  it('accepts valid packaging configuration', () => {
    const categories: PackagingCategory[] = [
      { name: 'Busta', cost: 1.5 },
      { name: 'Scatola piccola', cost: 3 },
      { name: 'Scatola grande', cost: 5 },
    ];
    const rules: FallbackRule[] = [
      { weightMaxKg: 0.5, category: 'Busta' },
      { weightMaxKg: 2, category: 'Scatola piccola' },
      { weightMaxKg: null, category: 'Scatola grande' },
    ];
    expect(validatePackaging({ categories, rules })).toBeNull();
  });

  it('rejects empty category name', () => {
    const categories: PackagingCategory[] = [
      { name: '', cost: 1.5 },
      { name: 'Scatola', cost: 3 },
    ];
    const rules: FallbackRule[] = [];
    expect(validatePackaging({ categories, rules })).toBe(
      'shipping.packaging.errors.categoryNameEmpty'
    );
  });

  it('rejects duplicate category names', () => {
    const categories: PackagingCategory[] = [
      { name: 'Busta', cost: 1.5 },
      { name: 'Scatola', cost: 3 },
      { name: 'Busta', cost: 2 },
    ];
    const rules: FallbackRule[] = [];
    expect(validatePackaging({ categories, rules })).toBe(
      'shipping.packaging.errors.categoryNameDuplicate'
    );
  });

  it('rejects negative category cost', () => {
    const categories: PackagingCategory[] = [
      { name: 'Busta', cost: -1.5 },
      { name: 'Scatola', cost: 3 },
    ];
    const rules: FallbackRule[] = [];
    expect(validatePackaging({ categories, rules })).toBe(
      'shipping.packaging.errors.categoryCostNegative'
    );
  });

  it('rejects rule pointing to non-existent category', () => {
    const categories: PackagingCategory[] = [
      { name: 'Busta', cost: 1.5 },
      { name: 'Scatola', cost: 3 },
    ];
    const rules: FallbackRule[] = [
      { weightMaxKg: 1, category: 'NonExistent' },
    ];
    expect(validatePackaging({ categories, rules })).toBe(
      'shipping.packaging.errors.ruleInvalidCategory'
    );
  });

  it('rejects multiple "tutto il resto" rules', () => {
    const categories: PackagingCategory[] = [
      { name: 'Busta', cost: 1.5 },
      { name: 'Scatola piccola', cost: 3 },
      { name: 'Scatola grande', cost: 5 },
    ];
    const rules: FallbackRule[] = [
      { weightMaxKg: null, category: 'Busta' },
      { weightMaxKg: 1, category: 'Scatola piccola' },
      { weightMaxKg: null, category: 'Scatola grande' },
    ];
    expect(validatePackaging({ categories, rules })).toBe(
      'shipping.packaging.errors.multipleUnlimitedRules'
    );
  });

  it('rejects "tutto il resto" rule not at the end', () => {
    const categories: PackagingCategory[] = [
      { name: 'Busta', cost: 1.5 },
      { name: 'Scatola piccola', cost: 3 },
      { name: 'Scatola grande', cost: 5 },
    ];
    const rules: FallbackRule[] = [
      { weightMaxKg: null, category: 'Busta' },
      { weightMaxKg: 5, category: 'Scatola piccola' },
    ];
    expect(validatePackaging({ categories, rules })).toBe(
      'shipping.packaging.errors.unlimitedRuleMustBeLast'
    );
  });

  it('accepts empty rules array', () => {
    const categories: PackagingCategory[] = [
      { name: 'Busta', cost: 1.5 },
    ];
    const rules: FallbackRule[] = [];
    expect(validatePackaging({ categories, rules })).toBeNull();
  });

  it('accepts single unlimited rule', () => {
    const categories: PackagingCategory[] = [
      { name: 'Busta', cost: 1.5 },
    ];
    const rules: FallbackRule[] = [
      { weightMaxKg: null, category: 'Busta' },
    ];
    expect(validatePackaging({ categories, rules })).toBeNull();
  });

  it('accepts empty categories if no rules reference them', () => {
    const categories: PackagingCategory[] = [];
    const rules: FallbackRule[] = [];
    expect(validatePackaging({ categories, rules })).toBeNull();
  });

  it('rejects negative weight in rules', () => {
    const categories: PackagingCategory[] = [
      { name: 'Busta', cost: 1.5 },
    ];
    const rules: FallbackRule[] = [
      { weightMaxKg: -1, category: 'Busta' },
    ];
    expect(validatePackaging({ categories, rules })).toBe(
      'shipping.packaging.errors.ruleWeightNegative'
    );
  });
});
