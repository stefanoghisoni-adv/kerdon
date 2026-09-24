import { describe, it, expect } from 'vitest';
import { parsePackaging, validatePackaging } from './packaging';
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

describe('validatePackaging — tipi', () => {
  const INVALIDO = 'shipping.packaging.errors.invalidData';
  it('rifiuta categorie o regole che non sono liste', () => {
    expect(validatePackaging({ categories: {} , rules: [] } as unknown)).toBe(INVALIDO);
    expect(validatePackaging({ categories: [], rules: 'x' } as unknown)).toBe(INVALIDO);
  });
  it('rifiuta un costo di categoria stringa', () => {
    expect(validatePackaging({ categories: [{ name: 'Busta', cost: '1.5' }], rules: [] } as unknown)).toBe(INVALIDO);
  });
  it('rifiuta un costo di categoria non finito', () => {
    expect(validatePackaging({ categories: [{ name: 'Busta', cost: Infinity }], rules: [] })).toBe(INVALIDO);
  });
  it('rifiuta un nome che non e una stringa', () => {
    expect(validatePackaging({ categories: [{ name: 42, cost: 1 }], rules: [] } as unknown)).toBe(INVALIDO);
  });
  it('rifiuta un peso di regola che non e un numero finito ne null', () => {
    const categories = [{ name: 'Busta', cost: 1 }];
    expect(validatePackaging({ categories, rules: [{ weightMaxKg: '1', category: 'Busta' }] } as unknown)).toBe(INVALIDO);
    expect(validatePackaging({ categories, rules: [{ weightMaxKg: NaN, category: 'Busta' }] })).toBe(INVALIDO);
  });
});

describe('parsePackaging', () => {
  it('JSON valido: restituisce categorie e regole', () => {
    const r = parsePackaging(JSON.stringify([{ name: 'Busta', cost: 1 }]), JSON.stringify([{ weightMaxKg: null, category: 'Busta' }]));
    expect(r).toEqual({
      value: { categories: [{ name: 'Busta', cost: 1 }], rules: [{ weightMaxKg: null, category: 'Busta' }] },
      error: null,
    });
  });
  it("tiene un'origine valida e scarta quelle sconosciute e i campi estranei", () => {
    const r = parsePackaging(
      JSON.stringify([
        { name: 'A', cost: 1, origin: 'shopify' },
        { name: 'B', cost: 1, origin: 'manual' },
        { name: 'C', cost: 1, origin: 'altro', extra: true },
      ]),
      '[]',
    );
    expect(r.value?.categories).toEqual([
      { name: 'A', cost: 1, origin: 'shopify' },
      { name: 'B', cost: 1, origin: 'manual' },
      { name: 'C', cost: 1 },
    ]);
  });
  it('JSON malformato: errore tipizzato, nessuna eccezione', () => {
    expect(parsePackaging('[{', '[]')).toEqual({ value: null, error: 'shipping.packaging.errors.invalidData' });
  });
  it('campi assenti: errore tipizzato', () => {
    expect(parsePackaging(undefined, undefined)).toEqual({ value: null, error: 'shipping.packaging.errors.invalidData' });
  });
  it('JSON valido ma incoerente: l errore di validazione', () => {
    expect(parsePackaging('[{"name":"Busta","cost":1}]', '[{"weightMaxKg":null,"category":"Scatola"}]').error).toBe(
      'shipping.packaging.errors.ruleInvalidCategory',
    );
  });
});
