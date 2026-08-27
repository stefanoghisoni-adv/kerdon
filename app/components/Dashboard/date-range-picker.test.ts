import { describe, it, expect } from 'vitest';
import { monthsEndingAt } from './DateRangePicker';

// `today` e' una data locale, come quella con cui ragiona il calendario.
const august26 = new Date(2026, 7, 26);

describe('monthsEndingAt', () => {
  // Il caso da cui e' nata la correzione: il calendario mostrava agosto e
  // settembre, cioe' meta' riquadro nel futuro.
  it('mostra il mese prima e quello della fine del periodo', () => {
    expect(monthsEndingAt('2026-08-10', august26)).toEqual({ month: 6, year: 2026 });
  });

  it('arretrando da gennaio si va a dicembre dell anno prima', () => {
    expect(monthsEndingAt('2026-01-15', new Date(2026, 0, 20))).toEqual({
      month: 11,
      year: 2025,
    });
  });

  it('un periodo tutto nel passato si ancora comunque alla sua fine', () => {
    expect(monthsEndingAt('2026-03-31', august26)).toEqual({ month: 1, year: 2026 });
  });

  // Se il periodo salvato finisse oltre l'oggi, la meta' destra non deve
  // comunque scavallare il mese corrente.
  it('l ancora non supera mai il mese corrente', () => {
    expect(monthsEndingAt('2026-12-31', august26)).toEqual({ month: 6, year: 2026 });
  });
});
