import { describe, it, expect } from 'vitest';
import { countsAsSale, orderToRows, type ShopifyOrder, type ShopifyOrderLine } from './order-rows';
import type { LogisticsConfig } from '~/lib/shipping/types';

const SYNCED = new Date('2026-08-24T10:00:00Z');

/**
 * Una riga come la consegna la rilettura GraphQL: i due campi canonici pieni.
 *
 * `quantity` e `unit_price` ci sono lo stesso — sono i numeri che il merchant
 * riconosce guardando una riga d'ordine — ma nessun conto li tocca.
 */
const line = (over: Partial<ShopifyOrderLine> = {}): ShopifyOrderLine => ({
  id: 900,
  title: 'Maglia',
  quantity: 2,
  current_quantity: 2,
  product_id: 10,
  variant_id: 20,
  unit_price: '19.95',
  total_discount: '0.00',
  line_net_total: '39.90',
  line_currency: 'EUR',
  ...over,
});

const order = (over: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: 111,
  order_number: '#1001',
  placed_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:05:00Z',
  cancelled_at: null,
  financial_status: 'paid',
  total_price: '39.90',
  currency: 'EUR',
  customer_id: 55,
  customer_first_name: 'Anna',
  customer_last_name: 'Rossi',
  lines: [line()],
  lines_complete: true,
  ...over,
});

describe('orderToRows', () => {
  it('separa l ordine dalle sue righe', () => {
    const rows = orderToRows(order(), SYNCED)!;

    expect(rows.order.shopify_order_id).toBe(111);
    expect(rows.order.shopify_customer_id).toBe(55);
    expect(rows.lines).toHaveLength(1);
    expect(rows.lines[0].shopify_order_id).toBe(111);
    expect(rows.lines[0].shopify_variant_id).toBe(20);
  });

  it('il denaro diventa numero', () => {
    const rows = orderToRows(order(), SYNCED)!;
    expect(rows.order.total_price).toBe(39.9);
    expect(rows.lines[0].unit_price).toBe(19.95);
    expect(rows.lines[0].line_net_total).toBe(39.9);
  });

  it('un ordine senza id non si scrive: alla corsa dopo sarebbe un doppione', () => {
    expect(orderToRows(order({ id: null }), SYNCED)).toBeNull();
  });

  it('una riga senza id resta fuori, l ordine no', () => {
    const rows = orderToRows(
      order({
        lines: [line({ id: null, title: 'Ignota' }), line({ id: 901, variant_id: 21 })],
      }),
      SYNCED,
    )!;

    expect(rows.lines).toHaveLength(1);
    expect(rows.lines[0].shopify_line_id).toBe(901);
  });

  it('un acquisto senza account resta senza cliente, e non si butta', () => {
    // L'ordine esiste e vale per i totali del negozio: semplicemente non
    // appartiene a nessuno da mettere in elenco.
    const rows = orderToRows(order({ customer_id: null, customer_first_name: null }), SYNCED)!;
    expect(rows.order.shopify_customer_id).toBeNull();
  });

  it('nelle righe non finisce nessun costo: il costo vive nei prodotti', () => {
    const rows = orderToRows(order(), SYNCED)!;
    expect(Object.keys(rows.lines[0])).not.toContain('cost');
    expect(Object.keys(rows.lines[0])).not.toContain('profit');
  });

  it('la riga si porta dietro quando Shopify ha toccato l ordine', () => {
    // Diverso da `synced_at`, che dice quando l'abbiamo letta noi: serve a
    // riconoscere una consegna vecchia arrivata dopo una nuova.
    const rows = orderToRows(order(), SYNCED)!;
    expect(rows.lines[0].source_updated_at).toBe('2026-08-01T09:05:00Z');
    expect(rows.lines[0].synced_at).toBe('2026-08-24T10:00:00.000Z');
  });
});

/**
 * I casi per cui tutto questo esiste.
 *
 * L'ordine seguiva `currentTotalPriceSet`, che i rimborsi li riflette, mentre
 * ogni riga conservava la quantita' ordinata e un prezzo unitario con dentro
 * sconti riferiti anche a unita' rimborsate. Le metriche moltiplicavano quei
 * due valori.
 */
