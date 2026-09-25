// app/lib/shipping/package-count.test.ts
//
// Quanti pacchi ha spedito un ordine: una spedizione di Shopify (fulfillment)
// non annullata e' un pacco.

import { describe, it, expect } from 'vitest';
import { countShippedPackages } from './package-count';

describe('countShippedPackages', () => {
  it('ogni spedizione conta come un pacco', () => {
    expect(countShippedPackages([{ status: 'SUCCESS' }, { status: 'SUCCESS' }])).toBe(2);
  });

  it('le spedizioni annullate non contano', () => {
    expect(countShippedPackages([{ status: 'SUCCESS' }, { status: 'CANCELLED' }, { status: 'SUCCESS' }])).toBe(2);
    expect(countShippedPackages([{ status: 'CANCELLED' }])).toBe(0);
  });

  it('lo stato si confronta senza badare alle maiuscole', () => {
    expect(countShippedPackages([{ status: 'cancelled' }, { status: 'success' }])).toBe(1);
  });

  it('stato assente: la spedizione conta, perche\' esiste', () => {
    expect(countShippedPackages([{ status: null }, {}])).toBe(2);
  });

  it('nessuna spedizione, lista assente o elementi nulli: zero', () => {
    expect(countShippedPackages([])).toBe(0);
    expect(countShippedPackages(null)).toBe(0);
    expect(countShippedPackages(undefined)).toBe(0);
    expect(countShippedPackages([null, { status: 'SUCCESS' }])).toBe(1);
  });
});
