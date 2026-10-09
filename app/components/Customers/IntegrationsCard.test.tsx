// app/components/Customers/IntegrationsCard.test.tsx
//
// Test della funzione pura `integrationRowState` che decide lo stato visivo
// di una riga integrazione, e di `buildConflictsUrl` che costruisce l'URL
// preservando i parametri esistenti.

import { describe, it, expect } from 'vitest';
import { integrationRowState, buildConflictsUrl } from './IntegrationsCard';
import { it as it_ } from '~/lib/i18n/it';
import { en } from '~/lib/i18n/en';

describe('integrationRowState', () => {
  const MAPPING = { sourceKey: 'birthday', dateFormat: 'auto' };

  it('collegata con un campo associato → success, «Importa dati» visibile anche senza import precedenti', () => {
    const state = integrationRowState('connected', MAPPING);
    expect(state).toEqual({ badge: 'success', label: 'statusConnected', showImport: true });
  });

  it('collegata senza campo associato → success, niente «Importa dati»', () => {
    const state = integrationRowState('connected', null);
    expect(state).toEqual({ badge: 'success', label: 'statusConnected', showImport: false });
  });

  it('non collegata → attention, niente import', () => {
    expect(integrationRowState('not_connected', MAPPING)).toEqual({
      badge: 'attention',
      label: 'statusNotConnected',
      showImport: false,
    });
  });

  it('da ricollegare → warning, niente import', () => {
    expect(integrationRowState('needs_reconnect', MAPPING)).toEqual({
      badge: 'warning',
      label: 'statusNeedsReconnect',
      showImport: false,
    });
  });

  it('le etichette dei badge esistono in italiano e in inglese', () => {
    for (const label of ['statusConnected', 'statusNotConnected', 'statusNeedsReconnect'] as const) {
      expect(typeof it_.customers.integrations[label]).toBe('string');
      expect(typeof en.customers.integrations[label]).toBe('string');
    }
    expect(it_.customers.integrations.statusConnected).toBe('Collegata');
    expect(en.customers.integrations.statusConnected).toBe('Connected');
  });
});

describe('buildConflictsUrl', () => {
  it('query string vuota → aggiunge view=conflicts', () => {
    const url = buildConflictsUrl('');
    expect(url).toBe('?view=conflicts');
  });

  it('parametri esistenti → li preserva e aggiunge view=conflicts', () => {
    const url = buildConflictsUrl('from=2026-01-01&to=2026-01-31');
    expect(url).toContain('from=2026-01-01');
    expect(url).toContain('to=2026-01-31');
    expect(url).toContain('view=conflicts');
  });

  it('view già presente → la sovrascrive con conflicts', () => {
    const url = buildConflictsUrl('view=all&from=2026-01-01');
    expect(url).toContain('from=2026-01-01');
    expect(url).toContain('view=conflicts');
    expect(url).not.toContain('view=all');
  });

  it('query string con ? iniziale → funziona lo stesso', () => {
    const url = buildConflictsUrl('?from=2026-01-01&to=2026-01-31');
    expect(url).toContain('from=2026-01-01');
    expect(url).toContain('to=2026-01-31');
    expect(url).toContain('view=conflicts');
  });
});
