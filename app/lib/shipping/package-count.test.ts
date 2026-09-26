// app/lib/shipping/package-count.test.ts
//
// Quanti pacchi ha spedito un ordine: per ogni spedizione (fulfillment)
// partita davvero, i suoi numeri di tracking distinti; una spedizione senza
// tracking vale un pacco.

import { describe, it, expect } from 'vitest';
import { countShippedPackages } from './package-count';

const tr = (...numeri: Array<string | null>) => numeri.map((number) => ({ number }));

describe('countShippedPackages', () => {
  it('multi-collo: una spedizione con tre tracking distinti sono tre pacchi', () => {
    expect(countShippedPackages([{ status: 'SUCCESS', trackingInfo: tr('A', 'B', 'C') }])).toBe(3);
  });

  it('tracking duplicati si contano una volta, stringhe vuote o nulle si ignorano', () => {
    expect(countShippedPackages([{ status: 'SUCCESS', trackingInfo: tr('A', 'A', '', '  ', null, 'B') }])).toBe(2);
    // Stesso numero con spazi attorno: e' lo stesso pacco.
    expect(countShippedPackages([{ status: 'SUCCESS', trackingInfo: tr('A', ' A ') }])).toBe(1);
  });

  it('una spedizione senza tracking vale un pacco', () => {
    expect(countShippedPackages([{ status: 'SUCCESS', trackingInfo: [] }])).toBe(1);
    expect(countShippedPackages([{ status: 'SUCCESS', trackingInfo: tr('', null) }])).toBe(1);
    expect(countShippedPackages([{ status: 'SUCCESS' }])).toBe(1);
  });

  it('si somma spedizione per spedizione', () => {
    expect(
      countShippedPackages([
        { status: 'SUCCESS', trackingInfo: tr('A', 'B') },
        { status: 'SUCCESS', trackingInfo: [] },
        // Lo stesso numero su due spedizioni diverse: il conteggio e' per spedizione.
        { status: 'SUCCESS', trackingInfo: tr('A') },
      ]),
    ).toBe(4);
  });

  it('CANCELLED, ERROR e FAILURE non contano, nemmeno con i tracking', () => {
    expect(
      countShippedPackages([
        { status: 'CANCELLED', trackingInfo: tr('X', 'Y') },
        { status: 'ERROR', trackingInfo: tr('Z') },
        { status: 'FAILURE', trackingInfo: [] },
        { status: 'SUCCESS', trackingInfo: tr('A') },
      ]),
    ).toBe(1);
    expect(countShippedPackages([{ status: 'CANCELLED', trackingInfo: tr('X') }])).toBe(0);
  });

  it('OPEN e PENDING (deprecati) contano, se Shopify li restituisce ancora', () => {
    expect(countShippedPackages([{ status: 'OPEN', trackingInfo: tr('A', 'B') }, { status: 'PENDING' }])).toBe(3);
  });

  it('lo stato si confronta senza badare alle maiuscole', () => {
    expect(countShippedPackages([{ status: 'cancelled' }, { status: 'success' }])).toBe(1);
  });

  it('stato assente o sconosciuto: non conta, non sappiamo se e\' partita', () => {
    expect(countShippedPackages([{ status: null }, {}, { status: 'QUALCOSA', trackingInfo: tr('A') }])).toBe(0);
  });

  it('nessuna spedizione, lista assente o elementi nulli: zero', () => {
    expect(countShippedPackages([])).toBe(0);
    expect(countShippedPackages(null)).toBe(0);
    expect(countShippedPackages(undefined)).toBe(0);
    expect(countShippedPackages([null, { status: 'SUCCESS' }])).toBe(1);
  });
});
