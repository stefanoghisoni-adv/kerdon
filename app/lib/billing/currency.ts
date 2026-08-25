import { BASE_CURRENCY } from './money';

/**
 * In che valuta parla l'app a questo negozio.
 *
 * Shopify sa in che valuta fattura ogni merchant e la dichiara
 * (`shopBillingPreferences`): e' quella dei suoi conti, non quella con cui
 * vende ai suoi clienti. Ma sapere in che valuta il merchant ragiona non basta
 * a scrivergli un prezzo in quella valuta: un prezzo si mostra solo se lo si
 * incassa davvero. Mostrare "$29" e addebitare "29 €" e' un prezzo che non
 * esiste — per il merchant e' una sorpresa in fattura, e in revisione e' un
 * motivo di rifiuto.
 *
 * Quindi la regola e' una sola: si passa a un'altra valuta quando il listino
 * esiste per intero in quella valuta, e quel listino diventa insieme cio' che
 * si mostra e cio' che si addebita. Altrimenti si resta alla valuta base, che
 * e' anche quella della scheda dell'App Store: il merchant ritrova nell'app il
 * prezzo che ha letto prima di installare.
 */

/** Un piano per come lo conosce il listino: solo il nome. */
export interface NamedPlan {
  planName: string;
}

/** Un piano con i prezzi attaccati, nella valuta in cui gli si parlera'. */
export interface PricedPlan extends NamedPlan {
  priceMonthly: number;
  priceYearly: number;
}

/** Una riga del listino in valuta. */
export interface PlanPriceRow {
  planName: string;
  currency: string;
  priceMonthly: number;
  priceYearly: number;
}

function isPaid(row: PlanPriceRow | undefined): boolean {
  return row !== undefined && (row.priceMonthly > 0 || row.priceYearly > 0);
}

/**
 * Il listino nella valuta base, indicizzato per piano.
 *
 * La valuta base non e' una valuta come le altre: e' quella in cui ogni piano
 * ha una riga, ed e' quella che decide chi si paga e chi no. Le altre sono
 * traduzioni di quel listino, e possono mancare.
 */
function baseRows(prices: PlanPriceRow[]): Map<string, PlanPriceRow> {
  return new Map(
    prices.filter((row) => row.currency === BASE_CURRENCY).map((row) => [row.planName, row]),
  );
}

/**
 * Le valute in cui il listino e' completo.
 *
 * Completo e non parziale: se mancasse anche un solo piano a pagamento, le card
 * mostrerebbero prezzi in due valute diverse una accanto all'altra, e a quel
 * punto nessuno dei due si capisce piu'.
 *
 * Quali piani si pagano lo dice la riga in valuta base, non una colonna sul
 * piano: il listino sta tutto in un posto, e "gratis" e' un prezzo come gli
 * altri — scritto zero.
 */
export function completeCurrencies(plans: NamedPlan[], prices: PlanPriceRow[]): string[] {
  const base = baseRows(prices);
  const needed = plans
    .map((plan) => plan.planName)
    .filter((name) => isPaid(base.get(name)));
  if (needed.length === 0) return [];

  const byCurrency = new Map<string, Set<string>>();
  for (const row of prices) {
    // La base non si elenca fra le alternative: e' il punto di partenza, non
    // una destinazione, e offrirla come scelta non cambierebbe niente.
    if (row.currency === BASE_CURRENCY) continue;
    if (!isPaid(row)) continue;
    const set = byCurrency.get(row.currency) ?? new Set<string>();
    set.add(row.planName);
    byCurrency.set(row.currency, set);
  }

  return [...byCurrency.entries()]
    .filter(([, covered]) => needed.every((name) => covered.has(name)))
    .map(([currency]) => currency);
}

export interface ResolveCurrencyInput {
  /** La valuta di fatturazione dichiarata da Shopify per questo negozio. */
  shopCurrency: string | null | undefined;
  /** Le valute in cui il listino e' completo (vedi `completeCurrencies`). */
  complete: string[];
  /**
   * Il negozio ha un prezzo riservato.
   *
   * I prezzi riservati sono concordati uno per uno e scritti nella valuta base:
   * convertirli sarebbe inventare una cifra che nessuno ha concordato, e
   * ignorarli farebbe pagare al negozio il listino pieno. Resta la valuta base,
   * che e' quella in cui l'accordo e' stato fatto.
   */
  hasReservedPrice?: boolean;
}

export function resolveShopCurrency({
  shopCurrency,
  complete,
  hasReservedPrice,
}: ResolveCurrencyInput): string {
  const wanted = (shopCurrency ?? '').trim().toUpperCase();
  if (!wanted || wanted === BASE_CURRENCY) return BASE_CURRENCY;
  if (hasReservedPrice) return BASE_CURRENCY;
  return complete.includes(wanted) ? wanted : BASE_CURRENCY;
}

/**
 * I piani con i prezzi attaccati, nella valuta scelta.
 *
 * Il listino sta tutto in `plan_prices`, una riga per piano e valuta. Prima
 * stava in due posti — le colonne su `plans` e le righe per valuta — e i due
 * potevano dire cose diverse: chi amministrava scriveva il dollaro nella
 * tabella per valuta, l'app leggeva la colonna sul piano, e il prezzo mostrato
 * non era quello scritto. Non c'era modo di accorgersene se non guardandoli
 * tutti e due.
 *
 * L'ordine in cui si cerca: la riga nella valuta chiesta, poi quella in valuta
 * base, poi zero. Il secondo passo non dovrebbe servire — `resolveShopCurrency`
 * concede solo valute complete — ma se un giorno servisse, un prezzo in dollari
 * e' meglio di una card vuota.
 */
export function withPrices<T extends NamedPlan>(
  plans: T[],
  prices: PlanPriceRow[],
  currency: string,
): (T & PricedPlan)[] {
  const wanted = new Map(
    prices.filter((row) => row.currency === currency).map((row) => [row.planName, row]),
  );
  const base = baseRows(prices);

  return plans.map((plan) => {
    const row = wanted.get(plan.planName) ?? base.get(plan.planName);
    return {
      ...plan,
      priceMonthly: row?.priceMonthly ?? 0,
      priceYearly: row?.priceYearly ?? 0,
    };
  });
}
