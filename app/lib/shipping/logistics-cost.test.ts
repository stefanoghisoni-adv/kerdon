// app/lib/shipping/logistics-cost.test.ts
import { describe, it, expect } from 'vitest';
import { computeLogisticsCost, findZone, isShipped, resolvePackagingCategory, resolveWeightKg } from './logistics-cost';
import type { LogisticsConfig, OrderLogisticsInput } from './types';

const config: LogisticsConfig = {
  zones: [
    { zoneName: 'Italia', countries: ['IT'], restOfWorld: false, rateType: 'linear', rates: [{ weightFromKg: null, weightToKg: null, cost: 2 }] },
    { zoneName: 'UE', countries: ['FR', 'DE'], restOfWorld: false, rateType: 'brackets', rates: [
      { weightFromKg: 0, weightToKg: 1, cost: 5 },
      { weightFromKg: 1, weightToKg: 5, cost: 8 },
      { weightFromKg: 5, weightToKg: null, cost: 15 },
    ] },
    { zoneName: 'Mondo', countries: [], restOfWorld: true, rateType: 'linear', rates: [{ weightFromKg: null, weightToKg: null, cost: 10 }] },
  ],
  categories: [{ name: 'Busta', cost: 1.5 }, { name: 'Box', cost: 3 }],
  fallbackRules: [{ weightMaxKg: 1, category: 'Busta' }, { weightMaxKg: null, category: 'Box' }],
  defaultWeightPerItemKg: 0.5,
  returnCost: 5,
};

const base: OrderLogisticsInput = {
  fulfillment_status: 'fulfilled', shipping_country_code: 'IT', total_weight_grams: 3000,
  item_count: 2, returned_at: null, packaging_category: 'Box',
};

describe('isShipped', () => {
  it('spedito, parziale e con tracking contano', () => {
    expect(isShipped('fulfilled')).toBe(true);
    expect(isShipped('FULFILLED')).toBe(true);
    expect(isShipped('PARTIALLY_FULFILLED')).toBe(true);
  });
  it('non spedito o sconosciuto non conta', () => {
    expect(isShipped('UNFULFILLED')).toBe(false);
    expect(isShipped(null)).toBe(false);
  });
});

describe('resolveWeightKg', () => {
  it('usa il peso dell ordine in grammi', () => {
    expect(resolveWeightKg(base, 0.5)).toBe(3);
  });
  it('peso assente o zero: default per articolo x articoli', () => {
    expect(resolveWeightKg({ ...base, total_weight_grams: 0 }, 0.5)).toBe(1);
    expect(resolveWeightKg({ ...base, total_weight_grams: null }, 0.5)).toBe(1);
  });
  it('niente peso e niente default: null', () => {
    expect(resolveWeightKg({ ...base, total_weight_grams: null }, null)).toBeNull();
  });
});

describe('resolvePackagingCategory', () => {
  it('quella indicata dall ordine vince', () => {
    expect(resolvePackagingCategory('Busta', 10, config.fallbackRules)).toBe('Busta');
  });
  it('altrimenti la prima regola che combacia col peso', () => {
    expect(resolvePackagingCategory(null, 0.8, config.fallbackRules)).toBe('Busta');
    expect(resolvePackagingCategory(null, 3, config.fallbackRules)).toBe('Box');
  });
  it('senza peso: null', () => {
    expect(resolvePackagingCategory(null, null, config.fallbackRules)).toBeNull();
  });
});

describe('findZone', () => {
  it('paese elencato', () => {
    expect(findZone(config.zones, 'FR')?.zoneName).toBe('UE');
  });
  it('paese non elencato cade nel resto del mondo', () => {
    expect(findZone(config.zones, 'US')?.zoneName).toBe('Mondo');
  });
  it('senza resto del mondo: null', () => {
    expect(findZone(config.zones.slice(0, 2), 'US')).toBeNull();
  });
});

describe('computeLogisticsCost', () => {
  it('lineare: 3 kg x 2 = 6, piu packaging Box 3', () => {
    expect(computeLogisticsCost(base, config)).toEqual({ shipping: 6, packaging: 3, returns: 0, total: 9 });
  });
  it('fasce: 4 kg in UE = 8', () => {
    const c = computeLogisticsCost({ ...base, shipping_country_code: 'FR', total_weight_grams: 4000 }, config);
    expect(c.shipping).toBe(8);
  });
  it('confine di fascia: 1 kg esatto cade nella fascia 1-5', () => {
    const c = computeLogisticsCost({ ...base, shipping_country_code: 'FR', total_weight_grams: 1000 }, config);
    expect(c.shipping).toBe(8);
  });
  it('packaging assente sull ordine: regola di fallback', () => {
    const c = computeLogisticsCost({ ...base, packaging_category: null, total_weight_grams: 500 }, config);
    expect(c.packaging).toBe(1.5);
  });
  it('non spedito: niente spedizione ne packaging', () => {
    const c = computeLogisticsCost({ ...base, fulfillment_status: 'UNFULFILLED' }, config);
    expect(c).toEqual({ shipping: 0, packaging: 0, returns: 0, total: 0 });
  });
  it('reso: aggiunge il costo di rientro', () => {
    const c = computeLogisticsCost({ ...base, returned_at: '2026-09-20T10:00:00Z' }, config);
    expect(c.returns).toBe(5);
    expect(c.total).toBe(14);
  });
  it('categoria non piu configurata: packaging 0, nessun errore', () => {
    const c = computeLogisticsCost({ ...base, packaging_category: 'XL' }, config);
    expect(c.packaging).toBe(0);
  });
  it('nessuna configurazione: tutto 0', () => {
    expect(computeLogisticsCost(base, null).total).toBe(0);
  });
  it('arrotonda al centesimo', () => {
    const c = computeLogisticsCost({ ...base, total_weight_grams: 1234, packaging_category: null }, { ...config, fallbackRules: [] });
    expect(c.shipping).toBe(2.47);
  });
});
