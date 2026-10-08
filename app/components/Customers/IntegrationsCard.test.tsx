// app/components/Customers/IntegrationsCard.test.tsx
//
// Test della funzione pura `integrationRowState` che decide lo stato visivo
// di una riga integrazione, e della card stessa.

import { describe, it, expect } from 'vitest';
import { integrationRowState } from './IntegrationsCard';

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
