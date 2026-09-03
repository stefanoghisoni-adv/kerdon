import { describe, it, expect } from 'vitest';
import { filterProblemVariants } from './problem-filter';
import { pageCount, pageSlice } from '~/lib/table/pagination';
import type { ProblemVariant } from './product-readiness';

const row = (over: Partial<ProblemVariant>): ProblemVariant =>
  ({
    productId: 100,
    productTitle: 'Maglietta',
    variantId: 1,
    variantTitle: 'Rossa',
    sku: 'MAG-R',
    price: '29.90',
    inventoryItemId: 9,
    missingField: 'cost_per_item',
    ...over,
  } as ProblemVariant);

describe('filterProblemVariants', () => {
  const rows = [
    row({ variantId: 1 }),
    row({ variantId: 2, productTitle: 'Cappello', variantTitle: 'Blu', sku: 'CAP-B', price: '15.00', productId: 200 }),
  ];

  it('query vuota → tutte le righe', () => {
    expect(filterProblemVariants(rows, '')).toHaveLength(2);
    expect(filterProblemVariants(rows, '   ')).toHaveLength(2);
  });
  it('cerca nel titolo prodotto', () => {
    expect(filterProblemVariants(rows, 'cappello')).toHaveLength(1);
  });
  it('cerca nel titolo variante', () => {
    expect(filterProblemVariants(rows, 'rossa')).toHaveLength(1);
  });
  it('cerca nello SKU', () => {
    expect(filterProblemVariants(rows, 'CAP-B')).toHaveLength(1);
  });
  it("cerca nell'ID prodotto", () => {
    expect(filterProblemVariants(rows, '200')).toHaveLength(1);
  });
  it('cerca nel prezzo', () => {
    expect(filterProblemVariants(rows, '15.00')).toHaveLength(1);
  });
  it('e insensibile alle maiuscole', () => {
    expect(filterProblemVariants(rows, 'MAGLIETTA')).toHaveLength(1);
  });
  it('nessuna corrispondenza → lista vuota', () => {
    expect(filterProblemVariants(rows, 'inesistente')).toHaveLength(0);
  });
  it('sku o prezzo null non fanno esplodere il confronto', () => {
    const withNulls = [row({ sku: null, price: null })];
    expect(() => filterProblemVariants(withNulls, 'x')).not.toThrow();
    expect(filterProblemVariants(withNulls, 'maglietta')).toHaveLength(1);
  });
});

describe('pageCount', () => {
  it('nessuna riga → nessuna pagina', () => expect(pageCount(0, 20)).toBe(0));
  it('esattamente una pagina', () => expect(pageCount(20, 20)).toBe(1));
  it('una riga in piu → due pagine', () => expect(pageCount(21, 20)).toBe(2));
});

describe('pageSlice', () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);
  it('prima pagina', () => expect(pageSlice(rows, 1, 20)).toHaveLength(20));
  it('ultima pagina parziale', () => expect(pageSlice(rows, 2, 20)).toEqual(rows.slice(20)));
  it('pagina oltre la fine → vuota', () => expect(pageSlice(rows, 9, 20)).toEqual([]));
});
