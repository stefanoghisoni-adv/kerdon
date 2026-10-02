import { describe, it, expect } from 'vitest';
import { PER_PAGE, pageCount, pageSlice, visibleRange } from './pagination';

describe('righe per pagina', () => {
  it('e\' venticinque, lo stesso numero per tutte le tabelle', () => {
    expect(PER_PAGE).toBe(25);
  });
});

describe('pageCount', () => {
  it('nessuna riga → nessuna pagina', () => expect(pageCount(0, 25)).toBe(0));
  it('esattamente una pagina', () => expect(pageCount(25, 25)).toBe(1));
  it('una riga in piu → due pagine', () => expect(pageCount(26, 25)).toBe(2));
  it('un numero di righe negativo non inventa pagine', () =>
    expect(pageCount(-3, 25)).toBe(0));
});

describe('pageSlice', () => {
  const rows = Array.from({ length: 73 }, (_, i) => i);
  it('prima pagina', () => expect(pageSlice(rows, 1, 25)).toHaveLength(25));
  it('ultima pagina parziale', () => expect(pageSlice(rows, 3, 25)).toEqual(rows.slice(50)));
  it('pagina oltre la fine → vuota', () => expect(pageSlice(rows, 9, 25)).toEqual([]));
});

describe('intervallo visibile', () => {
  it('la prima pagina piena', () => {
    expect(visibleRange(73, 1, 25)).toEqual({ from: 1, to: 25 });
  });

  it('l\'ultima pagina si ferma sulle righe che ci sono', () => {
    expect(visibleRange(73, 3, 25)).toEqual({ from: 51, to: 73 });
  });

  it('con meno righe di una pagina si conta quello che si vede', () => {
    // E' il caso della ricerca: dodici risultati, e l'etichetta lo dice.
    expect(visibleRange(12, 1, 25)).toEqual({ from: 1, to: 12 });
  });

  it('una riga sola', () => {
    expect(visibleRange(1, 1, 25)).toEqual({ from: 1, to: 1 });
  });

  it('tabella vuota: non c\'e\' nessun intervallo da scrivere', () => {
    expect(visibleRange(0, 1, 25)).toBeNull();
  });

  it('una pagina rimasta oltre la fine viene riportata sull\'ultima', () => {
    // Succede fra il render in cui le righe spariscono e quello in cui la
    // pagina si arretra: senza il rientro l'etichetta direbbe "201-200".
    expect(visibleRange(73, 5, 25)).toEqual({ from: 51, to: 73 });
  });

  it('una pagina sotto la prima vale la prima', () => {
    expect(visibleRange(73, 0, 25)).toEqual({ from: 1, to: 25 });
  });
});
