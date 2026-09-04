import { describe, it, expect } from 'vitest';
import {
  customerMetrics,
  isMonthClosed,
  linesProfit,
  monthKey,
  ordersByMonth,
  variation,
  type Order,
} from './profit';

/**
 * Una riga come la scrive la sincronizzazione: il netto gia' fatto da Shopify e
 * le unita' rimaste al cliente. Il prezzo unitario non compare nemmeno — non e'
 * un ingrediente del margine, e passarglielo inviterebbe a rimoltiplicarlo.
 */
const line = (lineNetTotal: number | null, unitCost: number | null, currentQuantity = 1) => ({
  lineNetTotal,
  unitCost,
  currentQuantity,
});

const order = (day: string, ...lines: ReturnType<typeof line>[]): Order => ({
  placedAt: new Date(`${day}T12:00:00Z`),
  lines,
});

describe('linesProfit', () => {
  it('netto della riga meno costo per le unita rimaste', () => {
    expect(linesProfit([line(30, 10), line(40, 5, 2)])).toEqual({
      profit: 50,
      coveredLines: 2,
      totalLines: 2,
    });
  });

  it('le righe senza costo restano fuori, non valgono profitto pieno', () => {
    // Un prodotto senza costo compilato non ha profitto pari al prezzo: ha
    // profitto ignoto. Contarlo intero gonfierebbe il numero proprio quando il
    // merchant ha appena installato l'app.
    expect(linesProfit([line(30, 10), line(100, null)])).toEqual({
      profit: 20,
      coveredLines: 1,
      totalLines: 2,
    });
  });

  it('una riga senza netto non e profitto zero: e profitto ignoto', () => {
    // Sono le righe scritte prima che la colonna esistesse, in attesa di essere
    // rilette da Shopify. Contarle come zero abbasserebbe il totale di quanto
    // non si sa, che e' peggio che dichiararlo.
    expect(linesProfit([line(30, 10), line(null, 7)])).toEqual({
      profit: 20,
      coveredLines: 1,
      totalLines: 2,
    });
  });

  it('una riga interamente rimborsata non porta ne profitto ne perdita', () => {
    // Zero unita' rimaste al cliente vuol dire zero incassato e zero costo
    // sostenuto: il contributo e' zero, non il margine del giorno dell'acquisto.
    expect(linesProfit([line(0, 10, 0)])).toEqual({
      profit: 0,
      coveredLines: 1,
      totalLines: 1,
    });
  });

  it('un rimborso di meta quantita dimezza il costo, non solo l incasso', () => {
    // Due pezzi a 20 l'uno, costo 5: 40 - 10 = 30. Rimborsato uno: il netto
    // scende a 20 e il costo a 5, cioe' 15. Col vecchio conto — quantita'
    // ordinata — sarebbe rimasto 30 di margine su merce tornata indietro.
    expect(linesProfit([line(40, 5, 2)]).profit).toBe(30);
    expect(linesProfit([line(20, 5, 1)]).profit).toBe(15);
  });

  it('un costo maggiore del netto fa profitto negativo, e si vede', () => {
    expect(linesProfit([line(10, 15)]).profit).toBe(-5);
  });

  it('niente code in virgola mobile', () => {
    expect(linesProfit([line(59.97, 4.13, 3)]).profit).toBe(47.58);
  });
});

describe('customerMetrics', () => {
  it('conta gli ordini e fa la media per ordine', () => {
    const metrics = customerMetrics([
      order('2026-08-01', line(30, 10)),
      order('2026-08-15', line(50, 20), line(10, 5)),
    ]);

    expect(metrics.orders).toBe(2);
    expect(metrics.profit).toBe(55);
    expect(metrics.averageOrderProfit).toBe(27.5);
  });

  it('senza ordini la media non esiste, e non e zero', () => {
    expect(customerMetrics([]).averageOrderProfit).toBeNull();
  });

  it('dice quante righe mancano di costo: il totale e parziale e va saputo', () => {
    const metrics = customerMetrics([order('2026-08-01', line(30, 10), line(40, null))]);

    expect(metrics.coveredLines).toBe(1);
    expect(metrics.totalLines).toBe(2);
  });
});

describe('ordersByMonth', () => {
  it('divide per mese di calendario, in ordine', () => {
    const months = ordersByMonth([
      order('2026-08-15', line(10, 5)),
      order('2026-07-31', line(10, 5)),
      order('2026-08-01', line(10, 5)),
    ]);

    expect([...months.keys()]).toEqual(['2026-07', '2026-08']);
    expect(months.get('2026-08')).toHaveLength(2);
  });

  it('mesi veri, non finestre di trenta giorni', () => {
    // Il 31 luglio e il 1 agosto distano un giorno e stanno in due mesi
    // diversi: e' cosi' che il merchant ragiona.
    const months = ordersByMonth([order('2026-07-31'), order('2026-08-01')]);
    expect([...months.keys()]).toEqual(['2026-07', '2026-08']);
  });
});

describe('variation', () => {
  it('dice di quanto e cambiato, a un decimale', () => {
    expect(variation(150, 100)).toBe(50);
    expect(variation(80, 100)).toBe(-20);
    expect(variation(133, 100)).toBe(33);
  });

  it('senza un prima non c e confronto', () => {
    expect(variation(100, null)).toBeNull();
    expect(variation(100, undefined)).toBeNull();
  });

  it('da zero non si calcola una percentuale', () => {
    // Qualunque aumento da zero sarebbe "infinito per cento": la tabella mostra
    // il numero e basta, senza colore.
    expect(variation(100, 0)).toBeNull();
  });

  it('un calo da un valore negativo resta un calo', () => {
    expect(variation(-150, -100)).toBe(-50);
  });
});

describe('isMonthClosed', () => {
  const now = new Date('2026-08-20T10:00:00Z');

  it('il mese in corso non si confronta', () => {
    expect(isMonthClosed('2026-08', now)).toBe(false);
  });

  it('quelli finiti si', () => {
    expect(isMonthClosed('2026-07', now)).toBe(true);
    expect(isMonthClosed('2025-12', now)).toBe(true);
  });

  it('il mese di una data e la sua chiave ordinabile', () => {
    expect(monthKey(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01');
  });
});
