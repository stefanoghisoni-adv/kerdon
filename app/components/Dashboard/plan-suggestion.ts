import { isSelectablePlan } from '~/components/Billing/plan-access';
import { matchingIncluded } from '~/components/Billing/plan-catalog';
import { formatMoney } from '~/lib/billing/money';
import type { Locale } from '~/lib/i18n/locales';
import type { Dictionary } from '~/lib/i18n/context';

// Serve anche `plan` perche' il matching si chiama qui come si chiama nelle card
// dei prezzi: e' la stessa funzione, e leggerla con due nomi diversi a seconda
// di dove la si incontra e' gia' un modo per farla sembrare due cose.
type Strings = Pick<Dictionary, 'planCompare' | 'plan'>;

/**
 * Quale piano proporre a chi ha piu' prodotti di quanti il suo ne sincronizzi.
 *
 * Il conto si fa sui prodotti TOTALI del negozio, non su quelli idonei: un
 * prodotto oggi senza costo diventa idoneo appena il merchant lo compila, e a
 * quel punto il tetto lo taglierebbe fuori comunque. Proporre un piano
 * dimensionato sui soli idonei di oggi vorrebbe dire farlo tornare qui domani.
 */

export interface PlanForSuggestion {
  planName: string;
  priceMonthly: number;
  priceYearly: number;
  /** null = nessun tetto. */
  maxProducts: number | null;
  maxCustomers: number | null;
  customersSyncEnabled: boolean;
  productFeedsEnabled?: boolean;
}

export function suggestPlanForProducts(
  plans: PlanForSuggestion[],
  currentPlanName: string | null | undefined,
  totalProducts: number,
): PlanForSuggestion | null {
  const current = (currentPlanName ?? '').trim().toLowerCase();
  const currentPlan = plans.find((p) => p.planName.trim().toLowerCase() === current) ?? null;

  // Piano senza tetto: non c'e' niente che resti fuori, quindi niente da
  // proporre. Vale anche per i piani interni, che di tetti non ne hanno.
  if (!currentPlan || currentPlan.maxProducts == null) return null;

  // Sotto il tetto ci si sta: nessun avviso. Il caso "quasi al limite" e' un
  // avviso diverso, che esiste gia' e parla di quota in esaurimento.
  if (totalProducts <= currentPlan.maxProducts) return null;

  const candidates = plans.filter((plan) => {
    // I piani interni (lifetime) non si comprano: proporli manderebbe il
    // merchant su una pagina che per lui non esiste. Senza questo filtro
    // sarebbero anche i primi a essere scelti, perche' costano zero e non
    // hanno tetti.
    if (!isSelectablePlan(plan.planName)) return false;
    if (plan.planName.trim().toLowerCase() === current) return false;
    // Deve contenerli tutti: un piano che ne lascia comunque fuori una parte
    // non risolve il problema per cui lo stiamo proponendo.
    if (plan.maxProducts != null && plan.maxProducts < totalProducts) return false;
    // E deve essere un passo avanti: un piano piu' economico con un tetto piu'
    // alto sarebbe un errore di listino, non un'occasione da suggerire.
    return plan.priceMonthly > currentPlan.priceMonthly;
  });

  if (candidates.length === 0) return null;

  // Il piu' economico fra quelli che bastano. A parita' di prezzo l'ordine
  // alfabetico rende la scelta prevedibile invece che casuale.
  return [...candidates].sort(
    (a, b) => a.priceMonthly - b.priceMonthly || a.planName.localeCompare(b.planName),
  )[0];
}

/** Quanti ne ha il negozio, per i due tetti del piano. null = non si sa. */
export interface LimitCounts {
  /** Prodotti totali del negozio. */
  products?: number | null;
  /** Clienti con consenso al marketing su Shopify: gli unici che si sincronizzano. */
  customers?: number | null;
}

/** Quanti prodotti e quanti clienti restano fuori dal piano. */
export interface PlanOverflow {
  products: number;
  customers: number;
}

/**
 * Quanto eccede, per ciascun tetto.
 *
 * I clienti contano solo se il piano li sincronizza: su un piano che non li
 * include non c'e' un tetto superato, c'e' una funzione da ottenere — e quella
 * ha il suo invito, nella card dei clienti.
 */
export function planOverflow(plan: PlanForSuggestion, counts: LimitCounts): PlanOverflow {
  const products =
    plan.maxProducts != null && counts.products != null
      ? Math.max(0, counts.products - plan.maxProducts)
      : 0;
  const customers =
    plan.customersSyncEnabled && plan.maxCustomers != null && counts.customers != null
      ? Math.max(0, counts.customers - plan.maxCustomers)
      : 0;
  return { products, customers };
}

