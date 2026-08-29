import { describe, it, expect } from 'vitest';
import { leafLabel, monthsEndingAt } from './DateRangePicker';
import { HEAD_LEAVES, presetGroups, type PresetLeaf } from '~/lib/dates/ranges';
import { it as italiano } from '~/lib/i18n/it';
import { en as english } from '~/lib/i18n/en';

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

describe('leafLabel', () => {
  const NOW = new Date('2026-08-25T14:00:00Z');
  const offered: PresetLeaf[] = [
    ...HEAD_LEAVES,
    ...presetGroups(NOW).flatMap((group) => group.leaves),
  ];

  it('un periodo con un nome lo prende dal dizionario', () => {
    expect(leafLabel({ kind: 'preset', preset: 'last30' }, italiano)).toBe('Ultimi 30 giorni');
    expect(leafLabel({ kind: 'preset', preset: 'last30' }, english)).toBe('Last 30 days');
  });

  // Trimestri e Black Friday nel dizionario non ci sono e non ci possono
  // stare: sono una famiglia senza fine, e l'anno va composto ogni volta.
  it('un trimestre e un Black Friday si scrivono con il loro anno', () => {
    expect(leafLabel({ kind: 'quarter', year: 2026, quarter: 2 }, italiano)).toBe('T2 2026');
    expect(leafLabel({ kind: 'quarter', year: 2026, quarter: 2 }, english)).toBe('Q2 2026');
    expect(leafLabel({ kind: 'bfcm', year: 2025 }, italiano)).toBe('BFCM 2025');
  });

  // Una voce senza nome sarebbe una riga vuota da premere: si scopre solo
  // aprendo la tendina, e in una lingua sola.
  it('nessuna voce offerta resta senza nome, in nessuna delle due lingue', () => {
    for (const dictionary of [italiano, english]) {
      for (const leaf of offered) {
        expect(leafLabel(leaf, dictionary).trim()).not.toBe('');
      }
    }
  });

  it('nemmeno i capofila restano senza nome', () => {
    for (const dictionary of [italiano, english]) {
      for (const group of presetGroups(NOW)) {
        expect(dictionary.dates.groups[group.id].trim()).not.toBe('');
      }
    }
  });
});
