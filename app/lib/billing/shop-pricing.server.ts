import { prisma } from '~/db.server';
import {
  completeCurrencies,
  withPrices,
  resolveShopCurrency,
  type NamedPlan,
  type PricedPlan,
} from './currency';

/**
 * Il listino come lo vede UN negozio: i prezzi e la valuta in cui sono scritti.
 *
 * I due viaggiano sempre insieme. Separarli e' esattamente il guaio da evitare:
 * un numero senza la sua valuta viene mostrato con quella sbagliata, e finisce
 * che l'app promette un prezzo che Shopify non addebita.
 */
export interface ShopPricing<T extends NamedPlan> {
  currency: string;
  plans: (T & PricedPlan)[];
}

/**
 * Legge il listino in valuta e decide in quale parlare a questo negozio.
 *
 * `plan_prices` e' una tabella di poche righe e la si legge per intero: filtrare
 * per valuta risparmierebbe niente e impedirebbe di sapere quali valute sono
 * complete, che e' la domanda vera.
 */
export async function resolveShopPricing<T extends NamedPlan>(
  plans: T[],
  opts: {
    /**
     * La valuta che il negozio si aspetta: quella del mercato scelto nel
     * selettore in alto. Si onora solo se il listino esiste per intero in
     * quella valuta — un prezzo si mostra quando lo si incassa davvero.
     */
    preferredCurrency: string | null | undefined;
    hasReservedPrice: boolean;
  },
): Promise<ShopPricing<T>> {
  const rows = await prisma.planPrice.findMany();
  const prices = rows.map((row) => ({
    planName: row.planName,
    currency: row.currency,
    priceMonthly: Number(row.priceMonthly),
    priceYearly: Number(row.priceYearly),
  }));

  const currency = resolveShopCurrency({
    shopCurrency: opts.preferredCurrency,
    complete: completeCurrencies(plans, prices),
    hasReservedPrice: opts.hasReservedPrice,
  });

  return { currency, plans: withPrices(plans, prices, currency) };
}

/**
 * Le valute in cui il listino e' completo, per il selettore in alto.
 *
 * Serve a ogni apertura di ogni pagina — l'etichetta di ogni voce dice in che
 * valuta si finirebbe — e cambia solo quando l'owner tocca il listino: tenerla
 * in memoria per un minuto evita due letture per pagina senza rischiare di
 * mostrare per molto un listino vecchio.
 */
const CACHE_MS = 60_000;
let cache: { at: number; currencies: string[] } | null = null;

export async function completeCurrenciesCached(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.currencies;

  const [plans, rows] = await Promise.all([
    // Solo i nomi: quali piani esistono lo dice `plans`, quanto costano lo dice
    // `plan_prices`, e qui servono tutti e due per sapere quali valute coprono
    // il listino per intero.
    prisma.plan.findMany({ select: { planName: true } }),
    prisma.planPrice.findMany(),
  ]);

  const currencies = completeCurrencies(
    plans,
    rows.map((row) => ({
      planName: row.planName,
      currency: row.currency,
      priceMonthly: Number(row.priceMonthly),
      priceYearly: Number(row.priceYearly),
    })),
  );

  cache = { at: Date.now(), currencies };
  return currencies;
}

/** Solo per i test: dimentica quel che si e' letto. */
export function clearPricingCache(): void {
  cache = null;
}
