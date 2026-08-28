import { describe, it, expect } from 'vitest';
import { matchesCustomerSearch } from './customer-search';

const mario = {
  firstName: 'Mario',
  lastName: 'De Rossi',
  email: 'mario.rossi@example.com',
  phone: '393331234567',
};

describe('matchesCustomerSearch', () => {
  it('senza ricerca passano tutti', () => {
    expect(matchesCustomerSearch(mario, '')).toBe(true);
    expect(matchesCustomerSearch(mario, '   ')).toBe(true);
  });

  it('nome e cognome, anche a pezzi e senza badare alle maiuscole', () => {
    expect(matchesCustomerSearch(mario, 'mar')).toBe(true);
    expect(matchesCustomerSearch(mario, 'ROSSI')).toBe(true);
  });

  // Chi cerca scrive il nome per intero: in tabella pero' sono due colonne, e
  // confrontarle una alla volta non troverebbe mai "mario de rossi".
  it('nome e cognome uniti, come li scrive chi cerca', () => {
    expect(matchesCustomerSearch(mario, 'mario de rossi')).toBe(true);
  });

  it('email, che in tabella non si vede', () => {
    expect(matchesCustomerSearch(mario, 'example.com')).toBe(true);
  });

  // Nel database il telefono sta in sole cifre, mentre chi cerca lo copia da
  // dove l'ha letto: con il prefisso, con gli spazi, magari con i trattini.
  it('telefono, comunque sia scritto quello che si incolla', () => {
    expect(matchesCustomerSearch(mario, '+39 333 123 4567')).toBe(true);
    expect(matchesCustomerSearch(mario, '3331234567')).toBe(true);
  });

  it('chi non corrisponde resta fuori', () => {
    expect(matchesCustomerSearch(mario, 'bianchi')).toBe(false);
    expect(matchesCustomerSearch(mario, '999999')).toBe(false);
  });

  it('le righe senza email o telefono non fanno saltare la ricerca', () => {
    const senzaNiente = { firstName: null, lastName: null, email: null, phone: null };
    expect(matchesCustomerSearch(senzaNiente, 'mario')).toBe(false);
    expect(matchesCustomerSearch(senzaNiente, '333')).toBe(false);
  });
});