/**
 * Quale piano proporre a chi supera il tetto prodotti, quello clienti, o
 * entrambi. Stesse regole di `suggestPlanForProducts`: il piu' economico fra i
 * piani acquistabili e piu' cari dell'attuale che contengono tutto.
 *
 * I clienti pesano sulla scelta solo se il piano attuale li sincronizza gia':
 * altrimenti un merchant su Basic con molti iscritti si vedrebbe proporre il
 * piano piu' caro per risolvere un problema di prodotti.
 */
export function suggestPlanForLimits(
  plans: PlanForSuggestion[],
  currentPlanName: string | null | undefined,
  counts: LimitCounts,
): PlanForSuggestion | null {
  const current = (currentPlanName ?? '').trim().toLowerCase();
  const currentPlan = plans.find((p) => p.planName.trim().toLowerCase() === current) ?? null;
  if (!currentPlan) return null;

  const over = planOverflow(currentPlan, counts);
  if (over.products === 0 && over.customers === 0) return null;

  const needCustomers = currentPlan.customersSyncEnabled ? counts.customers ?? null : null;

  const candidates = plans.filter((plan) => {
    if (!isSelectablePlan(plan.planName)) return false;
    if (plan.planName.trim().toLowerCase() === current) return false;
    if (counts.products != null && plan.maxProducts != null && plan.maxProducts < counts.products) {
      return false;
    }
    if (needCustomers != null) {
      if (!plan.customersSyncEnabled) return false;
      if (plan.maxCustomers != null && plan.maxCustomers < needCustomers) return false;
    }
    return plan.priceMonthly > currentPlan.priceMonthly;
  });

  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) => a.priceMonthly - b.priceMonthly || a.planName.localeCompare(b.planName),
  )[0];
}

/**
 * Titolo e testo dell'avviso di tetto superato, secondo cosa resta fuori.
 * null quando non resta fuori niente.
 */
export function overflowCopy(
  over: PlanOverflow,
  planName: string,
  t: Pick<Dictionary, 'overflow'>,
): { title: string; body: string } | null {
  if (over.products > 0 && over.customers > 0) {
    return {
      title: t.overflow.titleBoth,
      body: t.overflow.bodyBoth(over.products, over.customers, planName),
    };
  }
  if (over.customers > 0) {
    return {
      title: t.overflow.titleCustomers,
      body: t.overflow.bodyCustomers(over.customers, planName),
    };
  }
  if (over.products > 0) {
    return { title: t.overflow.title, body: t.overflow.body(over.products, planName) };
  }
  return null;
}

/** Come si scrive un tetto nel confronto fra piani. */
export function limitLabel(limit: number | null, t: Pick<Dictionary, 'planCompare'>): string {
  return limit == null ? t.planCompare.unlimited : String(limit);
}

export interface PlanComparisonRow {
  /**
   * Che riga e'. Serve alle poche che non si disegnano come tutte le altre —
   * oggi il matching, che porta il suo colore — e a ritrovare il costo, che e'
   * l'ancora a cui il matching si aggancia.
   */
  key: PlanComparisonKey;
  label: string;
  /** Quanti ne ha adesso questo negozio, fra parentesi. */
  note?: string;
  current: string;
  next: string;
  /**
   * Se il piano proposto comprende la funzione. Lo chiede solo il matching, a
   * cui il testo non basta: da qui esce anche il suo colore, e il testo non si
   * puo' interrogare per sapere che cosa dice senza riconoscerlo dalla frase.
   */
  nextIncluded?: boolean;
}

export type PlanComparisonKey =
  | 'products'
  | 'customers'
  | 'feeds'
  | 'matching'
  | 'monthlyCost';

/**
 * Le righe del confronto fra il piano in uso e quello proposto.
 *
 * Solo le voci che cambiano davvero fra i due: una tabella in cui meta' delle
 * righe ripete lo stesso valore fa sembrare l'aggiornamento meno utile di
 * quanto sia, e costringe a cercare col dito la differenza.
 */
export interface PlanComparisonCounts {
  /** Prodotti attivi che il negozio ha davvero. */
  products?: number | null;
  /** Clienti che hanno prestato il consenso al marketing. */
  customers?: number | null;
}

