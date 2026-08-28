import { describe, it, expect } from 'vitest';

import { filterNavState } from './filter-nav';

const base = {
  requested: true,
  navigationState: 'loading' as const,
  navigatingTo: '/products/issues',
  navigatingSearch: '',
  path: '/products/issues',
};

const IDLE = { switching: false, loadingAll: false, loadingSold: false };

describe('filterNavState', () => {
  it('premuto "Tutti": e’ quello a mostrare l’attesa', () => {
    expect(filterNavState(base)).toEqual({
      switching: true,
      loadingAll: true,
      loadingSold: false,
    });
  });

  it('premuto "Solo prodotti negli ordini": l’attesa passa all’altro', () => {
    expect(filterNavState({ ...base, navigatingSearch: '?sold=1' })).toEqual({
      switching: true,
      loadingAll: false,
      loadingSold: true,
    });
  });

  it('il filtro per cliente accende lo stesso pulsante: lo restringe, non ne apre un terzo', () => {
    expect(filterNavState({ ...base, navigatingSearch: '?customer=42' })).toEqual({
      switching: true,
      loadingAll: false,
      loadingSold: true,
    });
  });

  it('IL CASO DEL DIFETTO: si cambia sezione dal menu dell’admin → i filtri non si muovono', () => {
    // La navigazione verso un'altra sezione ha una destinazione senza query,
    // che era la firma del filtro "Tutti": il cerchietto si accendeva li' e i
    // filtri si spegnevano mentre il merchant stava gia' uscendo dalla tab.
    expect(
      filterNavState({ ...base, requested: false, navigatingTo: '/logs', navigatingSearch: '' }),
    ).toEqual(IDLE);
  });

  it('anche tornando su questa stessa pagina dal menu, se nessuno ha premuto, resta fermo', () => {
    expect(filterNavState({ ...base, requested: false })).toEqual(IDLE);
  });

  it('premuto un filtro ma la navigazione va altrove → comanda la destinazione vera', () => {
    // Si preme un filtro e subito dopo si sceglie un'altra sezione: e' l'ultima
    // a decidere, non l'intenzione di un attimo prima.
    expect(filterNavState({ ...base, navigatingTo: '/logs' })).toEqual(IDLE);
  });

  it('nessuna navigazione in corso → nessuna attesa, anche se premuto', () => {
    expect(
      filterNavState({
        ...base,
        navigationState: 'idle',
        navigatingTo: undefined,
        navigatingSearch: undefined,
      }),
    ).toEqual(IDLE);
  });

  it('invio di un form → non e’ un cambio di filtro', () => {
    // Il ricontrollo dei costi e' una submit: non deve spegnere i filtri.
    expect(filterNavState({ ...base, navigationState: 'submitting' })).toEqual(IDLE);
  });
});
