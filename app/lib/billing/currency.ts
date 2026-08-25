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

/** Un piano per come serve qui: il nome e i prezzi del listino base. */
export interface PricedPlan {
  planName: string;
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

/** Gratis in una valuta e' gratis in tutte: per questi piani non serve una riga. */
function isFree(plan: PricedPlan): boolean {
  return !(plan.priceMonthly > 0) && !(plan.priceYearly > 0);
}

/**
 * Le valute in cui il listino e' completo.
 *
 * Completo e non parziale: se mancasse anche un solo piano a pagamento, le card
 * mostrerebbero prezzi in due valute diverse una accanto all'altra, e a quel
 * punto nessuno dei due si capisce piu'.
 */
export function completeCurrencies(plans: PricedPlan[], prices: PlanPriceRow[]): string[] {
  const needed = plans.filter((plan) => !isFree(plan)).map((plan) => plan.planName);
  if (needed.length === 0) return [];

  const byCurrency = new Map<string, Set<string>>();
  for (const row of prices) {
    if (!(row.priceMonthly > 0) && !(row.priceYearly > 0)) continue;
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
 * Il listino riscritto nella valuta scelta.
 *
 * I piani gratuiti restano a zero senza bisogno di una riga, e un piano senza
 * riga nella valuta richiesta tiene i prezzi base — non puo' succedere quando
 * la valuta viene da `resolveShopCurrency`, ma se succedesse un prezzo vecchio
 * e' comunque meglio di un prezzo assente.
 */
export function planPricesIn<T extends PricedPlan>(
  plans: T[],
  prices: PlanPriceRow[],
  currency: string,
): T[] {
  // Anche la valuta base passa di qui.
  //
  // Prima no, e sembrava sensato: il listino in `plans` E' gia' scritto in
  // valuta base, quindi le righe per valuta servivano solo alle altre. Ma chi
  // amministra il listino non lo sa, vede una tabella `plan_prices` con una
  // colonna currency e ci scrive dentro anche il dollaro — e quel numero non
  // veniva letto da nessuno. Risultato: si cambia il prezzo in un posto e
  // l'app continua a mostrarne un altro, senza che niente segnali il conflitto.
  //
  // Ora una riga per valuta vince sempre, e `plans` resta il ripiego di quando
  // non c'e'. Un posto solo dove guardare, e quel posto e' quello dove si e'
  // scritto per ultimo.
  const byPlan = new Map(
    prices.filter((row) => row.currency === currency).map((row) => [row.planName, row]),
  );

  return plans.map((plan) => {
    const row = byPlan.get(plan.planName);
    if (!row || isFree(plan)) return plan;
    return { ...plan, priceMonthly: row.priceMonthly, priceYearly: row.priceYearly };
  });
}
