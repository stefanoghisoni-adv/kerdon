import { describe, it, expect } from 'vitest';
import { isMetric, topProductsSQL, METRICS } from './top-products';

const range = { from: '2026-08-01', to: '2026-08-25', timeZone: 'Europe/Rome' } as const;

describe('isMetric', () => {
  it('accetta le quattro domande e rifiuta il resto', () => {
    for (const metric of METRICS) expect(isMetric(metric)).toBe(true);
    expect(isMetric('drop table')).toBe(false);
    expect(isMetric('')).toBe(false);
  });
});

describe('topProductsSQL', () => {
  it('le date entrano solo se sono date', () => {
    expect(() => topProductsSQL({ ...range, from: "2026-08-01'; DROP TABLE orders;--", metric: 'cm' }))
      .toThrow(/Data non valida/);
    expect(() => topProductsSQL({ ...range, to: 'ieri', metric: 'cm' })).toThrow(/Data non valida/);
  });

  it('ordina sulla metrica chiesta', () => {
    expect(topProductsSQL({ ...range, metric: 'ltp' })).toContain('ORDER BY ltp DESC');
    expect(topProductsSQL({ ...range, metric: 'acp' })).toContain('ORDER BY acp DESC');
  });

  it('gli ordini annullati restano fuori', () => {
    expect(topProductsSQL({ ...range, metric: 'cm' })).toContain('o.cancelled_at IS NULL');
  });

  it('le righe senza costo non entrano: profitto ignoto non e profitto zero', () => {
    const sql = topProductsSQL({ ...range, metric: 'cm' });
    expect(sql).toContain(
      'CASE WHEN COALESCE(l.unit_cost_at_sale, p.cost_per_item) IS NOT NULL',
    );
    expect(sql).toContain('profit IS NOT NULL');
  });

  it('un prodotto due volte nello stesso ordine conta un ordine solo', () => {
    // E' il senso del raggruppamento per (variante, ordine) prima di contare.
    expect(topProductsSQL({ ...range, metric: 'aop' })).toContain('GROUP BY variant_id, order_id');
  });

  it('il limite non si fa dettare da fuori', () => {
    expect(topProductsSQL({ ...range, metric: 'cm', limit: 9999 })).toContain('LIMIT 50');
    expect(topProductsSQL({ ...range, metric: 'cm', limit: 0 })).toContain('LIMIT 1');
    expect(topProductsSQL({ ...range, metric: 'cm' })).toContain('LIMIT 5');
  });
});
