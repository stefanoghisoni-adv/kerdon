// app/components/Customers/IntegrationsCard.test.tsx
//
// Test della funzione pura `integrationRowState` che decide lo stato visivo
// di una riga integrazione, e di `buildConflictsUrl` che costruisce l'URL
// preservando i parametri esistenti.

import { describe, it, expect } from 'vitest';
import { integrationRowState, buildConflictsUrl } from './IntegrationsCard';

describe('integrationRowState', () => {
  it('collegata con ultimo import riuscito → success badge, showImport true', () => {
    const state = integrationRowState('connected', {
      status: 'completed',
      finishedAt: '2026-10-01T10:00:00Z',
      counters: { filled: 10, conflicts: 2 },
    });
    expect(state.badge).toBe('success');
    expect(state.tone).toBe('Collegata');
    expect(state.showImport).toBe(true);
  });

  it('collegata senza import mai eseguito → success badge, showImport true', () => {
    const state = integrationRowState('connected', null);
    expect(state.badge).toBe('success');
    expect(state.tone).toBe('Collegata');
    expect(state.showImport).toBe(true);
  });

  it('non collegata → attention badge, showImport false', () => {
    const state = integrationRowState('not_connected', null);
    expect(state.badge).toBe('attention');
    expect(state.tone).toBe('Da collegare');
    expect(state.showImport).toBe(false);
  });

  it('needs_reconnect → warning badge, showImport false', () => {
    const state = integrationRowState('needs_reconnect', null);
    expect(state.badge).toBe('warning');
    expect(state.tone).toBe('Riconnetti');
    expect(state.showImport).toBe(false);
  });

  it('collegata con import interrotto → success badge, showImport true', () => {
    const state = integrationRowState('connected', {
      status: 'interrupted',
      finishedAt: '2026-10-01T10:00:00Z',
      counters: { filled: 5, conflicts: 1 },
    });
    expect(state.badge).toBe('success');
    expect(state.tone).toBe('Collegata');
    expect(state.showImport).toBe(true);
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
