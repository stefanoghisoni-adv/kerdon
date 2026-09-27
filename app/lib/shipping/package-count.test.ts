// app/lib/shipping/package-count.test.ts
//
// Quanti pacchi ha spedito un ordine. Il tracking fa fede: una spedizione con
// tracking porta i suoi numeri distinti qualunque sia lo stato; senza tracking
// vale un pacco solo se SUCCESS, OPEN o PENDING.

import { describe, it, expect } from 'vitest';
import { countShippedPackages, orderShipped } from './package-count';

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

  it('CANCELLED con un tracking: il pacco e\' stato consegnato al corriere, conta', () => {
    expect(countShippedPackages([{ status: 'CANCELLED', trackingInfo: tr('BRT9') }])).toBe(1);
  });

  it('ERROR con due tracking distinti: due pacchi', () => {
    expect(countShippedPackages([{ status: 'ERROR', trackingInfo: tr('X', 'Y', 'X') }])).toBe(2);
  });

  it('senza tracking CANCELLED, ERROR e FAILURE valgono zero', () => {
    expect(
      countShippedPackages([
        { status: 'CANCELLED', trackingInfo: [] },
        { status: 'ERROR', trackingInfo: tr('', null) },
        { status: 'FAILURE' },
        { status: 'SUCCESS', trackingInfo: tr('A') },
      ]),
    ).toBe(1);
    expect(countShippedPackages([{ status: 'CANCELLED', trackingInfo: [] }])).toBe(0);
  });

  it('OPEN e PENDING (deprecati) contano, se Shopify li restituisce ancora', () => {
    expect(countShippedPackages([{ status: 'OPEN', trackingInfo: tr('A', 'B') }, { status: 'PENDING' }])).toBe(3);
  });

  it('lo stato si confronta senza badare alle maiuscole', () => {
    expect(countShippedPackages([{ status: 'cancelled' }, { status: 'success' }])).toBe(1);
  });

  it('stato assente o sconosciuto senza tracking: non conta; con tracking si\'', () => {
    expect(countShippedPackages([{ status: null }, {}, { status: 'QUALCOSA' }])).toBe(0);
    expect(countShippedPackages([{ status: 'QUALCOSA', trackingInfo: tr('A') }])).toBe(1);
  });

  it('nessuna spedizione, lista assente o elementi nulli: zero', () => {
    expect(countShippedPackages([])).toBe(0);
    expect(countShippedPackages(null)).toBe(0);
    expect(countShippedPackages(undefined)).toBe(0);
    expect(countShippedPackages([null, { status: 'SUCCESS' }])).toBe(1);
  });
});

describe('orderShipped', () => {
  it('spedito se una spedizione ha un tracking, qualunque stato', () => {
    expect(orderShipped([{ status: 'CANCELLED', trackingInfo: tr('BRT9') }])).toBe(true);
    expect(orderShipped([{ status: 'ERROR', trackingInfo: tr('X') }])).toBe(true);
  });

  it('spedito se una spedizione e\' SUCCESS, OPEN o PENDING, anche senza tracking', () => {
    expect(orderShipped([{ status: 'SUCCESS', trackingInfo: [] }])).toBe(true);
    expect(orderShipped([{ status: 'pending' }])).toBe(true);
  });

  it('non spedito con sole spedizioni annullate o fallite senza tracking, o senza spedizioni', () => {
    expect(orderShipped([{ status: 'CANCELLED', trackingInfo: [] }, { status: 'FAILURE', trackingInfo: tr('') }])).toBe(false);
    expect(orderShipped([])).toBe(false);
    expect(orderShipped(null)).toBe(false);
  });
});
