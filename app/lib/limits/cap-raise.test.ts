import { describe, it, expect } from 'vitest';
import { raisedCaps, type CapPlan } from './cap-raise';

const BASIC: CapPlan = { maxProducts: 20, maxCustomers: 0, customersSyncEnabled: false };
const GROWTH: CapPlan = { maxProducts: 200, maxCustomers: 250, customersSyncEnabled: true };
const SCALE: CapPlan = { maxProducts: 1000, maxCustomers: 500, customersSyncEnabled: true };
const CORE: CapPlan = { maxProducts: null, maxCustomers: null, customersSyncEnabled: true };

describe('raisedCaps', () => {
  it('Basic -> Growth: salgono prodotti e clienti (da non sincronizzati a sincronizzati)', () => {
    expect(raisedCaps(BASIC, GROWTH)).toEqual({ products: true, customers: true });
  });

  it('Growth -> Scale: salgono entrambi i tetti finiti', () => {
    expect(raisedCaps(GROWTH, SCALE)).toEqual({ products: true, customers: true });
  });

  it('Scale -> Core: da tetto finito a illimitato conta come salita', () => {
    expect(raisedCaps(SCALE, CORE)).toEqual({ products: true, customers: true });
  });

  it('discesa di piano: niente da recuperare', () => {
    expect(raisedCaps(CORE, BASIC)).toEqual({ products: false, customers: false });
    expect(raisedCaps(SCALE, GROWTH)).toEqual({ products: false, customers: false });
  });

  it('stesso piano (notifica ripetuta): niente da recuperare', () => {
    expect(raisedCaps(GROWTH, GROWTH)).toEqual({ products: false, customers: false });
    expect(raisedCaps(CORE, CORE)).toEqual({ products: false, customers: false });
  });

  it('sale solo il tetto prodotti: si segnala solo quello', () => {
    const prima: CapPlan = { maxProducts: 200, maxCustomers: 250, customersSyncEnabled: true };
    const dopo: CapPlan = { maxProducts: 500, maxCustomers: 250, customersSyncEnabled: true };
    expect(raisedCaps(prima, dopo)).toEqual({ products: true, customers: false });
  });

  it('sale solo il tetto clienti: si segnala solo quello', () => {
    const prima: CapPlan = { maxProducts: 200, maxCustomers: 250, customersSyncEnabled: true };
    const dopo: CapPlan = { maxProducts: 200, maxCustomers: 400, customersSyncEnabled: true };
    expect(raisedCaps(prima, dopo)).toEqual({ products: false, customers: true });
  });

  it('un tetto clienti alto su un piano che i clienti non li sincronizza vale zero', () => {
    const spento: CapPlan = { maxProducts: 20, maxCustomers: 1000, customersSyncEnabled: false };
    expect(raisedCaps(GROWTH, spento).customers).toBe(false);
    expect(raisedCaps(spento, GROWTH).customers).toBe(true);
  });

  it('clienti accesi ma con tetto zero: nessuna salita finche il tetto resta zero', () => {
    const zero: CapPlan = { maxProducts: 20, maxCustomers: 0, customersSyncEnabled: true };
    expect(raisedCaps(BASIC, zero).customers).toBe(false);
  });

  it('piano sconosciuto: vale come lo leggono le sync (prodotti illimitati, clienti spenti)', () => {
    // Chi sincronizza, davanti a un piano che non trova, toglie il tetto ai
    // prodotti e spegne i clienti: la decisione deve misurare quello che e'
    // davvero successo, non un'ipotesi piu' prudente.
    expect(raisedCaps(null, GROWTH)).toEqual({ products: false, customers: true });
    expect(raisedCaps(GROWTH, null)).toEqual({ products: true, customers: false });
    expect(raisedCaps(null, null)).toEqual({ products: false, customers: false });
  });
});
