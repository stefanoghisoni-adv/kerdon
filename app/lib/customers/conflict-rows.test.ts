// app/lib/customers/conflict-rows.test.ts
//
// Test per le funzioni pure di gestione dei conflitti nella tabella Clienti.

import { describe, it, expect } from 'vitest';
import { conflictRows, parseViewParam, effectiveView } from './conflict-rows';

describe('parseViewParam', () => {
  it('restituisce "all" quando view non è presente', () => {
    const params = new URLSearchParams('');
    expect(parseViewParam(params)).toBe('all');
  });

  it('restituisce "conflicts" quando view=conflicts', () => {
    const params = new URLSearchParams('view=conflicts');
    expect(parseViewParam(params)).toBe('conflicts');
  });

  it('restituisce "all" quando view ha un valore non riconosciuto', () => {
    const params = new URLSearchParams('view=invalid');
    expect(parseViewParam(params)).toBe('all');
  });

  it('preserva altri parametri', () => {
    const params = new URLSearchParams('from=2024-01-01&to=2024-12-31&view=conflicts');
    expect(parseViewParam(params)).toBe('conflicts');
    // Verifica che gli altri parametri siano ancora presenti
    expect(params.get('from')).toBe('2024-01-01');
    expect(params.get('to')).toBe('2024-12-31');
  });
});

describe('effectiveView', () => {
  it('restituisce "conflicts" quando richiesto e ci sono conflitti', () => {
    const params = new URLSearchParams('view=conflicts');
    expect(effectiveView(params, 5)).toBe('conflicts');
  });

  it('restituisce "all" quando richiesto conflicts ma non ci sono conflitti', () => {
    const params = new URLSearchParams('view=conflicts');
    expect(effectiveView(params, 0)).toBe('all');
  });

  it('restituisce "all" quando view=all', () => {
    const params = new URLSearchParams('view=all');
    expect(effectiveView(params, 5)).toBe('all');
  });

  it('restituisce "all" quando view non è presente', () => {
    const params = new URLSearchParams('');
    expect(effectiveView(params, 5)).toBe('all');
  });
});

describe('conflictRows', () => {
  it('restituisce array vuoto quando non ci sono conflitti', () => {
    const conflicts: Array<{ customerId: number; field: string; ours: string; theirs: string; provider: string }> = [];
    const customers: Array<{ customerId: number; firstName: string | null; email: string | null }> = [
      { customerId: 1, firstName: 'Mario', email: 'mario@example.com' },
    ];

    expect(conflictRows(conflicts, customers)).toEqual([]);
  });

  it('unisce il conflitto con i dati del cliente quando il cliente è presente', () => {
    const conflicts = [
      { customerId: 1, field: 'birthdate', ours: '1990-01-01', theirs: '1990-01-02', provider: 'klaviyo' },
    ];
    const customers = [
      { customerId: 1, firstName: 'Mario', email: 'mario@example.com' },
    ];

    const result = conflictRows(conflicts, customers);

    expect(result).toEqual([
      {
        customerId: 1,
        firstName: 'Mario',
        email: 'mario@example.com',
        ours: '1990-01-01',
        theirs: '1990-01-02',
        provider: 'klaviyo',
      },
    ]);
  });

  it('usa solo customerId quando il cliente non è nella lista (fuori periodo)', () => {
    const conflicts = [
      { customerId: 1, field: 'birthdate', ours: '1990-01-01', theirs: '1990-01-02', provider: 'klaviyo' },
    ];
    const customers: Array<{ customerId: number; firstName: string | null; email: string | null }> = [];

    const result = conflictRows(conflicts, customers);

    expect(result).toEqual([
      {
        customerId: 1,
        firstName: null,
        email: null,
        ours: '1990-01-01',
        theirs: '1990-01-02',
        provider: 'klaviyo',
      },
    ]);
  });

  it('gestisce più conflitti su clienti diversi', () => {
    const conflicts = [
      { customerId: 1, field: 'birthdate', ours: '1990-01-01', theirs: '1990-01-02', provider: 'klaviyo' },
      { customerId: 2, field: 'birthdate', ours: '1985-05-15', theirs: '1985-05-16', provider: 'klaviyo' },
    ];
    const customers = [
      { customerId: 1, firstName: 'Mario', email: 'mario@example.com' },
      { customerId: 2, firstName: 'Luigi', email: 'luigi@example.com' },
    ];

    const result = conflictRows(conflicts, customers);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ customerId: 1, firstName: 'Mario' });
    expect(result[1]).toMatchObject({ customerId: 2, firstName: 'Luigi' });
  });

  it('gestisce mix di clienti presenti e non presenti', () => {
    const conflicts = [
      { customerId: 1, field: 'birthdate', ours: '1990-01-01', theirs: '1990-01-02', provider: 'klaviyo' },
      { customerId: 2, field: 'birthdate', ours: '1985-05-15', theirs: '1985-05-16', provider: 'klaviyo' },
    ];
    const customers = [
      { customerId: 1, firstName: 'Mario', email: 'mario@example.com' },
    ];

    const result = conflictRows(conflicts, customers);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ customerId: 1, firstName: 'Mario', email: 'mario@example.com' });
    expect(result[1]).toMatchObject({ customerId: 2, firstName: null, email: null });
  });

  it('gestisce cliente con firstName null ma presente nella lista', () => {
    const conflicts = [
      { customerId: 1, field: 'birthdate', ours: '1990-01-01', theirs: '1990-01-02', provider: 'klaviyo' },
    ];
    const customers = [
      { customerId: 1, firstName: null, email: 'nessunnome@example.com' },
    ];

    const result = conflictRows(conflicts, customers);

    expect(result).toEqual([
      {
        customerId: 1,
        firstName: null,
        email: 'nessunnome@example.com',
        ours: '1990-01-01',
        theirs: '1990-01-02',
        provider: 'klaviyo',
      },
    ]);
  });

  it('gestisce ours: null (data non indicata nel nostro sistema)', () => {
    const conflicts = [
      { customerId: 1, field: 'birthdate', ours: null, theirs: '1990-01-01', provider: 'klaviyo' },
    ];
    const customers = [
      { customerId: 1, firstName: 'Mario', email: 'mario@example.com' },
    ];

    const result = conflictRows(conflicts, customers);

    expect(result).toEqual([
      {
        customerId: 1,
        firstName: 'Mario',
        email: 'mario@example.com',
        ours: null,
        theirs: '1990-01-01',
        provider: 'klaviyo',
      },
    ]);
  });
});
