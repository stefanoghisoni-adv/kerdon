import { describe, it, expect } from 'vitest';
import {
  BASE_PLAN_NAME,
  INTERIM_PLAN_NAMES,
  LEGACY_PLAN_NAMES,
  PLAN_TIERS,
  RECOMMENDED_PLAN_NAME,
  isBasePlan,
  resolvePlanName,
} from './plan-tiers';
import { samePlanName } from './plan-name';

describe('il listino deciso', () => {
  it('quattro piani, dal gratuito al piu caro: Basic, Growth, Scale, Core', () => {
    expect(PLAN_TIERS.map((t) => t.name)).toEqual(['Basic', 'Growth', 'Scale', 'Core']);
    expect(PLAN_TIERS.map((t) => t.priceMonthly)).toEqual([0, 29, 79, 149]);
    expect(PLAN_TIERS.map((t) => t.priceYearly)).toEqual([0, 290, 790, 1490]);
  });

  it('prodotti 20 / 200 / 1.000 / illimitati', () => {
    expect(PLAN_TIERS.map((t) => t.maxProducts)).toEqual([20, 200, 1000, null]);
  });

  it('clienti: nessuno sul Basic, poi 250 / 500 / illimitati', () => {
    expect(PLAN_TIERS.map((t) => t.customersSyncEnabled)).toEqual([false, true, true, true]);
    expect(PLAN_TIERS.map((t) => t.maxCustomers)).toEqual([0, 250, 500, null]);
  });

  it('feed di catalogo: esclusi sul Basic, inclusi sugli altri', () => {
    expect(PLAN_TIERS.map((t) => t.productFeedsEnabled)).toEqual([false, true, true, true]);
  });

  it('nessun piano ha un limite sugli ordini', () => {
    for (const tier of PLAN_TIERS) {
      expect(Object.keys(tier).some((k) => /order/i.test(k))).toBe(false);
    }
  });

  it('il gratuito e il consigliato sono nel listino', () => {
    expect(PLAN_TIERS[0].name).toBe(BASE_PLAN_NAME);
    expect(PLAN_TIERS.some((t) => t.name === RECOMMENDED_PLAN_NAME)).toBe(true);
    expect(RECOMMENDED_PLAN_NAME).toBe('Growth');
  });

  it('i prezzi dei quattro scaglioni non si sovrappongono (serve a riconoscere i nomi di mezzo)', () => {
    const cifre = PLAN_TIERS.flatMap((t) => [t.priceMonthly, t.priceYearly]).filter((c) => c > 0);
    expect(new Set(cifre).size).toBe(cifre.length);
  });
});

describe('resolvePlanName: i nomi di prima', () => {
  it.each([
    ['Free', 'Basic'],
    ['Pro', 'Growth'],
    ['Business', 'Scale'],
    ['Enterprise', 'Core'],
    ['  pro ', 'Growth'],
    ['ENTERPRISE', 'Core'],
  ])('%s → %s', (vecchio, nuovo) => {
    expect(resolvePlanName(vecchio)).toBe(nuovo);
    // L'importo non cambia niente: questi nomi non sono ambigui.
    expect(resolvePlanName(vecchio, 12345)).toBe(nuovo);
  });

  it('ogni nome di prima porta a un piano del listino', () => {
    const nomi = PLAN_TIERS.map((t) => t.name);
    for (const nuovo of [...Object.values(LEGACY_PLAN_NAMES), ...Object.values(INTERIM_PLAN_NAMES)]) {
      expect(nomi).toContain(nuovo);
    }
  });

  it('i nomi di oggi senza importo restano quelli di oggi', () => {
    expect(resolvePlanName('Core')).toBe('Core');
    expect(resolvePlanName('Growth')).toBe('Growth');
    expect(resolvePlanName('Scale')).toBe('Scale');
    expect(resolvePlanName('Basic')).toBe('Basic');
  });

  it.each([
    // Il 23 settembre: Core era il 29, Growth il 79, Scale il 149.
    ['Core', 29, 'Growth'],
    ['Core', 290, 'Growth'],
    ['Growth', 79, 'Scale'],
    ['Growth', 790, 'Scale'],
    ['Scale', 149, 'Core'],
    ['Scale', 1490, 'Core'],
  ])('"%s" a %d era lo scaglione di %s', (nome, importo, oggi) => {
    expect(resolvePlanName(nome, importo)).toBe(oggi);
  });

  it.each([
    ['Core', 149],
    ['Core', 1490],
    ['Growth', 29],
    ['Scale', 79],
  ])('"%s" a %d e il piano di oggi', (nome, importo) => {
    expect(resolvePlanName(nome, importo)).toBe(nome);
  });

  it('un importo che non e di nessuno scaglione non sposta niente', () => {
    expect(resolvePlanName('Core', 14)).toBe('Core');
  });

  it('Lifetime e i nomi sconosciuti tornano come sono', () => {
    expect(resolvePlanName('Lifetime')).toBe('Lifetime');
    expect(resolvePlanName(' Agenzia ')).toBe('Agenzia');
    expect(resolvePlanName('')).toBe('');
    expect(resolvePlanName(null)).toBe('');
  });
});

describe('confronti fra nomi', () => {
  it('un nome di prima e il suo successore sono lo stesso piano', () => {
    expect(samePlanName('Pro', 'Growth')).toBe(true);
    expect(samePlanName('free', 'Basic')).toBe(true);
    expect(samePlanName('Enterprise', 'Core')).toBe(true);
  });

  it('i nomi di mezzo, senza importo, non si confondono con lo scaglione sotto', () => {
    expect(samePlanName('Core', 'Growth')).toBe(false);
    expect(samePlanName('Pro', 'Core')).toBe(false);
  });

  it('isBasePlan riconosce il gratuito con il nome di oggi e di prima', () => {
    expect(isBasePlan('Basic')).toBe(true);
    expect(isBasePlan(' free ')).toBe(true);
    expect(isBasePlan('Growth')).toBe(false);
    expect(isBasePlan('Lifetime')).toBe(false);
  });
});
