import { describe, it, expect } from 'vitest';
import {
  COVERED_LINES,
  LINE_NET_CONTRIBUTION,
  LINE_NET_CONTRIBUTION_OR_NULL,
  NET_CONTRIBUTION_SUM,
  NET_REVENUE_SUM,
  ORDER_COUNTS_AS_SALE,
  ORDER_CURRENCY_CONSISTENT,
  ORDER_LOGISTICS_SUM,
  netContribution,
} from './net-contribution';
import { averagesSQL, customersInRangeSQL, lifetimeProfitSQL, shopProfitSQL } from './customers-query';
import { METRICS, topProductsSQL } from './top-products';

const RANGE = { from: '2026-08-01', to: '2026-08-31', timeZone: 'Europe/Rome' };

describe('la formula', () => {
  it('e netto della riga meno costo per le unita rimaste', () => {
    expect(LINE_NET_CONTRIBUTION).toBe(
      '(l.line_net_total - COALESCE(l.unit_cost_at_sale, p.cost_per_item) * l.current_quantity)',
    );
  });

  it('non moltiplica mai un prezzo unitario per una quantita', () => {
    // Sono i due valori che un rimborso rende falsi insieme: la quantita'
    // ordinata non cambia mai piu', e nel prezzo unitario ci sono allocazioni
    // di sconto riferite anche a unita' rimborsate.
    for (const sql of [LINE_NET_CONTRIBUTION, NET_CONTRIBUTION_SUM, NET_REVENUE_SUM]) {
      expect(sql).not.toContain('unit_price');
      expect(sql).not.toMatch(/\bl\.quantity\b/);
    }
  });

  it('costo mancante e netto mancante tengono la riga fuori dalla somma', () => {
    // Non e' profitto zero, e' profitto ignoto: metterlo a zero abbasserebbe un
    // totale che nessuno ha misurato.
    expect(NET_CONTRIBUTION_SUM).toContain(
      'COALESCE(l.unit_cost_at_sale, p.cost_per_item) IS NOT NULL',
    );
    expect(NET_CONTRIBUTION_SUM).toContain('l.line_net_total IS NOT NULL');
    expect(COVERED_LINES).toContain('l.line_net_total IS NOT NULL');
  });

  it('il ricavo netto usa lo stesso importo del margine', () => {
    // Ricavo e margine devono parlare della stessa cifra: se il primo fosse
    // prezzo x quantita' e il secondo il netto, l'AOV potrebbe superare il
    // totale dell'ordine da cui viene.
    expect(NET_REVENUE_SUM).toContain('l.line_net_total');
  });

  it('fuori dall SQL vale la stessa cosa, nello stesso ordine', () => {
    expect(netContribution({ lineNetTotal: 40, unitCost: 5, currentQuantity: 2 })).toBe(30);
    expect(netContribution({ lineNetTotal: 0, unitCost: 5, currentQuantity: 0 })).toBe(0);
    expect(netContribution({ lineNetTotal: null, unitCost: 5, currentQuantity: 2 })).toBeNull();
    expect(netContribution({ lineNetTotal: 40, unitCost: null, currentQuantity: 2 })).toBeNull();
  });
});

/**
 * La ragione per cui questo modulo esiste: la stessa domanda, in cinque
 * schermate, deve dare la stessa risposta. Finora la moltiplicazione era
 * copiata in ognuna, e ogni copia era libera di restare indietro.
 */
describe('una formula sola, per tutte le schermate', () => {
  const query: Record<string, string> = {
    'tab Clienti': customersInRangeSQL(RANGE),
    'profitto di sempre': lifetimeProfitSQL(),
    'card del profitto': shopProfitSQL(RANGE),
    'medie del negozio': averagesSQL(RANGE),
  };

  for (const [nome, sql] of Object.entries(query)) {
    it(`${nome}: usa la formula condivisa`, () => {
      expect(sql).toContain(NET_CONTRIBUTION_SUM);
    });

    it(`${nome}: non ha piu una copia del vecchio conto`, () => {
      expect(sql).not.toContain('l.unit_price - p.cost_per_item');
      expect(sql).not.toMatch(/\*\s*l\.quantity/);
    });
  }

  it('top prodotti: usa la stessa formula, riga per riga', () => {
    // Qui l'aggregazione avviene in due passaggi, quindi serve il contributo
    // della singola riga invece della somma — ma e' la stessa espressione.
    const sql = topProductsSQL({ ...RANGE, metric: 'cm' });
    expect(sql).toContain(LINE_NET_CONTRIBUTION_OR_NULL);
    expect(sql).not.toContain('l.unit_price - p.cost_per_item');
  });
});

