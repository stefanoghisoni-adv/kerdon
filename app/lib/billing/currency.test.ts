import { describe, it, expect } from 'vitest';
import {
  completeCurrencies,
  withPrices,
  resolveShopCurrency,
  type NamedPlan,
  type PlanPriceRow,
} from './currency';
import { BASE_CURRENCY, formatMoney, formatMoneyExact } from './money';

/** Nel listino i piani sono nomi e limiti: i prezzi stanno in `plan_prices`. */
const PLANS: NamedPlan[] = [
  { planName: 'free' },
  { planName: 'starter' },
  { planName: 'pro' },
];

/** Una riga in valuta base: e' quella che dice se un piano si paga. */
function usd(planName: string, priceMonthly: number, priceYearly: number): PlanPriceRow {
  return { planName, currency: BASE_CURRENCY, priceMonthly, priceYearly };
}

/** Una riga in una valuta alternativa. */
function gbp(planName: string, priceMonthly: number, priceYearly: number): PlanPriceRow {
  return { planName, currency: 'GBP', priceMonthly, priceYearly };
}

/** Il listino base completo: free a zero, gli altri due a pagamento. */
const BASE: PlanPriceRow[] = [usd('free', 0, 0), usd('starter', 19, 190), usd('pro', 29, 290)];

describe('completeCurrencies', () => {
  it('elenca solo le valute che coprono ogni piano a pagamento', () => {
    const prices = [...BASE, gbp('starter', 21, 210), gbp('pro', 32, 320)];
    expect(completeCurrencies(PLANS, prices)).toEqual(['GBP']);
  });

  it("un listino a meta' non conta: due valute nella stessa schermata non si leggono", () => {
    expect(completeCurrencies(PLANS, [...BASE, gbp('pro', 32, 320)])).toEqual([]);
  });

  it('il piano gratuito non ha bisogno di una riga nelle altre valute', () => {
    // Zero e' zero in ogni valuta: chiedere di tradurlo sarebbe lavoro inutile
    // per chi amministra, e una valuta in meno fra quelle offerte.
    const prices = [...BASE, gbp('starter', 21, 210), gbp('pro', 32, 320)];
    expect(completeCurrencies(PLANS, prices)).toContain('GBP');
    expect(prices.some((row) => row.currency === 'GBP' && row.planName === 'free')).toBe(false);
  });

  it('la valuta base non si offre come alternativa a se stessa', () => {
    expect(completeCurrencies(PLANS, BASE)).toEqual([]);
  });

  it('chi si paga lo dice la riga in valuta base', () => {
    // Nessun piano a pagamento nel listino: non c'e' niente da coprire, e
    // offrire una valuta per un listino tutto gratis non vuol dire niente.
    const free = [usd('free', 0, 0), usd('starter', 0, 0), usd('pro', 0, 0)];
    expect(completeCurrencies(PLANS, [...free, gbp('pro', 32, 320)])).toEqual([]);
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

describe('withPrices', () => {
  it('attacca i prezzi della valuta scelta', () => {
    const priced = withPrices(PLANS, [...BASE, gbp('starter', 21, 210), gbp('pro', 32, 320)], 'GBP');
    expect(priced.map((p) => p.priceMonthly)).toEqual([0, 21, 32]);
  });

  it('il listino si legge in un posto solo, anche in valuta base', () => {
    // Era il guaio da togliere: il dollaro scritto in `plan_prices` non veniva
    // letto da nessuno, perche' l'app prendeva la colonna su `plans`. Si
    // cambiava il prezzo in un posto e l'app ne mostrava un altro, senza che
    // niente segnalasse il conflitto.
    const priced = withPrices(PLANS, [usd('pro', 39, 199)], BASE_CURRENCY);
    expect(priced.find((p) => p.planName === 'pro')?.priceYearly).toBe(199);
  });

  it('senza riga nella valuta chiesta ripiega sulla base, non sul vuoto', () => {
    const priced = withPrices(PLANS, [...BASE, gbp('pro', 32, 320)], 'GBP');
    // starter non ha la riga in sterline: meglio il prezzo in dollari di una
    // card senza cifra.
    expect(priced.find((p) => p.planName === 'starter')?.priceMonthly).toBe(19);
    expect(priced.find((p) => p.planName === 'pro')?.priceMonthly).toBe(32);
  });

  it('un piano senza nessuna riga vale zero, non "prezzo mancante"', () => {
    const priced = withPrices([{ planName: 'ignoto' }], BASE, BASE_CURRENCY);
    expect(priced[0]).toEqual({ planName: 'ignoto', priceMonthly: 0, priceYearly: 0 });
  });

  it('i campi del piano restano al loro posto', () => {
    // I limiti viaggiano insieme al prezzo: chi riceve queste righe si aspetta
    // il piano intero, non un nome con due numeri.
    const priced = withPrices([{ planName: 'pro', maxProducts: 200 }], BASE, BASE_CURRENCY);
    expect(priced[0].maxProducts).toBe(200);
    expect(priced[0].priceMonthly).toBe(29);
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