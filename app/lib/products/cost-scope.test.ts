import { describe, it, expect } from 'vitest';
import { costScopeEffect, costToFreeze, isCostScope } from './cost-scope';

describe('la scelta su fin dove arriva un costo', () => {
  it('riconosce le due strade e rifiuta tutto il resto', () => {
    expect(isCostScope('future')).toBe(true);
    expect(isCostScope('all')).toBe(true);
    expect(isCostScope('')).toBe(false);
    expect(isCostScope(undefined)).toBe(false);
    expect(isCostScope('futuro')).toBe(false);
  });

  it('da adesso in avanti: le righe gia scritte chiudono il conto', () => {
    expect(costScopeEffect('future')).toEqual({ freezeExisting: true, clearFrozen: false });
  });

  it('tutti: le righe tornano a seguire il costo corrente, come e sempre stato', () => {
    expect(costScopeEffect('all')).toEqual({ freezeExisting: false, clearFrozen: true });
  });
});

describe('che valore si ferma sulle righe gia scritte', () => {
  it('il costo di prima, non quello nuovo', () => {
    expect(costToFreeze(4.5)).toBe(4.5);
    expect(costToFreeze('4.50')).toBe(4.5);
  });

  // E' il caso della tab Prodotti, dove il costo si inserisce la prima volta:
  // quelle vendite sono sempre state senza costo, e restano senza. Metterci
  // quello di oggi vorrebbe dire dichiarare un margine storico che non e' mai
  // esistito.
  it('se un costo non c era, si ferma l assenza', () => {
    expect(costToFreeze(null)).toBeNull();
    expect(costToFreeze(undefined)).toBeNull();
    expect(costToFreeze('')).toBeNull();
  });

  it('zero e un costo vero e si conserva', () => {
    expect(costToFreeze(0)).toBe(0);
    expect(costToFreeze('0.00')).toBe(0);
  });

  it('un valore insensato non diventa merce gratis', () => {
    expect(costToFreeze('abc')).toBeNull();
    expect(costToFreeze(-1)).toBeNull();
    expect(costToFreeze(Number.NaN)).toBeNull();
  });
});
