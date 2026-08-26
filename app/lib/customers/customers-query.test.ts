import { describe, it, expect } from 'vitest';
import {
  averagesSQL,
  customersInRangeSQL,
  isCalendarDate,
  lifetimeProfitSQL,
  previousRange,
  shopProfitSQL,
  currentMonthRange,
} from './customers-query';

describe('isCalendarDate', () => {
  it('accetta una data di calendario', () => {
    expect(isCalendarDate('2026-08-01')).toBe(true);
  });

  it('rifiuta quello che data non e', () => {
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-02-30')).toBe(false);
    expect(isCalendarDate('ieri')).toBe(false);
    expect(isCalendarDate("2026-08-01'; DROP TABLE orders; --")).toBe(false);
  });
});

describe('customersInRangeSQL', () => {
  it('una data che non e una data non entra nella query', () => {
    // La query si compone come testo: l'unica difesa e' rifiutare prima, non
    // ripulire dopo.
    expect(() => customersInRangeSQL({ from: "'; DROP TABLE orders; --", to: '2026-08-31' })).toThrow();
    expect(() => customersInRangeSQL({ from: '2026-08-01', to: 'oggi' })).toThrow();
  });

  it('il costo si prende dai prodotti, non dalle righe', () => {
    const sql = customersInRangeSQL({ from: '2026-08-01', to: '2026-08-31' });
    expect(sql).toContain('LEFT JOIN products p ON p.shopify_variant_id = l.shopify_variant_id');
    expect(sql).toContain('p.cost_per_item');
  });

  it('gli ordini annullati non sono profitto', () => {
    expect(customersInRangeSQL({ from: '2026-08-01', to: '2026-08-31' })).toContain(
      'o.cancelled_at IS NULL',
    );
  });

  it('dice anche quante righe hanno un costo: senza, il totale mentirebbe per omissione', () => {
    const sql = customersInRangeSQL({ from: '2026-08-01', to: '2026-08-31' });
    expect(sql).toContain('covered_lines');
    expect(sql).toContain('total_lines');
  });

  it('porta la valuta con cui il negozio vende', () => {
    // Il profitto e' del merchant e va scritto nei soldi che incassa, non in
    // quelli con cui paga noi.
    expect(customersInRangeSQL({ from: '2026-08-01', to: '2026-08-31' })).toContain(
      'MAX(o.currency)',
    );
  });

  it('l ultimo giorno scelto e compreso per intero', () => {
    // Con un semplice <= la query taglierebbe gli ordini fatti dopo mezzanotte
    // dell'ultimo giorno, cioe' quasi tutti quelli di quel giorno.
    expect(customersInRangeSQL({ from: '2026-08-01', to: '2026-08-31' })).toContain(
      "+ INTERVAL '1 day'",
    );
  });

  it('un tetto c e sempre, anche se non lo si chiede', () => {
    expect(customersInRangeSQL({ from: '2026-08-01', to: '2026-08-31' })).toContain('LIMIT 500');
    expect(
      customersInRangeSQL({ from: '2026-08-01', to: '2026-08-31', limit: -5 }),
    ).toContain('LIMIT 500');
  });
});

describe('lifetimeProfitSQL', () => {
  it('non conosce il periodo scelto: e questo che lo rende lifetime', () => {
    const sql = lifetimeProfitSQL();
    expect(sql).not.toContain('placed_at >=');
    expect(sql).toContain('o.cancelled_at IS NULL');
  });
});

describe('previousRange', () => {
  it('prima dura quanto adesso', () => {
    // Sette giorni contro sette: un confronto fra periodi di lunghezza diversa
    // direbbe solo che uno e' piu' lungo dell'altro.
    expect(previousRange('2026-08-08', '2026-08-14')).toEqual({
      from: '2026-08-01',
      to: '2026-08-07',
    });
  });

  it('un mese intero si confronta col mese prima', () => {
    expect(previousRange('2026-08-01', '2026-08-31')).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    });
  });

  it('un giorno solo si confronta col giorno prima', () => {
    expect(previousRange('2026-08-10', '2026-08-10')).toEqual({
      from: '2026-08-09',
      to: '2026-08-09',
    });
  });
});

describe('shopProfitSQL', () => {
  it('somma tutto il negozio, senza raggruppare per cliente', () => {
    const sql = shopProfitSQL({ from: '2026-08-01', to: '2026-08-31' });
    expect(sql).not.toContain('GROUP BY');
    expect(sql).toContain('COUNT(DISTINCT o.shopify_order_id)');
  });

  it('porta con se quanto di quel totale sia vero', () => {
    // Un profitto calcolato su meta' delle righe e' meta' profitto: mostrarlo
    // senza dirlo sarebbe la bugia piu' facile che questa app possa raccontare.
    const sql = shopProfitSQL({ from: '2026-08-01', to: '2026-08-31' });
    expect(sql).toContain('covered_lines');
    expect(sql).toContain('total_lines');
  });

  it('anche qui le date si rifiutano prima, non si ripuliscono dopo', () => {
    expect(() => shopProfitSQL({ from: 'oggi', to: '2026-08-31' })).toThrow();
  });
});

describe('currentMonthRange', () => {
  it('dal primo del mese a oggi', () => {
    expect(currentMonthRange(new Date('2026-08-24T10:00:00Z'))).toEqual({
      from: '2026-08-01',
      to: '2026-08-24',
    });
  });
});

describe('il periodo delle medie non entra nella query senza controllo', () => {
  it('una data valida diventa un letterale fra apici', () => {
    const sql = averagesSQL({ from: '2026-08-01', to: '2026-08-26' });
    expect(sql).toContain("'2026-08-01'");
    expect(sql).toContain("'2026-08-26'");
  });

  it('senza periodo la query non porta nessuna condizione sulle date', () => {
    expect(averagesSQL()).not.toContain('created_at >=');
  });

  it('quello che non e una data non entra affatto', () => {
    // L'API che esegue queste istruzioni non accetta parametri: la query si
    // compone come testo, quindi un valore costruito ad arte scriverebbe SQL
    // dentro la nostra. Si verifica prima, e chi non passa fa fallire la
    // chiamata invece di finire dentro la stringa.
    for (const bad of [
      "2026-08-01' OR '1'='1",
      "2026-08-01'; DROP TABLE orders; --",
      '2026-13-01',
      'ieri',
      '',
    ]) {
      expect(() => averagesSQL({ from: bad, to: '2026-08-26' })).toThrow();
      expect(() => averagesSQL({ from: '2026-08-01', to: bad })).toThrow();
    }
  });
});
