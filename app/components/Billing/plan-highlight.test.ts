import { describe, it, expect } from 'vitest';
import { shouldHighlightRecommended } from './plan-highlight';
import type { PlanCard } from './plan-catalog';

const card = (name: string, priceMonthly: number, recommended = false): PlanCard => ({
  name,
  priceMonthly,
  priceYearly: priceMonthly * 10,
  partnerMonthly: null,
  partnerYearly: null,
  recommended,
  features: [],
});

const CARDS = [
  card('basic', 0),
  card('growth', 29, true),
  card('scale', 99),
  card('core', 299),
];

describe('shouldHighlightRecommended', () => {
  it('risalta il consigliato se il piano attuale e piu basso', () => {
    expect(shouldHighlightRecommended(CARDS, 'basic')).toBe(true);
  });

  it('non risalta nulla se sono gia sul consigliato o piu su', () => {
    expect(shouldHighlightRecommended(CARDS, 'growth')).toBe(false);
    expect(shouldHighlightRecommended(CARDS, 'scale')).toBe(false);
    expect(shouldHighlightRecommended(CARDS, 'core')).toBe(false);
  });

  it('tratta un piano fuori listino come superiore', () => {
    expect(shouldHighlightRecommended(CARDS, 'lifetime')).toBe(false);
  });

  it('senza piano registrato assume il piu basso (negozio appena installato)', () => {
    expect(shouldHighlightRecommended(CARDS, '')).toBe(true);
    expect(shouldHighlightRecommended(CARDS, null)).toBe(true);
    expect(shouldHighlightRecommended(CARDS, undefined)).toBe(true);
  });

  it('ignora maiuscole e spazi', () => {
    expect(shouldHighlightRecommended(CARDS, '  BASIC ')).toBe(true);
    expect(shouldHighlightRecommended(CARDS, 'Scale')).toBe(false);
  });

  it('listino senza consigliato → niente da risaltare', () => {
    expect(shouldHighlightRecommended([card('basic', 0)], 'basic')).toBe(false);
    expect(shouldHighlightRecommended([], 'basic')).toBe(false);
  });
});