describe('mai sommare valute diverse', () => {
  it('un ordine con dentro due valute resta fuori dal conto', () => {
    // Sommare importi di valute diverse produce un numero che non esiste in
    // nessuna moneta, e lo produce in silenzio. Si esclude l'ordine intero e non
    // la singola riga: di un ordine cosi' non si sa dire il totale, e tenerne
    // meta' sarebbe peggio che lasciarlo fuori.
    expect(ORDER_CURRENCY_CONSISTENT).toContain('NOT EXISTS');
    expect(ORDER_CURRENCY_CONSISTENT).toContain('xl.line_currency <> o.currency');
  });

  it('una riga che la valuta non la dichiara non esclude niente', () => {
    // Sono le righe scritte prima che la colonna esistesse: assenza non e'
    // discordanza, e trattarla come tale svuoterebbe tutto lo storico.
    expect(ORDER_CURRENCY_CONSISTENT).toContain('xl.line_currency IS NOT NULL');
    expect(ORDER_CURRENCY_CONSISTENT).toContain('o.currency IS NOT NULL');
  });

  it('la condizione viaggia insieme a quella sugli annullati', () => {
    // Insieme perche' non si dimentichi la seconda scrivendo la prima, che e'
    // esattamente com era andata finora.
    expect(ORDER_COUNTS_AS_SALE).toContain('o.cancelled_at IS NULL');
    expect(ORDER_COUNTS_AS_SALE).toContain('NOT EXISTS');
  });

  it('ogni query che somma denaro se la porta dietro', () => {
    for (const sql of [
      customersInRangeSQL(RANGE),
      lifetimeProfitSQL(),
      shopProfitSQL(RANGE),
      averagesSQL(RANGE),
      averagesSQL(),
      topProductsSQL({ ...RANGE, metric: 'cm' }),
    ]) {
      expect(sql).toContain(ORDER_CURRENCY_CONSISTENT);
    }
  });
});

// Il costo fissato al momento in cui il merchant lo cambia: da li' in poi quella
// riga non segue piu' il listino. E' la meta' che rende vera la scelta "solo da
// adesso in avanti" — senza, la scelta si registrerebbe e non si vedrebbe.
describe('il costo fissato vince su quello corrente', () => {
  it('una riga con il costo fissato non segue piu il listino', () => {
    expect(
      netContribution({ lineNetTotal: 100, unitCost: 40, unitCostAtSale: 25, currentQuantity: 2 }),
    ).toBe(50);
  });

  it('senza valore fissato vale il corrente, che e la normalita', () => {
    expect(
      netContribution({ lineNetTotal: 100, unitCost: 40, unitCostAtSale: null, currentQuantity: 2 }),
    ).toBe(20);
    expect(netContribution({ lineNetTotal: 100, unitCost: 40, currentQuantity: 2 })).toBe(20);
  });

  it('lo zero fissato e un costo, non un valore assente', () => {
    expect(
      netContribution({ lineNetTotal: 100, unitCost: 40, unitCostAtSale: 0, currentQuantity: 2 }),
    ).toBe(100);
  });

  it('senza nessuno dei due il profitto resta ignoto, non zero', () => {
    expect(
      netContribution({ lineNetTotal: 100, unitCost: null, unitCostAtSale: null, currentQuantity: 2 }),
    ).toBeNull();
  });
});

describe('il costo logistico dell ordine', () => {
  it('conta ogni ordine una volta sola: solo sulla sua prima riga', () => {
    expect(ORDER_LOGISTICS_SUM).toContain('FILTER (WHERE l.shopify_line_id = (');
    expect(ORDER_LOGISTICS_SUM).toContain('MIN(fl.shopify_line_id)');
    expect(ORDER_LOGISTICS_SUM).toContain('fl.shopify_order_id = o.shopify_order_id');
  });

  it('un costo mancante vale zero, e una somma vuota pure', () => {
    expect(ORDER_LOGISTICS_SUM).toContain('COALESCE(o.logistics_cost, 0)');
    expect(ORDER_LOGISTICS_SUM.startsWith('COALESCE(SUM(')).toBe(true);
    expect(ORDER_LOGISTICS_SUM.endsWith(', 0)')).toBe(true);
  });

  it('ogni profitto della tab Clienti lo sottrae, e solo dove gli ordini sono vendite', () => {
    const queries = [
      customersInRangeSQL(RANGE),
      lifetimeProfitSQL(),
      shopProfitSQL(RANGE),
      averagesSQL(RANGE),
      averagesSQL(),
    ];
    for (const sql of queries) {
      expect(sql).toContain(`(${NET_CONTRIBUTION_SUM} - ${ORDER_LOGISTICS_SUM}) AS profit`);
      // Il frammento non filtra da se' gli annullati: si affida al WHERE.
      expect(sql).toContain(`WHERE ${ORDER_COUNTS_AS_SALE}`);
    }
  });

  it('il profitto per prodotto resta senza costo logistico', () => {
    // E' un costo dell'ordine, non del prodotto (spec rev. 1.1 punto 2).
    for (const metric of METRICS) {
      expect(topProductsSQL({ ...RANGE, metric })).not.toContain('logistics_cost');
    }
  });
});
