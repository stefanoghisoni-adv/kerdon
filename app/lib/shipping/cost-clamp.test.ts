// app/lib/shipping/cost-clamp.test.ts
import { describe, it, expect } from 'vitest';
import { clampLogisticsCost, MAX_LOGISTICS_COST } from './cost-clamp';

describe('clampLogisticsCost', () => {
  it('un costo normale resta com e, al centesimo', () => {
    expect(clampLogisticsCost(4.5)).toBe(4.5);
    expect(clampLogisticsCost(2.4681)).toBe(2.47);
    expect(clampLogisticsCost(0)).toBe(0);
  });
  it('negativo diventa zero', () => {
    expect(clampLogisticsCost(-5)).toBe(0);
  });
  it('non finito diventa zero', () => {
    expect(clampLogisticsCost(Number.NaN)).toBe(0);
    expect(clampLogisticsCost(Number.POSITIVE_INFINITY)).toBe(0);
  });
  it('oltre il tetto di NUMERIC(10,2) diventa zero', () => {
    expect(clampLogisticsCost(MAX_LOGISTICS_COST)).toBe(MAX_LOGISTICS_COST);
    expect(clampLogisticsCost(MAX_LOGISTICS_COST + 1)).toBe(0);
    expect(clampLogisticsCost(1e12)).toBe(0);
  });
});
