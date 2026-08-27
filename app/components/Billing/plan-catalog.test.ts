import { describe, it, expect } from 'vitest';
import { featureLabel } from './feature-label';
// Alias: `it` e' anche il nome del caso di test in vitest.
import { it as itDict } from '~/lib/i18n/it';
import { en as enDict } from '~/lib/i18n/en';
import {
  buildPlanCards,
  buildPlanFeatures,
  FEATURE_ORDER,
  manualSyncAllowed,
  type PlanRow,
} from './plan-catalog';

// Il listino come sta nella tabella `plans`.
const row = (over: Partial<PlanRow> = {}): PlanRow => ({
  planName: 'free',
  priceMonthly: 0,
  priceYearly: 0,
  maxProducts: 50,
  maxCustomers: 0,
  maxSyncFrequencyHours: 168,
  customersSyncEnabled: false,
  productFeedsEnabled: false,
  supportLevel: 'community',
  ...over,
});

const PLANS: PlanRow[] = [
  row(),
  row({
    planName: 'pro',
    priceMonthly: 29,
    maxProducts: 100,
    maxCustomers: 5000,
    maxSyncFrequencyHours: 96,
    customersSyncEnabled: true,
    supportLevel: 'email',
  }),
  row({
    planName: 'business',
    priceMonthly: 99,
    maxProducts: 400,
    maxCustomers: 50000,
    maxSyncFrequencyHours: 48,
    customersSyncEnabled: true,
    supportLevel: 'priority',
  }),
  row({
    planName: 'enterprise',
    priceMonthly: 299,
    maxProducts: null,
    maxCustomers: null,
    maxSyncFrequencyHours: 24,
    customersSyncEnabled: true,
    supportLevel: 'dedicated',
  }),
  row({
    planName: 'lifetime',
    priceMonthly: 0,
    maxProducts: null,
    maxCustomers: null,
    maxSyncFrequencyHours: 0.5,
    customersSyncEnabled: true,
    supportLevel: 'dedicated',
  }),
];

describe('buildPlanCards', () => {
  it('lifetime non compare: non e’ un piano che si compra', () => {
    expect(buildPlanCards(PLANS).map((p) => p.name)).toEqual([
      'free',
      'pro',
      'business',
      'enterprise',
    ]);
  });

  it('il nome e’ quello scritto nella tabella, senza ritocchi', () => {
    // Se l'owner scrive "Pro Plus " nella colonna, sulla card si legge quello.
    const cards = buildPlanCards([row({ planName: 'Pro Plus ', priceMonthly: 49 })]);
    expect(cards[0].name).toBe('Pro Plus ');
  });

  it('dal piu’ economico al piu’ caro', () => {
    const shuffled = [PLANS[3], PLANS[0], PLANS[2], PLANS[1]];
    expect(buildPlanCards(shuffled).map((p) => p.priceMonthly)).toEqual([0, 29, 99, 299]);
  });

  it('un solo consigliato', () => {
    expect(buildPlanCards(PLANS).filter((p) => p.recommended)).toHaveLength(1);
  });
});