describe('orderToRows — cosa resta al cliente dopo un rimborso', () => {
  it('ordine non rimborsato: il totale coincide col netto delle sue righe', () => {
    // Sconto di riga E sconto d'ordine, cioe' il caso in cui il prezzo unitario
    // e' un'approssimazione: 100 di listino, 10 di sconto riga, 5 di sconto
    // ordine spalmato. Il netto di riga e' quello canonico di Shopify, e la
    // somma torna esattamente al totale dell'ordine — cosa che il prodotto
    // prezzo x quantita' non garantisce.
    const rows = orderToRows(
      order({
        total_price: '127.00',
        lines: [
          line({ id: 900, quantity: 3, current_quantity: 3, unit_price: '28.33', line_net_total: '85.00' }),
          line({ id: 901, quantity: 1, current_quantity: 1, unit_price: '42.00', line_net_total: '42.00' }),
        ],
      }),
      SYNCED,
    )!;

    const sommaRighe = rows.lines.reduce((t, l) => t + (l.line_net_total ?? 0), 0);
    expect(sommaRighe).toBe(rows.order.total_price);
    expect(sommaRighe).toBe(127);
  });

  it('rimborso parziale di quantita: la quantita ordinata resta, quella corrente scende', () => {
    // Tre pezzi ordinati, uno reso. `quantity` non cambiera' mai piu' — e' cio'
    // che il merchant legge sulla sua fattura — ma il conto guarda l'altra.
    const rows = orderToRows(
      order({
        lines: [line({ quantity: 3, current_quantity: 2, line_net_total: '39.90' })],
      }),
      SYNCED,
    )!;

    expect(rows.lines[0].quantity).toBe(3);
    expect(rows.lines[0].current_quantity).toBe(2);
    expect(rows.lines[0].line_net_total).toBe(39.9);
  });

  it('rimborso monetario parziale: il netto segue il campo canonico, non prezzo per quantita', () => {
    // Nessun pezzo tornato indietro (la quantita' corrente resta piena) ma
    // parte del denaro si': e' il rimborso che il vecchio conto non poteva
    // vedere in nessun modo, perche' guardava solo prezzo e quantita'.
    const rows = orderToRows(
      order({
        financial_status: 'partially_refunded',
        total_price: '25.00',
        lines: [line({ quantity: 2, current_quantity: 2, unit_price: '19.95', line_net_total: '25.00' })],
      }),
      SYNCED,
    )!;

    expect(rows.lines[0].line_net_total).toBe(25);
    // Prezzo per quantita' avrebbe detto 39.90: quasi il sessanta per cento in
    // piu' di quanto il negozio ha davvero incassato.
    expect(rows.lines[0].line_net_total).not.toBe(39.9);
  });

  it('rimborso totale di una riga: contributo a zero, e l ordine non e annullato', () => {
    // Il caso che sfuggiva a tutti i controlli: `cancelled_at` resta null —
    // l'ordine e' valido, magari le altre righe sono partite — ma quella riga
    // non vale piu' niente. Il netto si azzera insieme alla quantita', perche'
    // un netto pieno accanto a zero unita' e' proprio la contraddizione da cui
    // nasce tutto questo.
    const rows = orderToRows(
      order({
        cancelled_at: null,
        financial_status: 'refunded',
        total_price: '0.00',
        lines: [line({ quantity: 2, current_quantity: 0, line_net_total: '39.90' })],
      }),
      SYNCED,
    )!;

    expect(rows.order.cancelled_at).toBeNull();
    expect(rows.lines[0].current_quantity).toBe(0);
    expect(rows.lines[0].line_net_total).toBe(0);
  });

  it('senza quantita corrente si ripiega su quella ordinata, non su zero', () => {
    // Se Shopify non mandasse `currentQuantity` — un'API piu' vecchia di quella
    // per cui questo codice e' scritto — il ripiego riproduce il comportamento
    // di prima. Azzerare sarebbe l'errore piu' grosso dei due: farebbe sparire
    // ogni riga invece di sovrastimarne qualcuna.
    const rows = orderToRows(
      order({ lines: [line({ quantity: 3, current_quantity: null })] }),
      SYNCED,
    )!;

    expect(rows.lines[0].current_quantity).toBe(3);
  });

  it('una riga senza netto resta senza netto: non lo si ricostruisce moltiplicando', () => {
    // Ricostruirlo da un prezzo unitario e' l'approssimazione da cui si sta
    // scappando. Meglio una riga dichiarata non misurabile che un numero
    // inventato sotto il nome del campo canonico.
    const rows = orderToRows(
      order({ lines: [line({ line_net_total: null, unit_price: '19.95', quantity: 2 })] }),
      SYNCED,
    )!;

    expect(rows.lines[0].line_net_total).toBeNull();
  });
});

