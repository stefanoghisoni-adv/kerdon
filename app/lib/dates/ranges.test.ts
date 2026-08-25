import { describe, it, expect } from 'vitest';
import {
  comparisonRange,
  formatRange,
  lengthInDays,
  matchPreset,
  orderRange,
  presetRange,
} from './ranges';

// Un martedi', a meta' mese e a meta' trimestre: cosi' i confini si vedono.
const NOW = new Date('2026-08-25T14:00:00Z');

describe('presetRange', () => {
  it('oggi e ieri sono un giorno solo', () => {
    expect(presetRange('today', NOW)).toEqual({ from: '2026-08-25', to: '2026-08-25' });
    expect(presetRange('yesterday', NOW)).toEqual({ from: '2026-08-24', to: '2026-08-24' });
  });

  it('gli ultimi N giorni comprendono oggi', () => {
    // Escluderlo farebbe sparire gli ordini appena arrivati, che sono quelli
    // per cui si guarda.
    expect(presetRange('last7', NOW)).toEqual({ from: '2026-08-19', to: '2026-08-25' });
    expect(lengthInDays(presetRange('last7', NOW)!)).toBe(7);
    expect(lengthInDays(presetRange('last30', NOW)!)).toBe(30);
    expect(lengthInDays(presetRange('last90', NOW)!)).toBe(90);
  });

  it('dall inizio del mese, del trimestre e dell anno', () => {
    expect(presetRange('monthToDate', NOW)).toEqual({ from: '2026-08-01', to: '2026-08-25' });
    // Agosto sta nel trimestre che parte a luglio.
    expect(presetRange('quarterToDate', NOW)).toEqual({ from: '2026-07-01', to: '2026-08-25' });
    expect(presetRange('yearToDate', NOW)).toEqual({ from: '2026-01-01', to: '2026-08-25' });
  });

  it('i periodi chiusi finiscono davvero dove finiscono', () => {
    expect(presetRange('lastMonth', NOW)).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    expect(presetRange('lastQuarter', NOW)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(presetRange('lastYear', NOW)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('a gennaio il mese precedente e dicembre dell anno prima', () => {
    const january = new Date('2026-01-10T00:00:00Z');
    expect(presetRange('lastMonth', january)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('febbraio bisestile non perde un giorno', () => {
    const march = new Date('2024-03-05T00:00:00Z');
    expect(presetRange('lastMonth', march)).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });
});

describe('matchPreset', () => {
  it('riconosce il periodo scelto, per riaprire sulla voce giusta', () => {
    expect(matchPreset({ from: '2026-08-01', to: '2026-08-25' }, NOW)).toBe('monthToDate');
    expect(matchPreset({ from: '2026-08-25', to: '2026-08-25' }, NOW)).toBe('today');
  });

  it('due date qualsiasi restano un intervallo personalizzato', () => {
    expect(matchPreset({ from: '2026-03-03', to: '2026-04-04' }, NOW)).toBe('custom');
  });
});

describe('comparisonRange', () => {
  const range = { from: '2026-08-01', to: '2026-08-25' };

  it('nessun confronto: niente', () => {
    expect(comparisonRange(range, 'none', NOW)).toBeNull();
  });

  it('il periodo precedente e lungo uguale e finisce il giorno prima', () => {
    const before = comparisonRange(range, 'previousPeriod', NOW)!;
    expect(before.to).toBe('2026-07-31');
    expect(lengthInDays(before)).toBe(lengthInDays(range));
  });

  it('l anno precedente tiene le stesse date', () => {
    expect(comparisonRange(range, 'previousYear', NOW)).toEqual({
      from: '2025-08-01',
      to: '2025-08-25',
    });
  });

  it('la corrispondenza per giorno della settimana sposta di 52 settimane', () => {
    const before = comparisonRange(range, 'previousYearWeekday', NOW)!;
    const day = (value: string) => new Date(`${value}T00:00:00Z`).getUTCDay();
    // E' l'unico confronto che non mette un sabato contro un mercoledi'.
    expect(day(before.from)).toBe(day(range.from));
    expect(day(before.to)).toBe(day(range.to));
    expect(lengthInDays(before)).toBe(lengthInDays(range));
  });
});

describe('formatRange', () => {
  it('un giorno solo si scrive una volta', () => {
    expect(formatRange({ from: '2026-08-25', to: '2026-08-25' }, 'it')).not.toContain('–');
  });

  it('due date si scrivono con il trattino in mezzo', () => {
    expect(formatRange({ from: '2026-08-01', to: '2026-08-25' }, 'it')).toContain('–');
  });
});

describe('orderRange', () => {
  it('le due date escono in ordine comunque arrivino', () => {
    expect(orderRange('2026-08-25', '2026-08-01')).toEqual({
      from: '2026-08-01',
      to: '2026-08-25',
    });
  });
});
