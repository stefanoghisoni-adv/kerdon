// app/lib/shipping/logistics-cost.test.ts
import { describe, it, expect } from 'vitest';
import { computeLogisticsCost, findZone, isShipped, resolvePackagingCategory, resolveWeightKg } from './logistics-cost';
import type { LogisticsConfig, OrderLogisticsInput } from './types';

const config: LogisticsConfig = {
  zones: [
    { zoneName: 'Italia', countries: ['IT'], restOfWorld: false, rateType: 'linear', rates: [{ weightFromKg: null, weightToKg: null, cost: 2 }], options: [] },
    { zoneName: 'UE', countries: ['FR', 'DE'], restOfWorld: false, rateType: 'brackets', rates: [
      { weightFromKg: 0, weightToKg: 1, cost: 5 },
      { weightFromKg: 1, weightToKg: 5, cost: 8 },
      { weightFromKg: 5, weightToKg: null, cost: 15 },
    ], options: [] },
    { zoneName: 'Mondo', countries: [], restOfWorld: true, rateType: 'linear', rates: [{ weightFromKg: null, weightToKg: null, cost: 10 }], options: [] },
  ],
  categories: [{ name: 'Busta', cost: 1.5 }, { name: 'Box', cost: 3 }],
  fallbackRules: [{ weightMaxKg: 1, category: 'Busta' }, { weightMaxKg: null, category: 'Box' }],
  defaultWeightPerItemKg: 0.5,
  returnCost: 5,
};

const base: OrderLogisticsInput = {
  fulfillment_status: 'fulfilled', shipping_country_code: 'IT', total_weight_grams: 3000,
  item_count: 2, returned_at: null, packaging_category: 'Box', shipping_method: null, total_price: null,
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
  it('senza paese non si cade nel resto del mondo: null', () => {
    // Ritiro in negozio, POS, prodotti digitali: nessun indirizzo, nessun corriere.
    expect(findZone(config.zones, null)).toBeNull();
    expect(findZone(config.zones, '')).toBeNull();
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
  it('evaso senza indirizzo (ritiro, POS, digitale): niente spedizione ne packaging', () => {
    const c = computeLogisticsCost({ ...base, shipping_country_code: null }, config);
    expect(c).toEqual({ shipping: 0, packaging: 0, returns: 0, total: 0 });
  });
  it('evaso senza indirizzo con reso: resta solo il rientro', () => {
    const c = computeLogisticsCost({ ...base, shipping_country_code: null, returned_at: '2026-09-20T10:00:00Z' }, config);
    expect(c).toEqual({ shipping: 0, packaging: 0, returns: 5, total: 5 });
  });
  it('paese vuoto conta come nessun indirizzo', () => {
    const c = computeLogisticsCost({ ...base, shipping_country_code: '' }, config);
    expect(c.total).toBe(0);
  });
  it('nessuna configurazione: tutto 0', () => {
    expect(computeLogisticsCost(base, null).total).toBe(0);
  });
  it('arrotonda al centesimo', () => {
    const c = computeLogisticsCost({ ...base, total_weight_grams: 1234, packaging_category: null }, { ...config, fallbackRules: [] });
    expect(c.shipping).toBe(2.47);
  });
});

describe('computeLogisticsCost con opzioni', () => {
  const zonaConOpzioni = {
    zoneName: 'Italia', countries: ['IT'], restOfWorld: false, rateType: 'linear' as const,
    rates: [{ weightFromKg: null, weightToKg: null, cost: 2 }],
    options: [
      { name: 'Standard', costType: 'flat' as const, brackets: [{ from: null, to: null, cost: 4.9 }] },
      { name: 'Express', costType: 'weight_brackets' as const, brackets: [
        { from: 0, to: 2, cost: 9 }, { from: 2, to: null, cost: 14 } ] },
      { name: 'Gratis sopra 50', costType: 'value_brackets' as const, brackets: [
        { from: 0, to: 50, cost: 6 }, { from: 50, to: null, cost: 6.5 } ] },
      { name: 'Corriere', costType: 'linear' as const, brackets: [{ from: null, to: null, cost: 1.5 }] },
    ],
  };

  const configConOpzioni: LogisticsConfig = {
    ...config,
    zones: [zonaConOpzioni],
  };

  it('Standard: costo flat 4.9 anche con peso null', () => {
    const c = computeLogisticsCost(
      { ...base, shipping_method: 'Standard', total_weight_grams: null },
      configConOpzioni
    );
    expect(c.shipping).toBe(4.9);
  });

  it('express (spazi/maiuscole) 3 kg: fascia peso >=2 → 14', () => {
    const c = computeLogisticsCost(
      { ...base, shipping_method: ' express ', total_weight_grams: 3000 },
      configConOpzioni
    );
    expect(c.shipping).toBe(14);
  });

  it('Gratis sopra 50 con total_price 80: fascia valore >=50 → 6.5', () => {
    const c = computeLogisticsCost(
      { ...base, shipping_method: 'Gratis sopra 50', total_price: 80 },
      configConOpzioni
    );
    expect(c.shipping).toBe(6.5);
  });

  it('Gratis sopra 50 con total_price null: nessuna fascia → 0', () => {
    const c = computeLogisticsCost(
      { ...base, shipping_method: 'Gratis sopra 50', total_price: null },
      configConOpzioni
    );
    expect(c.shipping).toBe(0);
  });

  it('Corriere 2 kg: linear 1.5 EUR/kg → 3', () => {
    const c = computeLogisticsCost(
      { ...base, shipping_method: 'Corriere', total_weight_grams: 2000 },
      configConOpzioni
    );
    expect(c.shipping).toBe(3);
  });

  it('opzione sconosciuta: ripiego sulla tariffa di zona 3 kg × 2 = 6', () => {
    const c = computeLogisticsCost(
      { ...base, shipping_method: 'Sconosciuta', total_weight_grams: 3000 },
      configConOpzioni
    );
    expect(c.shipping).toBe(6);
  });

  it('shipping_method null: ripiego sulla zona', () => {
    const c = computeLogisticsCost(
      { ...base, shipping_method: null, total_weight_grams: 3000 },
      configConOpzioni
    );
    expect(c.shipping).toBe(6);
  });

  it('opzione weight_brackets senza peso: 0 (non NaN)', () => {
    const c = computeLogisticsCost(
      { ...base, shipping_method: 'Express', total_weight_grams: null, item_count: null },
      configConOpzioni
    );
    expect(c.shipping).toBe(0);
  });

  it('ordine non spedito con opzione: 0', () => {
    const c = computeLogisticsCost(
      { ...base, fulfillment_status: 'UNFULFILLED', shipping_method: 'Standard' },
      configConOpzioni
    );
    expect(c).toEqual({ shipping: 0, packaging: 0, returns: 0, total: 0 });
  });

  it('paese null con opzione: 0 (regola 1.1: niente indirizzo, niente spedizione)', () => {
    const c = computeLogisticsCost(
      { ...base, shipping_country_code: null, shipping_method: 'Standard' },
      configConOpzioni
    );
    expect(c).toEqual({ shipping: 0, packaging: 0, returns: 0, total: 0 });
  });
});
