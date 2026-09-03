import { isSelectablePlan } from './plan-access';

// Le card della tab Piano si costruiscono dalla tabella `plans`: nome, prezzo e
// limiti sono quelli registrati li', non una copia scritta a mano che col tempo
// finirebbe per raccontare qualcosa di diverso da cio' che l'app applica
// davvero. Il nome compare com'e' scritto nella colonna, senza ritocchi.
//
// Resta qui il solo testo che nel database non c'e': le righe che descrivono il
// livello di assistenza.

// Ogni card mostra ESATTAMENTE queste righe, in questo ordine: cambia solo la
// disponibilita' (spunta verde / X grigia) e il valore dentro la label. Cosi' le
// righe delle card restano allineate e le card hanno la stessa altezza.
export const FEATURE_ORDER = [
  'sync',
  'products',
  'customers',
  'database',
  'feeds',
  'push',
  // Ultima e staccata dalle altre: non e' una funzione in piu' nell'elenco, e'
  // quello che il piano fa con i clienti che gia' sincronizza. Va dove l'occhio
  // arriva per ultimo, dopo una riga di separazione.
  'matching',
] as const;

export type FeatureKey = (typeof FEATURE_ORDER)[number];

export interface PlanFeature {
  key: FeatureKey;
  included: boolean; // true = SI (verde), false = NO (grigio)
  /**
   * Il numero dentro la riga, quando ce n'e' uno: il tetto di prodotti o
   * clienti, oppure le ore fra una sincronizzazione e l'altra. `null` significa
   * "nessun tetto" dove un tetto e' previsto.
   *
   * Il testo non si compone qui ma dove si legge: queste righe nascono anche
   * nei loader, che non sanno in che lingua sta guardando il merchant.
   */
  value: number | null;
}

export interface PlanCard {
  /** Nome del piano com'e' scritto nella tabella: e' anche la chiave. */
  name: string;
  priceMonthly: number;
  priceYearly: number;
  /** Prezzo riservato al partner del negozio, se ce n'e' uno. null = listino. */
  partnerMonthly: number | null;
  partnerYearly: number | null;
  recommended: boolean;
  features: PlanFeature[];
}

/** La riga di `plans` per come serve alla tab. */
export interface PlanRow {
  planName: string;
  priceYearly: number;
  priceMonthly: number;
  maxProducts: number | null;
  maxCustomers: number | null;
  maxSyncFrequencyHours: number;
  customersSyncEnabled: boolean;
  supportLevel: string;
  /** I feed di catalogo: una funzione che il piano concede o no. */
  productFeedsEnabled: boolean;
}

// Piano proposto per primo. Il confronto e' senza maiuscole perche' il nome nella
// tabella lo scrive l'owner e puo' cambiare forma.
const RECOMMENDED_PLAN = 'pro';

function productsFeature(plan: PlanRow): PlanFeature {
  return { key: 'products', included: true, value: plan.maxProducts };
}

function feedsFeature(plan: PlanRow): PlanFeature {
  return { key: 'feeds', included: plan.productFeedsEnabled, value: null };
}

// Il database si sincronizza su tutti i piani — incluso il Free — quindi la
// riga e' sempre inclusa. Cambia solo l'etichetta: "limitato" sul Free (che ha
// un tetto di prodotti e non sincronizza i clienti), "esteso" sugli altri.
// L'etichetta dinamica si compone in feature-label.ts, che riceve il planName e
// lo confronta — qui basta dichiarare che la riga c'e'.
function databaseFeature(plan: PlanRow): PlanFeature {
  return { key: 'database', included: true, value: null };
}

function customersFeature(plan: PlanRow): PlanFeature {
  if (!plan.customersSyncEnabled) {
    return { key: 'customers', included: false, value: null };
  }
  return { key: 'customers', included: true, value: plan.maxCustomers };
}

