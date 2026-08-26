import { describe, it, expect } from 'vitest';
// Alias: `it` e' anche il nome del caso di test in vitest.
import { it as itDict } from '~/lib/i18n/it';
import {
  tableCreationMessage,
  syncStatusBadge,
  formatDateTime,
  syncErrorMessage,
  hasSyncDetail,
} from './sync-log-format';

describe('hasSyncDetail', () => {
  const nessunCambio = {
    productsAdded: 0,
    productsRemoved: 0,
    customersAdded: 0,
    customersUpdated: 0,
    customersSuspended: 0,
  };

  it('nessun cambiamento → niente da mostrare', () => {
    expect(hasSyncDetail(nessunCambio)).toBe(false);
  });

  it('basta un contatore sopra lo zero', () => {
    expect(hasSyncDetail({ ...nessunCambio, productsAdded: 1 })).toBe(true);
    expect(hasSyncDetail({ ...nessunCambio, productsRemoved: 1 })).toBe(true);
    expect(hasSyncDetail({ ...nessunCambio, customersAdded: 1 })).toBe(true);
    expect(hasSyncDetail({ ...nessunCambio, customersUpdated: 1 })).toBe(true);
    expect(hasSyncDetail({ ...nessunCambio, customersSuspended: 1 })).toBe(true);
  });
});

describe('tableCreationMessage', () => {
  it('una frase sola per tutti e tre gli eventi di creazione', () => {
    // Quali tabelle siano nate lo dice il dettaglio: tre titoli diversi per la
    // stessa notizia facevano sembrare diverse tre corse che diverse non sono.
    for (const type of ['table_create_products', 'table_create_customers', 'table_create_both']) {
      expect(tableCreationMessage(type, itDict)).toBe('Creazione tabelle nel database');
    }
  });
  it('un job di sync non e un evento di creazione', () => {
    expect(tableCreationMessage('initial_bulk', itDict)).toBeNull();
  });
});

describe('syncStatusBadge', () => {
  it('completed', () => expect(syncStatusBadge('completed', itDict)).toEqual({ tone: 'success', label: 'Completata' }));
  it('failed', () => expect(syncStatusBadge('failed', itDict)).toEqual({ tone: 'critical', label: 'Fallita' }));
  it('running', () => expect(syncStatusBadge('running', itDict)).toEqual({ tone: 'info', label: 'In corso' }));
});

describe('formatDateTime', () => {
  // Istante noto in UTC: le 12:05 UTC del 24 luglio 2026.
  const iso = '2026-07-24T12:05:00.000Z';

  it('formatta nel fuso indicato', () => {
    // Europe/Rome d'estate e UTC+2.
    expect(formatDateTime(iso, 'Europe/Rome', 'it')).toBe('24/07/2026 14:05');
  });

  it('fuso assente → UTC', () => {
    expect(formatDateTime(iso, null, 'it')).toBe('24/07/2026 12:05');
    expect(formatDateTime(iso, undefined, 'it')).toBe('24/07/2026 12:05');
  });

  it('fuso non valido → ricade su UTC senza lanciare', () => {
    expect(formatDateTime(iso, 'Non/Esiste', 'it')).toBe('24/07/2026 12:05');
  });

  it('fuso diverso produce un orario diverso dallo stesso istante', () => {
    expect(formatDateTime(iso, 'America/New_York', 'it')).toBe('24/07/2026 08:05');
  });
});

describe('syncErrorMessage', () => {
  it('tabella prodotti non trovata → frase leggibile', () => {
    expect(
      syncErrorMessage(
        "Supabase products upsert failed: Could not find the table 'public.products' in the schema cache",
        itDict,
      ),
    ).toBe('Non è stata trovata nessuna tabella per i prodotti');
  });

  it('tabella clienti non trovata → frase leggibile', () => {
    expect(
      syncErrorMessage(
        "Supabase customer upsert failed: Could not find the table 'public.customers' in the schema cache",
        itDict,
      ),
    ).toBe('Non è stata trovata nessuna tabella per i clienti');
  });

  it('vale anche per il "does not exist" di Postgres', () => {
    expect(syncErrorMessage('relation "products" does not exist', itDict)).toBe(
      'Non è stata trovata nessuna tabella per i prodotti',
    );
    expect(syncErrorMessage('relation "customers" does not exist', itDict)).toBe(
      'Non è stata trovata nessuna tabella per i clienti',
    );
  });

  it('errori che non sappiamo tradurre passano com’erano', () => {
    // Meglio un errore tecnico che nessun errore: chi guarda il log deve
    // comunque poterlo riportare al supporto.
    expect(syncErrorMessage('Shopify API error: 429', itDict)).toBe('Shopify API error: 429');
  });

  it('errore assente o vuoto → non lascia la cella muta', () => {
    expect(syncErrorMessage(null, itDict)).toBe('Errore sconosciuto');
    expect(syncErrorMessage('   ', itDict)).toBe('Errore sconosciuto');
  });
});