describe('buildPlanFeatures', () => {
  it('stesse righe, nello stesso ordine, per ogni piano', () => {
    for (const plan of buildPlanCards(PLANS)) {
      expect(plan.features.map((f) => f.key)).toEqual([...FEATURE_ORDER]);
    }
  });

  it('i limiti sono quelli della tabella, e restano numeri', () => {
    // La riga porta il dato, non la frase: la frase si compone dove si legge,
    // che e' l'unico posto in cui si sa in che lingua sta guardando il merchant.
    const value = (plan: PlanRow, key: string) =>
      buildPlanFeatures(plan).find((f) => f.key === key)!.value;

    expect(value(row({ maxProducts: 50 }), 'products')).toBe(50);
    expect(value(row({ maxProducts: null }), 'products')).toBeNull();
    expect(value(row({ maxSyncFrequencyHours: 168 }), 'sync')).toBe(168);
  });

  it('i clienti seguono il piano: inclusi col loro tetto, altrimenti riga grigia', () => {
    const customers = (plan: PlanRow) =>
      buildPlanFeatures(plan).find((f) => f.key === 'customers')!;

    expect(customers(row({ customersSyncEnabled: false }))).toEqual({
      key: 'customers',
      included: false,
      value: null,
    });
    expect(customers(row({ customersSyncEnabled: true, maxCustomers: 50000 })).value).toBe(
      50000,
    );
    expect(customers(row({ customersSyncEnabled: true, maxCustomers: null })).value).toBeNull();
  });

  it('l’assistenza segue il livello registrato', () => {
    const has = (level: string, key: string) =>
      buildPlanFeatures(row({ supportLevel: level })).find((f) => f.key === key)!.included;

    // Il livello di assistenza decide una riga sola: il push manuale, e solo
    // per l'assistenza dedicata. Email e chat non sono piu' in elenco — erano
    // su tutte le card o su nessuna, e una riga uguale ovunque non aiuta a
    // scegliere.
    expect(has('community', 'push')).toBe(false);
    expect(has('email', 'push')).toBe(false);
    expect(has('priority', 'push')).toBe(false);
    expect(has('dedicated', 'push')).toBe(true);
  });

  it('l elenco segue l ordine in cui si legge un piano', () => {
    // Prima ogni quanto i dati si allineano, poi quanto ci sta, poi cosa si
    // puo' farci: dal vincolo che si sente ogni giorno a quello che si nota
    // una volta sola.
    expect(buildPlanFeatures(row()).map((f) => f.key)).toEqual([
      'sync',
      'products',
      'customers',
      'feeds',
      'push',
      'matching',
    ]);
  });

  it('il multi-feed segue quello che il piano concede', () => {
    const feeds = (enabled: boolean) =>
      buildPlanFeatures(row({ productFeedsEnabled: enabled })).find((f) => f.key === 'feeds')!
        .included;

    expect(feeds(true)).toBe(true);
    expect(feeds(false)).toBe(false);
  });

  it('le label restano corte in ogni lingua, altrimenti una card si alza sulle altre', () => {
    for (const dictionary of [itDict, enDict]) {
      for (const plan of buildPlanCards(PLANS)) {
        for (const feature of plan.features) {
          const label = featureLabel(feature, dictionary, 'it');
          expect(label.length).toBeLessThanOrEqual(26);
        }
      }
    }
  });
});

describe('manualSyncAllowed', () => {
  it('lo concede la sola assistenza dedicata, cioe Enterprise', () => {
    // Una sincronizzazione chiesta a mano costa una lettura completa di Shopify
    // ogni volta che si preme: concederla a meta' listino significa pagarla noi
    // per tutti.
    expect(manualSyncAllowed('dedicated')).toBe(true);
  });

  it('gli altri no, "priority" compreso', () => {
    expect(manualSyncAllowed('community')).toBe(false);
    expect(manualSyncAllowed('email')).toBe(false);
    expect(manualSyncAllowed('priority')).toBe(false);
  });

  it('regge maiuscole e spazi: il livello lo scrive l owner a mano', () => {
    expect(manualSyncAllowed('  Dedicated ')).toBe(true);
  });

  it('senza livello non si concede niente', () => {
    // Un piano di cui non si conosce il livello non deve sbloccare una funzione:
    // meglio un pulsante che non compare di uno che compare a chi non l'ha pagato.
    expect(manualSyncAllowed(null)).toBe(false);
    expect(manualSyncAllowed(undefined)).toBe(false);
    expect(manualSyncAllowed('')).toBe(false);
  });

  it('dice la stessa cosa della riga nella card', () => {
    // Due letture dello stesso insieme sono due posti dove sbagliare: qui si
    // verifica che il pulsante e la riga del piano restino d'accordo.
    for (const level of ['community', 'email', 'priority', 'dedicated']) {
      const inCard = buildPlanFeatures(row({ supportLevel: level })).find(
        (f) => f.key === 'push',
      )!.included;
      expect(manualSyncAllowed(level)).toBe(inCard);
    }
  });
});
