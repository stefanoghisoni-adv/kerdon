import { describe, it, expect } from 'vitest';
import {
  completeCurrencies,
  planPricesIn,
  resolveShopCurrency,
  type PlanPriceRow,
  type PricedPlan,
} from './currency';
import { BASE_CURRENCY, formatMoney, formatMoneyExact } from './money';

const PLANS: PricedPlan[] = [
  { planName: 'free', priceMonthly: 0, priceYearly: 0 },
  { planName: 'starter', priceMonthly: 19, priceYearly: 190 },
  { planName: 'pro', priceMonthly: 29, priceYearly: 290 },
];

/**
 * Una riga di listino in una valuta che NON e' quella base: la valuta base e'
 * il dollaro (la scheda dell'App Store non ne accetta altre), quindi provare
 * con quella non proverebbe niente.
 */
function gbp(planName: string, priceMonthly: number, priceYearly: number): PlanPriceRow {
  return { planName, currency: 'GBP', priceMonthly, priceYearly };
}

describe('completeCurrencies', () => {
  it('elenca solo le valute che coprono ogni piano a pagamento', () => {
    const prices = [gbp('starter', 21, 210), gbp('pro', 32, 320)];
    expect(completeCurrencies(PLANS, prices)).toEqual(['GBP']);
  });

  it("un listino a meta' non conta: due valute nella stessa schermata non si leggono", () => {
    expect(completeCurrencies(PLANS, [gbp('pro', 32, 320)])).toEqual([]);
  });

  it('il piano gratuito non ha bisogno di una riga', () => {
    const prices = [gbp('starter', 21, 210), gbp('pro', 32, 320)];
    expect(completeCurrencies(PLANS, prices)).toContain('GBP');
    expect(prices.some((row) => row.planName === 'free')).toBe(false);
  });
});

describe('resolveShopCurrency', () => {
  it('usa la valuta del negozio quando il listino esiste tutto', () => {
    expect(resolveShopCurrency({ shopCurrency: 'GBP', complete: ['GBP'] })).toBe('GBP');
  });

  it('senza listino in quella valuta si resta alla base: meglio euro che un prezzo falso', () => {
    expect(resolveShopCurrency({ shopCurrency: 'GBP', complete: [] })).toBe(BASE_CURRENCY);
    expect(resolveShopCurrency({ shopCurrency: 'CAD', complete: ['GBP'] })).toBe(BASE_CURRENCY);
  });

  it("un prezzo riservato tiene il negozio nella valuta in cui e' stato concordato", () => {
    expect(
      resolveShopCurrency({ shopCurrency: 'GBP', complete: ['GBP'], hasReservedPrice: true }),
    ).toBe(BASE_CURRENCY);
  });

  it('valuta sconosciuta o assente: base', () => {
    expect(resolveShopCurrency({ shopCurrency: null, complete: ['GBP'] })).toBe(BASE_CURRENCY);
    expect(resolveShopCurrency({ shopCurrency: '  ', complete: ['GBP'] })).toBe(BASE_CURRENCY);
  });

  it('la sigla arriva come Shopify la scrive, non come capita', () => {
    expect(resolveShopCurrency({ shopCurrency: 'gbp', complete: ['GBP'] })).toBe('GBP');
  });
});

describe('planPricesIn', () => {
  it('riscrive i prezzi nella valuta scelta', () => {
    const priced = planPricesIn(PLANS, [gbp('starter', 21, 210), gbp('pro', 32, 320)], 'GBP');
    expect(priced.map((p) => p.priceMonthly)).toEqual([0, 21, 32]);
  });

  it('la valuta base non tocca niente', () => {
    expect(planPricesIn(PLANS, [gbp('pro', 32, 320)], BASE_CURRENCY)).toEqual(PLANS);
  });
});

describe('formatMoney', () => {
  /** Intl separa simbolo e cifra con uno spazio unificatore, non con lo spazio. */
  const plain = (value: string) => value.replace(/\u00A0/g, ' ');

  it('il simbolo sta davanti alla cifra in tutte le lingue', () => {
    // In italiano la convenzione tipografica vorrebbe "29 EUR" con il simbolo in
    // coda: in una card di numeri incolonnati la valuta letta per ultima arriva
    // troppo tardi, quando la cifra e' gia' stata letta nella valuta sbagliata.
    expect(plain(formatMoney(29, 'EUR', 'it'))).toBe('\u20AC 29');
    expect(formatMoney(29, 'USD', 'en')).toBe('$29');
  });

  it('i separatori restano quelli della lingua: cambia solo dove sta il simbolo', () => {
    expect(plain(formatMoney(12345.5, 'EUR', 'it'))).toBe('\u20AC 12.345,50');
    expect(formatMoney(12345.5, 'USD', 'en')).toBe('$12,345.50');
  });

  it('i centesimi solo quando ci sono', () => {
    expect(plain(formatMoney(9.9, 'EUR', 'it'))).toBe('\u20AC 9,90');
  });

  it('il meno resta attaccato alla cifra, non al simbolo', () => {
    expect(plain(formatMoney(-5, 'EUR', 'it'))).toBe('\u20AC -5');
    expect(formatMoney(-5, 'USD', 'en')).toBe('$-5');
  });

  it('gli importi esatti li scrivono sempre', () => {
    expect(plain(formatMoneyExact(5, 'EUR', 'it'))).toBe('\u20AC 5,00');
  });
});