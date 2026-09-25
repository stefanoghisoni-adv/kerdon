// Alias: `it` e' anche il nome del caso di test in vitest.
import { it as itDict } from '~/lib/i18n/it';
import { describe, it, expect } from 'vitest';
import type { PlanCard } from '~/components/Billing/plan-catalog';
import {
  planPriceLabel,
  planSavingBadge,
  preselectedPlan,
  recommendedPlan,
  yearlySaving,
} from './plan-step';

function card(overrides: Partial<PlanCard> = {}): PlanCard {
  return {
    name: 'Growth',
    priceMonthly: 29,
    priceYearly: 290,
    partnerMonthly: null,
    partnerYearly: null,
    recommended: true,
    features: [
      { key: 'sync', included: true, value: 6 },
      { key: 'products', included: true, value: 5000 },
      { key: 'customers', included: true, value: 10_000 },
      { key: 'feeds', included: true, value: null },
      { key: 'push', included: false, value: null },
    ],
    ...overrides,
  };
}

/** Intl separa cifra e simbolo con uno spazio unificatore: qui si confronta. */
const nb = (text: string) => text.replace(/\u00a0/g, ' ');

describe('planPriceLabel', () => {
  it('scrive il prezzo al mese', () => {
    expect(nb(planPriceLabel(card(), null, 'monthly', itDict, 'EUR', 'it'))).toBe('€ 29/mese');
  });

  it('a prezzo zero dice "Gratis", non "€ 0"', () => {
    expect(planPriceLabel(card({ priceMonthly: 0 }), null, 'monthly', itDict, 'EUR', 'it')).toBe(
      'Gratis',
    );
  });

  it('usa il prezzo riservato quando il negozio ne ha uno', () => {
    expect(
      nb(planPriceLabel(card({ partnerMonthly: 24 }), 3, 'monthly', itDict, 'EUR', 'it')),
    ).toBe('€ 24/mese');
  });

  it('sull annuale scrive il prezzo dell anno', () => {
    expect(nb(planPriceLabel(card(), null, 'yearly', itDict, 'EUR', 'it'))).toBe('€ 290/anno');
    expect(
      nb(planPriceLabel(card({ partnerYearly: 240 }), 3, 'yearly', itDict, 'EUR', 'it')),
    ).toBe('€ 240/anno');
  });
});

describe('yearlySaving', () => {
  it('dice il risparmio piu alto fra i piani', () => {
    // 29x12 - 290 = 58 su Growth; 47x12 - 400 = 164 su Scale: vince il secondo.
    const saving = yearlySaving([
      card(),
      card({ name: 'Scale', priceMonthly: 47, priceYearly: 400 }),
    ]);
    expect(saving).toBe(164);
  });

  it('senza risparmio non annuncia niente', () => {
    // Un listino in cui l'annuale non conviene esiste: annunciarlo lo stesso
    // sarebbe falso.
    expect(yearlySaving([card({ priceMonthly: 10, priceYearly: 120 })])).toBeNull();
    expect(yearlySaving([card({ priceMonthly: 0, priceYearly: 0 })])).toBeNull();
  });
});

describe('planSavingBadge', () => {
  it('scrive quanto si risparmia in un anno, centesimi compresi', () => {
    // 29x12 - 290 = 58. I centesimi si scrivono sempre: e' denaro, e "58 €"
    // accanto a "58,50 €" sembrerebbe un arrotondamento.
    expect(nb(planSavingBadge(card(), itDict, 'EUR', 'it') as string)).toBe('Risparmi € 58,00');
  });

  it('conta sul prezzo riservato, che e quello che il negozio paga', () => {
    expect(
      nb(planSavingBadge(card({ partnerMonthly: 24, partnerYearly: 240 }), itDict, 'EUR', 'it') as string),
    ).toBe('Risparmi € 48,00');
  });

  it('sul gratuito non c e nessun badge', () => {
    expect(planSavingBadge(card({ priceMonthly: 0, priceYearly: 0 }), itDict, 'EUR', 'it')).toBeNull();
  });

  it('se l annuale non conviene, non lo si annuncia', () => {
    expect(planSavingBadge(card({ priceMonthly: 10, priceYearly: 120 }), itDict, 'EUR', 'it')).toBeNull();
    expect(planSavingBadge(card({ priceMonthly: 10, priceYearly: 130 }), itDict, 'EUR', 'it')).toBeNull();
  });
});

describe('preselectedPlan', () => {
  it('sceglie il piano che il negozio ha adesso', () => {
    expect(preselectedPlan([card({ name: 'Basic' }), card()], 'basic')).toBe('Basic');
  });

  it('senza corrispondenza non preseleziona niente', () => {
    // Piani interni assegnati dall'owner: non sono nel listino, e spuntare al
    // loro posto un piano a pagamento farebbe confermare una spesa mai voluta.
    expect(preselectedPlan([card()], 'lifetime')).toBe('');
    expect(preselectedPlan([card()], null)).toBe('');
  });
});

describe('recommendedPlan', () => {
  const listino = [
    card({ name: 'Basic', priceMonthly: 0 }),
    card({ name: 'Growth', priceMonthly: 27 }),
    card({ name: 'Scale', priceMonthly: 47 }),
    card({ name: 'Core', priceMonthly: 97 }),
  ];
  const tetti = { Basic: 10, Growth: 200, Scale: 1000, Core: 5000 };

  it('consiglia il piu economico che contiene tutto il catalogo', () => {
    expect(recommendedPlan(listino, 8, tetti)).toBe('Basic');
    expect(recommendedPlan(listino, 26, tetti)).toBe('Growth');
    expect(recommendedPlan(listino, 900, tetti)).toBe('Scale');
  });

  it('sul confine sta il piano che ci arriva esatto', () => {
    expect(recommendedPlan(listino, 10, tetti)).toBe('Basic');
    expect(recommendedPlan(listino, 11, tetti)).toBe('Growth');
  });

  it('se nessuno basta consiglia il piu capiente', () => {
    // Tacere lascerebbe senza indicazione proprio il negozio piu' grande.
    expect(recommendedPlan(listino, 99_999, tetti)).toBe('Core');
  });

  it('un piano senza tetto contiene qualunque catalogo', () => {
    expect(recommendedPlan([card({ name: 'Growth', priceMonthly: 27 })], 99_999, { Growth: null })).toBe(
      'Growth',
    );
  });

  it('senza conteggio dei prodotti non consiglia niente', () => {
    // I prodotti arrivano da una richiesta: finche' non ci sono, un consiglio
    // sarebbe basato sul nulla.
    expect(recommendedPlan(listino, null, tetti)).toBeNull();
    expect(recommendedPlan([], 26, tetti)).toBeNull();
  });
});