describe('orderToRows — la valuta', () => {
  it('la riga porta la sua valuta', () => {
    const rows = orderToRows(order(), SYNCED)!;
    expect(rows.lines[0].line_currency).toBe('EUR');
  });

  it('se la riga non la dichiara, vale quella dell ordine', () => {
    const rows = orderToRows(
      order({ currency: 'USD', lines: [line({ line_currency: null })] }),
      SYNCED,
    )!;
    expect(rows.lines[0].line_currency).toBe('USD');
  });

  it('una riga in valuta diversa dall ordine si scrive com e, e si vede', () => {
    // Non si corregge e non si nasconde: la riga conserva cio' che ha
    // dichiarato, e a rifiutarsi di sommarla e' il conto (vedi
    // `net-contribution`). Riscriverla con la valuta dell'ordine renderebbe il
    // problema invisibile proprio a chi deve accorgersene.
    const rows = orderToRows(
      order({ currency: 'EUR', lines: [line({ line_currency: 'USD' })] }),
      SYNCED,
    )!;

    expect(rows.order.currency).toBe('EUR');
    expect(rows.lines[0].line_currency).toBe('USD');
  });
});

describe('countsAsSale', () => {
  it('un ordine annullato non e profitto', () => {
    expect(countsAsSale({ cancelled_at: '2026-08-02T10:00:00Z' })).toBe(false);
  });

  it('gli altri si', () => {
    expect(countsAsSale({ cancelled_at: null })).toBe(true);
  });

  it('un ordine rimborsato resta una vendita: a portarlo a zero sono le righe', () => {
    // La differenza conta: l'annullato non e' mai partito, il rimborsato si' —
    // e a dire quanto ne e' rimasto sono `current_quantity` e `line_net_total`,
    // non un'esclusione in blocco che porterebbe via anche le righe partite.
    expect(countsAsSale({ cancelled_at: null })).toBe(true);
  });
});

describe('orderToRows — dati di spedizione e costo logistico', () => {
  // Una configurazione minima: una zona lineare, una scatola, un reso forfait.
  const config: LogisticsConfig = {
    zones: [
      { zoneName: 'Italia', countries: ['IT'], restOfWorld: false, rateType: 'linear', rates: [{ weightFromKg: null, weightToKg: null, cost: 2 }], options: [] },
    ],
    categories: [{ name: 'Scatola', cost: 1.5 }],
    fallbackRules: [{ weightMaxKg: null, category: 'Scatola' }],
    defaultWeightPerItemKg: null,
    returnCost: 4,
  };

  const spedito = (over: Partial<ShopifyOrder> = {}) =>
    order({
      fulfillment_status: 'FULFILLED',
      shipping_country_code: 'IT',
      total_weight_grams: 1500,
      returned_at: null,
      packaging_category: null,
      ...over,
    });

  it('porta sull ordine i campi che servono al costo', () => {
    const rows = orderToRows(spedito({ packaging_category: 'Scatola' }), SYNCED)!;
    expect(rows.order).toMatchObject({
      fulfillment_status: 'FULFILLED',
      shipping_country_code: 'IT',
      total_weight_grams: 1500,
      returned_at: null,
      packaging_category: 'Scatola',
    });
  });

  it('gli articoli sono quelli rimasti al cliente, riga per riga', () => {
    const rows = orderToRows(
      spedito({ lines: [line({ id: 1, current_quantity: 2 }), line({ id: 2, quantity: 3, current_quantity: 1 })] }),
      SYNCED,
    )!;
    expect(rows.order.item_count).toBe(3);
  });

  it('con la configurazione il costo si calcola e si scrive', () => {
    // 1,5 kg x 2 €/kg + 1,5 € di scatola.
    const rows = orderToRows(spedito(), SYNCED, config)!;
    expect(rows.order.logistics_cost).toBe(4.5);
  });

  it('un reso aggiunge il rientro senza togliere l andata', () => {
    const rows = orderToRows(spedito({ returned_at: '2026-08-10T00:00:00Z' }), SYNCED, config)!;
    expect(rows.order.logistics_cost).toBe(8.5);
  });

  it('senza configurazione il costo e zero, non assente', () => {
    expect(orderToRows(spedito(), SYNCED, null)!.order.logistics_cost).toBe(0);
    expect(orderToRows(spedito(), SYNCED)!.order.logistics_cost).toBe(0);
  });

  it('un costo oltre il tetto della colonna diventa zero invece di far fallire la scrittura', () => {
    // 1,5 kg a un miliardo al kg esce da NUMERIC(10,2): scritto cosi',
    // Postgres rifiuterebbe l'intero upsert dell'ordine, non solo il costo.
    const assurda: LogisticsConfig = {
      ...config,
      zones: [{ ...config.zones[0], rates: [{ weightFromKg: null, weightToKg: null, cost: 1e9 }] }],
    };
    expect(orderToRows(spedito(), SYNCED, assurda)!.order.logistics_cost).toBe(0);
  });

  it('un ordine letto prima di questi campi non si rompe', () => {
    const rows = orderToRows(order(), SYNCED, config)!;
    expect(rows.order.fulfillment_status).toBeNull();
    expect(rows.order.logistics_cost).toBe(0);
  });
});

