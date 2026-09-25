// app/components/Shipping/packaging-edit.test.ts
//
// Le modifiche a una categoria o a una regola alla volta, come le fa la
// tabella: aggiungi, modifica, elimina. Il server le applica alla
// configurazione salvata, quindi qui si prova tutto quello che decide se una
// modifica passa e cosa ne esce.

import { describe, it as prova, expect } from 'vitest';
import {
  deleteCategory,
  deleteRule,
  normalizeOrigin,
  saveCategory,
  saveRule,
  sortRules,
} from './packaging-edit';
import type { PackagingInput } from './packaging';

const base = (): PackagingInput => ({
  categories: [
    { name: 'Busta', cost: 1.5, origin: 'manual' },
    { name: 'Scatola', cost: 3, origin: 'shopify' },
  ],
  rules: [
    { weightMaxKg: 1, category: 'Busta' },
    { weightMaxKg: null, category: 'Scatola' },
  ],
});

describe('normalizeOrigin', () => {
  prova("'shopify' resta 'shopify'", () => {
    expect(normalizeOrigin('shopify')).toBe('shopify');
  });

  prova("assente, sconosciuta o di un altro tipo vale 'manual'", () => {
    expect(normalizeOrigin(undefined)).toBe('manual');
    expect(normalizeOrigin(null)).toBe('manual');
    expect(normalizeOrigin('amazon')).toBe('manual');
    expect(normalizeOrigin(1)).toBe('manual');
    expect(normalizeOrigin('manual')).toBe('manual');
  });
});

describe('saveCategory: aggiungere', () => {
  prova('in coda, creata dal merchant, nome ripulito dagli spazi', () => {
    const esito = saveCategory(base(), null, { name: '  Tubo  ', cost: 2 });
    expect(esito.error).toBeNull();
    expect(esito.value!.categories).toEqual([
      { name: 'Busta', cost: 1.5, origin: 'manual' },
      { name: 'Scatola', cost: 3, origin: 'shopify' },
      { name: 'Tubo', cost: 2, origin: 'manual' },
    ]);
    expect(esito.value!.rules).toEqual(base().rules);
  });

  prova('nome vuoto o di soli spazi: rifiutata', () => {
    expect(saveCategory(base(), null, { name: '   ', cost: 2 }).error).toBe(
      'shipping.packaging.errors.categoryNameEmpty',
    );
  });

  prova('stesso nome di una esistente, anche con maiuscole e spazi diversi: rifiutata', () => {
    expect(saveCategory(base(), null, { name: ' busta ', cost: 2 }).error).toBe(
      'shipping.packaging.errors.categoryNameDuplicate',
    );
  });

  prova('costo negativo o non finito: rifiutata', () => {
    expect(saveCategory(base(), null, { name: 'Tubo', cost: -1 }).error).toBe(
      'shipping.packaging.errors.categoryCostNegative',
    );
    expect(saveCategory(base(), null, { name: 'Tubo', cost: Number.NaN }).error).toBe(
      'shipping.packaging.errors.categoryCostNegative',
    );
    expect(saveCategory(base(), null, { name: 'Tubo', cost: Infinity }).error).toBe(
      'shipping.packaging.errors.categoryCostNegative',
    );
  });

  prova("non tocca la configurazione ricevuta", () => {
    const config = base();
    saveCategory(config, null, { name: 'Tubo', cost: 2 });
    expect(config).toEqual(base());
  });
});

describe('saveCategory: modificare', () => {
  prova('cambia costo e nome, tiene l origine e rinomina le regole che la usano', () => {
    const esito = saveCategory(base(), 'Scatola', { name: 'Scatola media', cost: 4 });
    expect(esito.error).toBeNull();
    expect(esito.value!.categories[1]).toEqual({ name: 'Scatola media', cost: 4, origin: 'shopify' });
    expect(esito.value!.rules).toEqual([
      { weightMaxKg: 1, category: 'Busta' },
      { weightMaxKg: null, category: 'Scatola media' },
    ]);
  });

  prova('tenere lo stesso nome, o cambiarne solo le maiuscole, non e un duplicato', () => {
    expect(saveCategory(base(), 'Busta', { name: 'Busta', cost: 9 }).error).toBeNull();
    const esito = saveCategory(base(), 'Busta', { name: 'BUSTA', cost: 9 });
    expect(esito.error).toBeNull();
    expect(esito.value!.rules[0].category).toBe('BUSTA');
  });

  prova('il nome di un altra categoria: rifiutata', () => {
    expect(saveCategory(base(), 'Busta', { name: 'scatola', cost: 1 }).error).toBe(
      'shipping.packaging.errors.categoryNameDuplicate',
    );
  });

  prova('una categoria che non c e piu: rifiutata', () => {
    expect(saveCategory(base(), 'Pallet', { name: 'Pallet', cost: 1 }).error).toBe(
      'shipping.packaging.errors.categoryNotFound',
    );
  });
});

