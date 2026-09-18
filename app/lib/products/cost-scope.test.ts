import { describe, it, expect } from 'vitest';
import {
  costScopeEffect,
  costToFreeze,
  isCostScope,
  needsCostScopeChoice,
} from './cost-scope';

describe('la scelta su fin dove arriva un costo', () => {
  it('riconosce le due strade e rifiuta tutto il resto', () => {
    expect(isCostScope('future')).toBe(true);
    expect(isCostScope('all')).toBe(true);
    expect(isCostScope('')).toBe(false);
    expect(isCostScope(undefined)).toBe(false);
    expect(isCostScope('futuro')).toBe(false);
  });

  it('da adesso in avanti: le righe gia scritte chiudono il conto sul costo di prima', () => {
    expect(costScopeEffect('future', 4)).toEqual({ freezeExisting: true, clearFrozen: false });
    expect(costScopeEffect('future', '4.50')).toEqual({ freezeExisting: true, clearFrozen: false });
    // Zero e' un costo vero: merce regalata resta merce con un costo dichiarato.
    expect(costScopeEffect('future', 0)).toEqual({ freezeExisting: true, clearFrozen: false });
  });

  // IL BUG. Congelare un'assenza lasciava la riga senza valore ma con la data
  // del congelamento sopra: per il profitto vuol dire "conto chiuso", e nessun
  // costo inserito dopo poteva piu' riportarla dentro. Il merchant compilava il
  // costo che l'app gli chiedeva e ritrovava profitto zero.
  it('senza un costo precedente non si congela niente: non c e nessun passato da proteggere', () => {
    expect(costScopeEffect('future', null)).toEqual({ freezeExisting: false, clearFrozen: false });
    expect(costScopeEffect('future', undefined)).toEqual({ freezeExisting: false, clearFrozen: false });
    expect(costScopeEffect('future', '')).toEqual({ freezeExisting: false, clearFrozen: false });
    // Un valore insensato non e' un costo: non si congela, e non diventa zero.
    expect(costScopeEffect('future', 'abc')).toEqual({ freezeExisting: false, clearFrozen: false });
    expect(costScopeEffect('future', -1)).toEqual({ freezeExisting: false, clearFrozen: false });
  });

  it('tutti: le righe tornano a seguire il costo corrente, come e sempre stato', () => {
    expect(costScopeEffect('all', 4)).toEqual({ freezeExisting: false, clearFrozen: true });
    expect(costScopeEffect('all', null)).toEqual({ freezeExisting: false, clearFrozen: true });
  });
});

describe('quando la domanda va fatta e quando no', () => {
  it('almeno un costo precedente vero: la scelta cambia i numeri gia letti', () => {
    expect(needsCostScopeChoice([4])).toBe(true);
    expect(needsCostScopeChoice([null, '', 0])).toBe(true);
  });

  it('nessun costo precedente: le due risposte fanno la stessa cosa, non si chiede', () => {
    expect(needsCostScopeChoice([])).toBe(false);
    expect(needsCostScopeChoice([null, undefined, '', 'abc'])).toBe(false);
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
