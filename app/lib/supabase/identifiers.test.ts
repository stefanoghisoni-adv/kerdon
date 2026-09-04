import { describe, it, expect } from 'vitest';
import {
  InvalidIdentifierError,
  identifierRejection,
  isSafeIdentifier,
  quoteIdentifier,
  quoteLiteral,
  quoteQualifiedName,
} from './identifiers';

describe('identificatori ammessi', () => {
  it('i nomi delle tabelle dell app passano', () => {
    for (const name of ['products', 'customers', 'users', 'orders', 'order_lines']) {
      expect(isSafeIdentifier(name)).toBe(true);
    }
  });

  it('il nome esce fra doppi apici', () => {
    // Senza virgolette Postgres normalizza a minuscolo: una tabella creata
    // "Products" non verrebbe piu' trovata.
    expect(quoteIdentifier('Products')).toBe('"Products"');
  });

  it('schema e tabella insieme', () => {
    expect(quoteQualifiedName('public', 'order_lines')).toBe('"public"."order_lines"');
  });

  it('come valore si cita con l apice singolo, non col doppio', () => {
    // Nelle interrogazioni a information_schema il nome e' una stringa da
    // confrontare, non un identificatore: confondere le due citazioni produce
    // una verifica che sembra funzionare e non confronta niente.
    expect(quoteLiteral('products')).toBe("'products'");
  });
});

describe('identificatori rifiutati', () => {
  it('il doppio apice non entra', () => {
    // E' l'attacco vero: `products"; DROP TABLE clienti; --` chiudeva la
    // stringa e il resto diventava SQL eseguito col token del merchant.
    expect(() => quoteIdentifier('products"; DROP TABLE clienti; --')).toThrow(
      InvalidIdentifierError,
    );
  });

  it('punto e virgola, punto e spazi', () => {
    for (const bad of ['products;', 'public.products', 'my products', 'products ']) {
      expect(isSafeIdentifier(bad)).toBe(false);
      expect(() => quoteIdentifier(bad)).toThrow(InvalidIdentifierError);
    }
  });

  it('il nome vuoto', () => {
    expect(identifierRejection('')).toBe('vuoto');
  });

  it('quello che non e nemmeno una stringa', () => {
    expect(isSafeIdentifier(null)).toBe(false);
    expect(isSafeIdentifier(undefined)).toBe(false);
    expect(isSafeIdentifier(42)).toBe(false);
  });

  it('un nome che comincia con una cifra', () => {
    expect(isSafeIdentifier('1products')).toBe(false);
  });

  it('oltre i 63 caratteri', () => {
    // Postgres tronca invece di rifiutare, e un nome troncato punta a una
    // tabella diversa da quella che si credeva di nominare.
    expect(isSafeIdentifier('p'.repeat(63))).toBe(true);
    expect(isSafeIdentifier('p'.repeat(64))).toBe(false);
  });

  it('gli omoglifi Unicode non passano', () => {
    // "prоducts" con la "о" cirillica: a schermo e' identico, e su una DROP
    // vuol dire cancellare una tabella mentre si crede di cancellarne
    // un'altra.
    expect(isSafeIdentifier('prоducts')).toBe(false);
    expect(isSafeIdentifier('products​')).toBe(false);
    expect(isSafeIdentifier('città')).toBe(false);
  });

  it('il rifiuto porta con se il nome e il motivo', () => {
    // Chi chiama deve poterlo distinguere da un guasto di rete: un nome
    // malformato non si ritenta.
    try {
      quoteIdentifier('pro"ducts');
      expect.unreachable('doveva lanciare');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidIdentifierError);
      expect((err as InvalidIdentifierError).identifier).toBe('pro"ducts');
      expect((err as InvalidIdentifierError).message).toContain('caratteri non ammessi');
    }
  });

  it('anche come valore un nome storto viene rifiutato', () => {
    expect(() => quoteLiteral("products'; --")).toThrow(InvalidIdentifierError);
  });
});