describe('deleteCategory', () => {
  prova('una categoria che nessuna regola usa se ne va', () => {
    const config = { ...base(), categories: [...base().categories, { name: 'Tubo', cost: 2 }] };
    const esito = deleteCategory(config, 'Tubo');
    expect(esito.error).toBeNull();
    expect(esito.value!.categories.map((c) => c.name)).toEqual(['Busta', 'Scatola']);
  });

  prova('usata da una regola: bloccata', () => {
    expect(deleteCategory(base(), 'Busta').error).toBe('shipping.packaging.errors.categoryStillReferenced');
  });

  prova('che non c e piu: rifiutata', () => {
    expect(deleteCategory(base(), 'Pallet').error).toBe('shipping.packaging.errors.categoryNotFound');
  });
});

describe('sortRules', () => {
  prova('dal peso piu basso al piu alto, "tutto il resto" in fondo', () => {
    expect(
      sortRules([
        { weightMaxKg: null, category: 'C' },
        { weightMaxKg: 5, category: 'B' },
        { weightMaxKg: 1, category: 'A' },
      ]),
    ).toEqual([
      { weightMaxKg: 1, category: 'A' },
      { weightMaxKg: 5, category: 'B' },
      { weightMaxKg: null, category: 'C' },
    ]);
  });
});

describe('saveRule', () => {
  prova('aggiunge e rimette le regole in ordine di peso', () => {
    const esito = saveRule(base(), null, { weightMaxKg: 3, category: 'Scatola' });
    expect(esito.error).toBeNull();
    expect(esito.value!.rules).toEqual([
      { weightMaxKg: 1, category: 'Busta' },
      { weightMaxKg: 3, category: 'Scatola' },
      { weightMaxKg: null, category: 'Scatola' },
    ]);
  });

  prova('modifica la regola indicata', () => {
    const esito = saveRule(base(), 0, { weightMaxKg: 2, category: 'Scatola' });
    expect(esito.error).toBeNull();
    expect(esito.value!.rules[0]).toEqual({ weightMaxKg: 2, category: 'Scatola' });
  });

  prova('una seconda regola "tutto il resto": rifiutata', () => {
    expect(saveRule(base(), null, { weightMaxKg: null, category: 'Busta' }).error).toBe(
      'shipping.packaging.errors.multipleUnlimitedRules',
    );
  });

  prova('trasformare l unica "tutto il resto" in se stessa va bene', () => {
    expect(saveRule(base(), 1, { weightMaxKg: null, category: 'Busta' }).error).toBeNull();
  });

  prova('categoria inesistente, peso negativo o non finito: rifiutata', () => {
    expect(saveRule(base(), null, { weightMaxKg: 2, category: 'Pallet' }).error).toBe(
      'shipping.packaging.errors.ruleInvalidCategory',
    );
    expect(saveRule(base(), null, { weightMaxKg: -1, category: 'Busta' }).error).toBe(
      'shipping.packaging.errors.ruleWeightNegative',
    );
    expect(saveRule(base(), null, { weightMaxKg: Number.NaN, category: 'Busta' }).error).toBe(
      'shipping.packaging.errors.ruleWeightNegative',
    );
  });

  prova('indice fuori dall elenco: rifiutata', () => {
    expect(saveRule(base(), 7, { weightMaxKg: 2, category: 'Busta' }).error).toBe(
      'shipping.packaging.errors.ruleNotFound',
    );
  });
});

describe('deleteRule', () => {
  prova('toglie la regola indicata', () => {
    const esito = deleteRule(base(), 0);
    expect(esito.error).toBeNull();
    expect(esito.value!.rules).toEqual([{ weightMaxKg: null, category: 'Scatola' }]);
  });

  prova('indice fuori dall elenco: rifiutata', () => {
    expect(deleteRule(base(), 2).error).toBe('shipping.packaging.errors.ruleNotFound');
    expect(deleteRule(base(), -1).error).toBe('shipping.packaging.errors.ruleNotFound');
  });
});
