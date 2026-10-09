// app/components/Customers/useIntegrationPreload.test.ts
//
// Test della funzione pura che decide se la risposta dello stato e' usabile
// per aprire la modal gia' pronta.

import { describe, it, expect } from 'vitest';
import { parseIntegrationStatus } from './useIntegrationPreload';

describe('parseIntegrationStatus', () => {
  const BODY = {
    status: 'connected',
    accountName: 'Negozio',
    mapping: null,
    lastRun: null,
    running: false,
    openConflicts: 0,
  };

  it('risposta OK con status → dati pronti', () => {
    expect(parseIntegrationStatus(true, BODY)).toEqual(BODY);
  });

  it('accetta anche gli stati del server non ancora normalizzati', () => {
    expect(parseIntegrationStatus(true, { ...BODY, status: 'none' })?.status).toBe('none');
  });

  it('errore HTTP → null anche con un corpo', () => {
    expect(parseIntegrationStatus(false, BODY)).toBeNull();
    expect(parseIntegrationStatus(false, { error: 'invalid_provider' })).toBeNull();
  });

  it('corpo vuoto, non oggetto o senza status → null', () => {
    expect(parseIntegrationStatus(true, null)).toBeNull();
    expect(parseIntegrationStatus(true, undefined)).toBeNull();
    expect(parseIntegrationStatus(true, 'ok')).toBeNull();
    expect(parseIntegrationStatus(true, { error: 'x' })).toBeNull();
    expect(parseIntegrationStatus(true, { status: 42 })).toBeNull();
  });
});