describe('orderToRows — opzione di spedizione scelta dal cliente', () => {
  // Una zona con la tariffa generica (2 €/kg) e due opzioni: Express a costo
  // fisso, Standard a fasce di valore dell'ordine.
  const config: LogisticsConfig = {
    zones: [
      {
        zoneName: 'Italia',
        countries: ['IT'],
        restOfWorld: false,
        rateType: 'linear',
        rates: [{ weightFromKg: null, weightToKg: null, cost: 2 }],
        options: [
          { name: 'Express', costType: 'flat', confirmed: true, brackets: [{ from: null, to: null, cost: 9 }] },
          {
            name: 'Standard',
            costType: 'value_brackets', confirmed: true,
            brackets: [
              { from: null, to: 50, cost: 6 },
              { from: 50, to: null, cost: 3 },
            ],
          },
        ],
      },
    ],
    categories: [],
    fallbackRules: [],
    defaultWeightPerItemKg: null,
    returnCost: null,
  };

  const spedito = (over: Partial<ShopifyOrder> = {}) =>
    order({ fulfillment_status: 'FULFILLED', shipping_country_code: 'IT', total_weight_grams: 1000, ...over });

  it('scrive sull ordine l opzione scelta', () => {
    expect(orderToRows(spedito({ shipping_method: 'Express' }), SYNCED)!.order.shipping_method).toBe('Express');
  });

  it('senza opzione dichiarata la colonna resta NULL', () => {
    expect(orderToRows(spedito(), SYNCED)!.order.shipping_method).toBeNull();
  });

  it('il costo si prende dall opzione scelta, non dalla tariffa generica', () => {
    // 9 € fissi invece di 1 kg x 2 €/kg.
    expect(orderToRows(spedito({ shipping_method: 'Express' }), SYNCED, config)!.order.logistics_cost).toBe(9);
  });

  it('le fasce di valore leggono il totale dell ordine', () => {
    expect(
      orderToRows(spedito({ shipping_method: 'Standard', total_price: '39.90' }), SYNCED, config)!.order.logistics_cost,
    ).toBe(6);
    expect(
      orderToRows(spedito({ shipping_method: 'Standard', total_price: '80.00' }), SYNCED, config)!.order.logistics_cost,
    ).toBe(3);
  });
});

describe('orderToRows — pacchi spediti', () => {
  const config: LogisticsConfig = {
    zones: [
      {
        zoneName: 'Italia',
        countries: ['IT'],
        restOfWorld: false,
        rateType: 'per_package',
        rates: [{ weightFromKg: null, weightToKg: null, cost: 5 }],
        options: [
          { name: 'Corriere', costType: 'per_package', confirmed: true, brackets: [{ from: null, to: null, cost: 4.9 }] },
        ],
      },
    ],
    categories: [],
    fallbackRules: [],
    defaultWeightPerItemKg: null,
    returnCost: null,
  };

  const spedito = (over: Partial<ShopifyOrder> = {}) =>
    order({ fulfillment_status: 'FULFILLED', shipping_country_code: 'IT', total_weight_grams: 1000, ...over });

  it('scrive sull ordine il numero di pacchi', () => {
    expect(orderToRows(spedito({ package_count: 2 }), SYNCED)!.order.package_count).toBe(2);
  });

  it('senza conteggio la colonna resta NULL', () => {
    expect(orderToRows(spedito(), SYNCED)!.order.package_count).toBeNull();
  });

  it('il costo per pacco moltiplica per i pacchi spediti', () => {
    expect(orderToRows(spedito({ shipping_method: 'Corriere', package_count: 2 }), SYNCED, config)!.order.logistics_cost).toBe(9.8);
    // Tariffa generica della zona, anch'essa per pacco.
    expect(orderToRows(spedito({ package_count: 3 }), SYNCED, config)!.order.logistics_cost).toBe(15);
  });

  it('spedito ma zero pacchi registrati: si paga un pacco', () => {
    expect(orderToRows(spedito({ shipping_method: 'Corriere', package_count: 0 }), SYNCED, config)!.order.logistics_cost).toBe(4.9);
  });
});
