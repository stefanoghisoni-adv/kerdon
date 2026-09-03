import { describe, it, expect } from 'vitest';
import { PER_PAGE, pageCount, pageSlice, visibleRange } from './pagination';

describe('righe per pagina', () => {
  it("e' cinquanta, lo stesso numero per tutte le tabelle", () => {
    expect(PER_PAGE).toBe(50);
  });
});

describe('pageCount', () => {
  it('nessuna riga → nessuna pagina', () => expect(pageCount(0, 50)).toBe(0));
  it('esattamente una pagina', () => expect(pageCount(50, 50)).toBe(1));
  it('una riga in piu → due pagine', () => expect(pageCount(51, 50)).toBe(2));
  it('un numero di righe negativo non inventa pagine', () =>
    expect(pageCount(-3, 50)).toBe(0));
});

describe('pageSlice', () => {
  const rows = Array.from({ length: 73 }, (_, i) => i);
  it('prima pagina', () => expect(pageSlice(rows, 1, 50)).toHaveLength(50));
  it('ultima pagina parziale', () => expect(pageSlice(rows, 2, 50)).toEqual(rows.slice(50)));
  it('pagina oltre la fine → vuota', () => expect(pageSlice(rows, 9, 50)).toEqual([]));
});

describe('intervallo visibile', () => {
  it('la prima pagina piena', () => {
    expect(visibleRange(73, 1, 50)).toEqual({ from: 1, to: 50 });
  });

  it("l'ultima pagina si ferma sulle righe che ci sono", () => {
    expect(visibleRange(73, 2, 50)).toEqual({ from: 51, to: 73 });
  });

  it('con meno righe di una pagina si conta quello che si vede', () => {
    // E' il caso della ricerca: dodici risultati, e l'etichetta lo dice.
    expect(visibleRange(12, 1, 50)).toEqual({ from: 1, to: 12 });
  });

  it('una riga sola', () => {
    expect(visibleRange(1, 1, 50)).toEqual({ from: 1, to: 1 });
  });

  it('tabella vuota: non c’e’ nessun intervallo da scrivere', () => {
    expect(visibleRange(0, 1, 50)).toBeNull();
  });

  it('una pagina rimasta oltre la fine viene riportata sull’ultima', () => {
    // Succede fra il render in cui le righe spariscono e quello in cui la
    // pagina si arretra: senza il rientro l'etichetta direbbe "201-200".
    expect(visibleRange(73, 5, 50)).toEqual({ from: 51, to: 73 });
  });

  it('una pagina sotto la prima vale la prima', () => {
    expect(visibleRange(73, 0, 50)).toEqual({ from: 1, to: 50 });
  });
});