// Il livello di assistenza (`support_level`) decide una sola riga: se il push
// manuale e' concesso. Le altre due che ne uscivano — email e chat — erano su
// tutte le card o su nessuna, e una riga uguale ovunque non aiuta a scegliere.
// Solo l'assistenza dedicata, cioe' Enterprise (e Lifetime, che assegniamo
// noi). Prima bastava anche "priority": una sincronizzazione chiesta a mano
// costa una lettura completa di Shopify ogni volta che si preme, e concederla a
// meta' listino significa pagarla noi per tutti.
const PUSH_LEVELS = new Set(['dedicated']);

/**
 * Se questo piano concede il push manuale.
 *
 * Una funzione e non il solo insieme perche' la stessa domanda si fa in due
 * posti — la riga della card e il pulsante in dashboard — e due letture dello
 * stesso insieme sono due posti dove sbagliare il confronto.
 */
export function manualSyncAllowed(supportLevel: string | null | undefined): boolean {
  return PUSH_LEVELS.has((supportLevel ?? '').trim().toLowerCase());
}

/**
 * Se il piano comprende il matching avanzato.
 *
 * Il riconoscimento di uno stesso cliente fra dispositivi diversi poggia sui
 * dati dei clienti: dove quelli non si sincronizzano non c'e' niente su cui
 * riconoscere nessuno, quindi la risposta segue esattamente quella.
 *
 * Sta in una funzione e non nel confronto scritto due volte perche' la stessa
 * domanda ormai si fa in due posti — la riga in fondo alle card dei prezzi e la
 * riga del confronto nel modal di aggiornamento — e due letture dello stesso
 * dato sono due posti da cui un domani possono uscire risposte diverse.
 */
export function matchingIncluded(plan: { customersSyncEnabled: boolean }): boolean {
  return plan.customersSyncEnabled;
}

export function buildPlanFeatures(plan: PlanRow): PlanFeature[] {
  const level = (plan.supportLevel ?? '').trim().toLowerCase();
  // L'ordine va dal vincolo che si sente ogni giorno a quello che si nota una
  // volta sola: prima ogni quanto i dati si allineano, poi quanti prodotti e
  // quanti clienti ci stanno, poi cosa si puo' farci. L'assistenza non e' piu'
  // in elenco: era su tutte le card uguale, e una riga identica ovunque non
  // aiuta a scegliere.
  return [
    { key: 'sync', included: true, value: plan.maxSyncFrequencyHours },
    productsFeature(plan),
    customersFeature(plan),
    databaseFeature(plan),
    feedsFeature(plan),
    { key: 'push', included: PUSH_LEVELS.has(level), value: null },
    // Il riconoscimento di uno stesso cliente fra dispositivi diversi poggia
    // sui dati dei clienti: dove quelli non si sincronizzano non c'e' niente su
    // cui riconoscere nessuno, quindi la riga segue esattamente quella.
    { key: 'matching', included: matchingIncluded(plan), value: null },
  ];
}

/**
 * Le card da mostrare, dal piano piu' economico al piu' caro.
 *
 * Fuori restano i piani non acquistabili (lifetime, assegnato dall'owner): non
 * c'e' nulla da comprare e non hanno posto in un listino.
 */
export function buildPlanCards(
  plans: PlanRow[],
  /** Listino riservato del negozio, per nome piano. Vuoto = nessuno sconto. */
  partnerPrices: Record<string, { priceMonthly: number; priceYearly: number }> = {},
): PlanCard[] {
  return plans
    .filter((plan) => isSelectablePlan(plan.planName))
    .sort((a, b) => a.priceMonthly - b.priceMonthly || a.planName.localeCompare(b.planName))
    .map((plan) => {
      const reserved = partnerPrices[plan.planName] ?? null;
      return {
        name: plan.planName,
        priceMonthly: plan.priceMonthly,
        priceYearly: plan.priceYearly,
        partnerMonthly: reserved?.priceMonthly ?? null,
        partnerYearly: reserved?.priceYearly ?? null,
        recommended: plan.planName.trim().toLowerCase() === RECOMMENDED_PLAN,
        features: buildPlanFeatures(plan),
      };
    });
}
