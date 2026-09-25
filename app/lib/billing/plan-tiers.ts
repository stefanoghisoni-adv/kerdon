// Modulo puro: nessun import da un `.server`, cosi' vale identico nei loader,
// nei componenti, nei worker e nei test sulle migrazioni.
//
// IL LISTINO, UNA VOLTA SOLA. Le card, i limiti e i prezzi che l'app applica si
// leggono dal database (`plans` e `plan_prices`): e' li' che l'owner li puo'
// ritoccare. Questo file e' il listino DECISO, quello a cui il database deve
// arrivare: `owner-bootstrap.sql` lo semina, la migrazione
// 20260926000000_plans_basic_growth_scale_core ci porta un database esistente, e
// `prisma/plan-catalog-sync.test.ts` controlla che le tre cose dicano lo stesso.
//
// Qui stanno anche le poche regole che dipendono dal NOME di un piano: quale si
// consiglia, quale e' il gratuito, e come si traducono i nomi di prima.

/** Uno scaglione del listino, dal piu' economico al piu' caro. */
export interface PlanTier {
  name: string;
  /** Stesse cifre in ogni valuta del listino. Annuale = dieci mensilita'. */
  priceMonthly: number;
  priceYearly: number;
  /** null = nessun tetto. */
  maxProducts: number | null;
  /** null = nessun tetto. 0 sul piano che i clienti non li sincronizza. */
  maxCustomers: number | null;
  customersSyncEnabled: boolean;
  /** I feed di catalogo: inclusi o no, mai con un tetto di quantita'. */
  productFeedsEnabled: boolean;
}

export const PLAN_TIERS: readonly PlanTier[] = [
  {
    name: 'Basic',
    priceMonthly: 0,
    priceYearly: 0,
    maxProducts: 20,
    maxCustomers: 0,
    customersSyncEnabled: false,
    productFeedsEnabled: false,
  },
  {
    name: 'Growth',
    priceMonthly: 29,
    priceYearly: 290,
    maxProducts: 200,
    maxCustomers: 250,
    customersSyncEnabled: true,
    productFeedsEnabled: true,
  },
  {
    name: 'Scale',
    priceMonthly: 79,
    priceYearly: 790,
    maxProducts: 1000,
    maxCustomers: 500,
    customersSyncEnabled: true,
    productFeedsEnabled: true,
  },
  {
    name: 'Core',
    priceMonthly: 149,
    priceYearly: 1490,
    maxProducts: null,
    maxCustomers: null,
    customersSyncEnabled: true,
    productFeedsEnabled: true,
  },
];

/** Le valute in cui il listino e' scritto, con le stesse cifre. */
export const PLAN_CURRENCIES = ['EUR', 'USD'] as const;

/** Il piano gratuito, su cui nasce un negozio nuovo. */
export const BASE_PLAN_NAME = 'Basic';

/** Il piano proposto per primo nelle card dei prezzi. */
export const RECOMMENDED_PLAN_NAME = 'Growth';

/**
 * I nomi di prima, e il piano che indicano oggi.
 *
 * Nessuno di questi nomi esiste piu' nel listino, quindi la traduzione non e'
 * mai ambigua. Serve per cio' che il cambio di nome sul database non raggiunge:
 * gli abbonamenti su Shopify, che portano il nome con cui sono nati, e i link o
 * gli state firmati prima del cambio.
 */
export const LEGACY_PLAN_NAMES: Readonly<Record<string, string>> = {
  free: 'Basic',
  pro: 'Growth',
  business: 'Scale',
  enterprise: 'Core',
};

/**
 * I nomi della migrazione 20260923000000_pricing_alignment, che li aveva
 * assegnati uno scaglione piu' in basso: "Core" era il piano da 29, "Growth"
 * quello da 79, "Scale" quello da 149.
 *
 * Sono gli stessi nomi di oggi, quindi dal solo nome non si distinguono. Un
 * abbonamento nato allora si riconosce dal prezzo: vedi `resolvePlanName`.
 */
export const INTERIM_PLAN_NAMES: Readonly<Record<string, string>> = {
  core: 'Growth',
  growth: 'Scale',
  scale: 'Core',
};

function key(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

function tierByName(name: string): PlanTier | undefined {
  const wanted = key(name);
  return PLAN_TIERS.find((tier) => key(tier.name) === wanted);
}

function hasListPrice(tier: PlanTier | undefined, amount: number): boolean {
  if (!tier) return false;
  return Math.abs(tier.priceMonthly - amount) < 0.005 || Math.abs(tier.priceYearly - amount) < 0.005;
}

/**
 * Il nome del piano di oggi per un nome che puo' essere di prima.
 *
 * - "Free", "Pro", "Business", "Enterprise": tradotti sempre.
 * - "Core", "Growth", "Scale": sono nomi di oggi, e restano tali, a meno che
 *   l'importo di listino dell'abbonamento sia quello dello scaglione che quel
 *   nome indicava prima (un "Core" da 29 e' il Growth di oggi). Senza importo
 *   non si indovina: vale il nome di oggi.
 * - Tutto il resto (Lifetime, un piano aggiunto a mano) torna com'e'.
 *
 * `listPrice` e' l'importo di listino, mensile o annuale: i due scaglioni non
 * hanno cifre in comune, quindi basta uno dei due.
 */
export function resolvePlanName(
  name: string | null | undefined,
  listPrice?: number | null,
): string {
  const trimmed = (name ?? '').trim();
  const id = key(trimmed);
  if (!id) return trimmed;

  const legacy = LEGACY_PLAN_NAMES[id];
  if (legacy) return legacy;

  const interim = INTERIM_PLAN_NAMES[id];
  if (interim && listPrice != null && Number.isFinite(listPrice)) {
    const today = tierByName(trimmed);
    const before = tierByName(interim);
    if (hasListPrice(before, listPrice) && !hasListPrice(today, listPrice)) return interim;
  }

  return trimmed;
}

/**
 * Come `resolvePlanName`, ma senza tirare a indovinare: null quando il nome e'
 * uno di quelli di mezzo (Core/Growth/Scale) e l'importo non basta a dire se
 * l'abbonamento e' nato prima o dopo il cambio di listino — importo assente, o
 * che non e' ne' quello di oggi ne' quello di allora (uno sconto, una valuta
 * con altre cifre).
 *
 * Serve dove un errore si paga: attivare un piano. Letto col nome di oggi, un
 * "Core" nato da 29 diventerebbe il Core da 149.
 */
export function resolvePlanNameStrict(
  name: string | null | undefined,
  listPrice?: number | null,
): string | null {
  const trimmed = (name ?? '').trim();
  const id = key(trimmed);
  const interim = INTERIM_PLAN_NAMES[id];
  if (!interim) return resolvePlanName(trimmed, listPrice);

  if (listPrice == null || !Number.isFinite(listPrice)) return null;
  const today = hasListPrice(tierByName(trimmed), listPrice);
  const before = hasListPrice(tierByName(interim), listPrice);
  if (today === before) return null;
  return today ? tierByName(trimmed)!.name : interim;
}

/** Se questo e' il piano gratuito del listino, con il nome di oggi o di prima. */
export function isBasePlan(name: string | null | undefined): boolean {
  return key(resolvePlanName(name)) === key(BASE_PLAN_NAME);
}
