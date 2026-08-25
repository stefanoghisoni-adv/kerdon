import { describe, it, expect } from 'vitest';
import {
  suggestPlanForProducts,
  planComparisonRows,
  limitLabel,
  type PlanForSuggestion,
} from './plan-suggestion';
import { it as itDict } from '~/lib/i18n/it';

// Listino reale, cosi' i casi limite sono quelli che i merchant incontrano.
const PLANS: PlanForSuggestion[] = [
  { planName: 'free', priceMonthly: 0, priceYearly: 0, maxProducts: 50, maxCustomers: 200, customersSyncEnabled: false },
  { planName: 'pro', priceMonthly: 19, priceYearly: 290, maxProducts: 200, maxCustomers: 500, customersSyncEnabled: true },
  { planName: 'business', priceMonthly: 49, priceYearly: 990, maxProducts: 1000, maxCustomers: 2000, customersSyncEnabled: true },
  { planName: 'enterprise', priceMonthly: 79, priceYearly: 2990, maxProducts: null, maxCustomers: null, customersSyncEnabled: true },
  { planName: 'lifetime', priceMonthly: 0, priceYearly: 0, maxProducts: null, maxCustomers: null, customersSyncEnabled: true },
];

describe('suggestPlanForProducts', () => {
  it('propone il piu economico che contiene tutti i prodotti', () => {
    // 78 prodotti su Free (tetto 50): Pro ne regge 200 e basta.
    expect(suggestPlanForProducts(PLANS, 'free', 78)?.planName).toBe('pro');
  });

  it('sale di piu quando il primo passo non basterebbe', () => {
    // 640 supera anche Pro: il primo che li contiene tutti e' Business.
    expect(suggestPlanForProducts(PLANS, 'free', 640)?.planName).toBe('business');
  });

  it('arriva al piano senza tetto quando nessun tetto basta', () => {
    expect(suggestPlanForProducts(PLANS, 'business', 5000)?.planName).toBe('enterprise');
  });

  it('non propone nulla se i prodotti stanno nel tetto attuale', () => {
    expect(suggestPlanForProducts(PLANS, 'free', 50)).toBeNull();
    expect(suggestPlanForProducts(PLANS, 'free', 12)).toBeNull();
  });

  it('non propone nulla a chi non ha tetto', () => {
    expect(suggestPlanForProducts(PLANS, 'enterprise', 99999)).toBeNull();
  });

  it('non propone MAI il piano interno, per quanto conveniente sembri', () => {
    // Lifetime costa zero e non ha tetti: senza il filtro sarebbe sempre il
    // primo scelto, e manderebbe il merchant su una pagina che per lui non
    // esiste.
    const suggested = suggestPlanForProducts(PLANS, 'free', 78);
    expect(suggested?.planName).not.toBe('lifetime');
  });

  it('non propone nulla a chi e gia su un piano interno', () => {
    expect(suggestPlanForProducts(PLANS, 'lifetime', 99999)).toBeNull();
  });

  it('ignora un piano piu economico anche se avesse un tetto piu alto', () => {
    // Sarebbe un errore di listino, non un'occasione: l'aggiornamento deve
    // essere un passo avanti, non un declassamento travestito.
    const strano: PlanForSuggestion[] = [
      ...PLANS,
      { planName: 'strano', priceMonthly: 0, priceYearly: 0, maxProducts: 9999, maxCustomers: 1, customersSyncEnabled: false },
    ];
    expect(suggestPlanForProducts(strano, 'free', 78)?.planName).toBe('pro');
  });

  it('piano corrente sconosciuto: nessuna proposta', () => {
    // Meglio non dire niente che proporre un salto calcolato su un listino che
    // non contiene il piano da cui si parte.
    expect(suggestPlanForProducts(PLANS, 'inesistente', 5000)).toBeNull();
  });
});

describe('planComparisonRows', () => {
  const free = PLANS[0];
  const pro = PLANS[1];

  it('confronta prodotti, clienti e costo', () => {
    const rows = planComparisonRows(free, pro, 'USD', 'it', itDict);
    expect(rows.map((r) => r.label)).toEqual([
      'Prodotti sincronizzabili',
      'Clienti sincronizzabili',
      'Costo mensile',
    ]);
    expect(rows[0]).toEqual({ label: 'Prodotti sincronizzabili', current: '50', next: '200' });
    expect(rows[1].current).toBe('Non inclusi');
    expect(rows[1].next).toBe('500');
    expect({ ...rows[2], next: rows[2].next.replace(/\u00a0/g, ' ') }).toEqual({
      label: 'Costo mensile',
      current: 'Gratuito',
      next: '$ 19/mese',
    });
  });

  it('tiene fuori le voci che non cambiano', () => {
    // Una tabella in cui meta' delle righe ripete lo stesso valore fa sembrare
    // l'aggiornamento meno utile di quanto sia.
    const business = PLANS[2];
    const enterprise = PLANS[3];
    const rows = planComparisonRows(business, enterprise, 'USD', 'it', itDict);
    expect(rows.map((r) => r.label)).not.toContain('Sincronizzazione clienti');
    expect(rows.every((r) => r.current !== r.next)).toBe(true);
  });

  it('scrive per esteso l assenza di tetto', () => {
    expect(limitLabel(null, itDict)).toBe('Illimitati');
    expect(limitLabel(200, itDict)).toBe('200');
  });
});
