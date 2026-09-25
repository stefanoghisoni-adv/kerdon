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
  { planName: 'basic', priceMonthly: 0, priceYearly: 0, maxProducts: 50, maxCustomers: 200, customersSyncEnabled: false },
  { planName: 'growth', priceMonthly: 19, priceYearly: 290, maxProducts: 200, maxCustomers: 500, customersSyncEnabled: true },
  { planName: 'scale', priceMonthly: 49, priceYearly: 990, maxProducts: 1000, maxCustomers: 2000, customersSyncEnabled: true },
  { planName: 'core', priceMonthly: 79, priceYearly: 2990, maxProducts: null, maxCustomers: null, customersSyncEnabled: true },
  { planName: 'lifetime', priceMonthly: 0, priceYearly: 0, maxProducts: null, maxCustomers: null, customersSyncEnabled: true },
];

describe('suggestPlanForProducts', () => {
  it('propone il piu economico che contiene tutti i prodotti', () => {
    // 78 prodotti su Basic (tetto 50): Growth ne regge 200 e basta.
    expect(suggestPlanForProducts(PLANS, 'basic', 78)?.planName).toBe('growth');
  });

  it('sale di piu quando il primo passo non basterebbe', () => {
    // 640 supera anche Growth: il primo che li contiene tutti e' Scale.
    expect(suggestPlanForProducts(PLANS, 'basic', 640)?.planName).toBe('scale');
  });

  it('arriva al piano senza tetto quando nessun tetto basta', () => {
    expect(suggestPlanForProducts(PLANS, 'scale', 5000)?.planName).toBe('core');
  });

  it('non propone nulla se i prodotti stanno nel tetto attuale', () => {
    expect(suggestPlanForProducts(PLANS, 'basic', 50)).toBeNull();
    expect(suggestPlanForProducts(PLANS, 'basic', 12)).toBeNull();
  });

  it('non propone nulla a chi non ha tetto', () => {
    expect(suggestPlanForProducts(PLANS, 'core', 99999)).toBeNull();
  });

  it('non propone MAI il piano interno, per quanto conveniente sembri', () => {
    // Lifetime costa zero e non ha tetti: senza il filtro sarebbe sempre il
    // primo scelto, e manderebbe il merchant su una pagina che per lui non
    // esiste.
    const suggested = suggestPlanForProducts(PLANS, 'basic', 78);
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
    expect(suggestPlanForProducts(strano, 'basic', 78)?.planName).toBe('growth');
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
      'Matching avanzato',
      'Costo mensile',
    ]);
    expect(rows[0]).toEqual({
      key: 'products',
      label: 'Prodotti sincronizzabili',
      current: '50',
      next: '200',
    });
    expect(rows[1].current).toBe('Non inclusi');
    expect(rows[1].next).toBe('500');
    expect({ ...rows[3], next: rows[3].next.replace(/\u00a0/g, ' ') }).toEqual({
      key: 'monthlyCost',
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
    // Il matching e' l'unica riga che resta anche quando non cambia: vedi il
    // caso qui sotto.
    expect(rows.filter((r) => r.key !== 'matching').every((r) => r.current !== r.next)).toBe(
      true,
    );
  });

  it('il matching dice se il piano proposto lo comprende', () => {
    // Basic non sincronizza i clienti, Growth si': senza clienti da riconoscere non
    // c'e' matching, e la riga lo dice con le stesse parole delle card.
    const rows = planComparisonRows(free, pro, 'USD', 'it', itDict);
    const matching = rows.find((r) => r.key === 'matching')!;
    expect(matching.label).toBe('Matching avanzato');
    expect(matching.current).toBe('Non incluso');
    expect(matching.next).toBe('Incluso');
    // Da qui esce anche il colore: al testo non si puo' chiedere cosa dice.
    expect(matching.nextIncluded).toBe(true);
  });

  it('il matching manca dove mancano i clienti, e si vede', () => {
    // Un piano piu' caro che pero' i clienti non li sincronizza: il matching
    // segue loro, non il prezzo.
    const senzaClienti: PlanForSuggestion = {
      planName: 'basic',
      priceMonthly: 9,
      priceYearly: 90,
      maxProducts: 100,
      maxCustomers: 0,
      customersSyncEnabled: false,
    };
    const rows = planComparisonRows(free, senzaClienti, 'USD', 'it', itDict);
    const matching = rows.find((r) => r.key === 'matching')!;
    // Al singolare: qui si parla di una funzione, non dei clienti esclusi.
    expect(matching.next).toBe('Non incluso');
    expect(matching.nextIncluded).toBe(false);
  });

  it('il matching resta anche quando i due piani lo comprendono entrambi', () => {
    // Tutte le altre righe uguali spariscono; questa no. Non e' una voce fra le
    // voci: e' quello che il piano fa con i clienti che gia' sincronizza, e chi
    // sta per pagare vuole leggerlo comunque.
    const business = PLANS[2];
    const enterprise = PLANS[3];
    const rows = planComparisonRows(business, enterprise, 'USD', 'it', itDict);
    const matching = rows.find((r) => r.key === 'matching')!;
    expect(matching.current).toBe('Incluso');
    expect(matching.next).toBe('Incluso');
  });

  it('il matching sta sempre attaccato al costo, appena sopra', () => {
    // Ancorato al prezzo e non a una posizione fissa: si legge per ultimo,
    // quando si e' finito di leggere cosa si ottiene e un attimo prima di
    // leggere quanto costa. Vale con molte righe sopra...
    const rows = planComparisonRows(free, PLANS[3], 'USD', 'it', itDict);
    const matching = rows.findIndex((r) => r.key === 'matching');
    expect(rows[matching + 1].key).toBe('monthlyCost');

    // ...e vale anche quando il costo e' l'unica riga rimasta, perche' fra i due
    // piani non cambia altro.
    const caro: PlanForSuggestion = { ...PLANS[2], planName: 'business-plus', priceMonthly: 69 };
    const soloPrezzo = planComparisonRows(PLANS[2], caro, 'USD', 'it', itDict);
    expect(soloPrezzo.map((r) => r.key)).toEqual(['matching', 'monthlyCost']);
  });

  it('scrive per esteso l assenza di tetto', () => {
    expect(limitLabel(null, itDict)).toBe('Illimitati');
    expect(limitLabel(200, itDict)).toBe('200');
  });
});