export function planComparisonRows(
  currentPlan: PlanForSuggestion,
  nextPlan: PlanForSuggestion,
  /** Valuta dei prezzi qui sopra: arriva con loro, non si indovina. */
  currency: string,
  locale: Locale,
  t: Strings,
  /**
   * Quanti ne ha, questo negozio, adesso.
   *
   * Un tetto e' un numero astratto finche' non gli si mette accanto il proprio:
   * "fino a 1000" non dice niente a chi non ricorda quanti prodotti ha. Con "(26)"
   * accanto si capisce in un colpo d'occhio se il piano basta.
   */
  counts: PlanComparisonCounts = {},
): PlanComparisonRow[] {
  const rows: PlanComparisonRow[] = [
    {
      key: 'products',
      label: t.planCompare.products,
      note: counts.products != null ? `(${counts.products.toLocaleString(locale)})` : undefined,
      current: limitLabel(currentPlan.maxProducts, t),
      next: limitLabel(nextPlan.maxProducts, t),
    },
    {
      key: 'customers',
      label: t.planCompare.customers,
      note: counts.customers != null ? `(${counts.customers.toLocaleString(locale)})` : undefined,
      current: currentPlan.customersSyncEnabled
        ? limitLabel(currentPlan.maxCustomers, t)
        : t.planCompare.notIncluded,
      next: nextPlan.customersSyncEnabled
        ? limitLabel(nextPlan.maxCustomers, t)
        : t.planCompare.notIncluded,
    },
    {
      key: 'feeds',
      // Il multi-feed non ha un tetto: o c'e' o non c'e'. Sta comunque in
      // elenco perche' e' una delle cose che cambiano passando di piano, e chi
      // sceglie deve vederle tutte.
      label: t.planCompare.feeds,
      current: currentPlan.productFeedsEnabled
        ? t.planCompare.included
        : t.planCompare.notIncluded,
      next: nextPlan.productFeedsEnabled ? t.planCompare.included : t.planCompare.notIncluded,
    },
    {
      key: 'monthlyCost',
      label: t.planCompare.monthlyCost,
      current: priceLabel(currentPlan.priceMonthly, currency, locale, t),
      next: priceLabel(nextPlan.priceMonthly, currency, locale, t),
    },
  ];

  return withMatching(
    rows.filter((row) => row.current !== row.next),
    currentPlan,
    nextPlan,
    t,
  );
}

/**
 * La riga del matching avanzato, messa al suo posto.
 *
 * Resta anche quando i due piani dicono la stessa cosa, mentre tutte le altre
 * spariscono se non cambiano: non e' una voce fra le voci, e' quello che il
 * piano fa con i clienti che gia' sincronizza, e chi sta per pagare vuole
 * saperlo comunque — anche quando la risposta e' che non cambia.
 *
 * Va per ultima prima del costo, come in fondo alle card dei prezzi sta
 * staccata da una riga di separazione: si legge quando si e' finito di leggere
 * cosa si ottiene, un attimo prima di leggere quanto costa. La posizione la
 * decide il costo e non un indice fisso, cosi' resta quella giusta anche se un
 * domani in mezzo se ne aggiungessero altre — o se il costo fosse l'unica riga
 * rimasta.
 */
function withMatching(
  rows: PlanComparisonRow[],
  currentPlan: PlanForSuggestion,
  nextPlan: PlanForSuggestion,
  t: Strings,
): PlanComparisonRow[] {
  const included = matchingIncluded(nextPlan);
  const matching: PlanComparisonRow = {
    key: 'matching',
    // Lo stesso nome che porta nelle card dei prezzi: e' la stessa funzione.
    label: t.plan.features.matching,
    // Al singolare: qui si parla di una funzione sola, non dei clienti che
    // restano fuori.
    current: matchingIncluded(currentPlan)
      ? t.planCompare.included
      : t.planCompare.notIncludedOne,
    next: included ? t.planCompare.included : t.planCompare.notIncludedOne,
    nextIncluded: included,
  };

  const price = rows.findIndex((row) => row.key === 'monthlyCost');
  // Nessun costo in elenco vorrebbe dire due piani che costano uguale: caso che
  // non si presenta proponendo un aggiornamento, ma se si presentasse il posto
  // giusto resta l'ultimo.
  const at = price === -1 ? rows.length : price;
  return [...rows.slice(0, at), matching, ...rows.slice(at)];
}

function priceLabel(
  price: number,
  currency: string,
  locale: Locale,
  t: Pick<Dictionary, 'planCompare'>,
): string {
  return price === 0
    ? t.planCompare.free
    : t.planCompare.perMonth(formatMoney(price, currency, locale));
}
