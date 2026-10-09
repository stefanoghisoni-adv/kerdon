// app/components/Customers/IntegrationsCard.test.tsx
//
// Test della funzione pura `tileState` che decide lo stato visivo di un
// riquadro integrazione, e di `buildConflictsUrl` che costruisce l'URL
// preservando i parametri esistenti.

import { describe, it, expect } from 'vitest';
import { tileState, buildConflictsUrl } from './IntegrationsCard';
import type { IntegrationStatus } from './IntegrationsCard';
import type { IntegrationEntry } from '~/lib/integrations/registry';
import { it as it_ } from '~/lib/i18n/it';
import { en } from '~/lib/i18n/en';

describe('tileState', () => {
  const KLAVIYO_ENTRY: IntegrationEntry = {
    id: 'klaviyo',
    name: 'Klaviyo',
    category: 'crm',
    logo: '/integrations/klaviyo.webp',
    status: 'available',
  };

  const OMNISEND_ENTRY: IntegrationEntry = {
    id: 'omnisend',
    name: 'Omnisend',
    category: 'crm',
    logo: '',
    status: 'coming_soon',
  };

  const CONNECTED_INTEGRATION: IntegrationStatus = {
    provider: 'klaviyo',
    status: 'connected',
    accountName: 'Test Account',
    mapping: { sourceKey: 'birthday', dateFormat: 'auto' },
    lastRun: null,
    openConflicts: 0,
  };

  it('coming_soon → non disponibile, non cliccabile', () => {
    const state = tileState(OMNISEND_ENTRY, undefined);
    expect(state).toEqual({
      label: 'tileNotAvailable',
      tone: 'disabled',
      clickable: false,
    });
  });

  it('disponibile senza stato dal loader → da collegare', () => {
    const state = tileState(KLAVIYO_ENTRY, undefined);
    expect(state).toEqual({
      label: 'tileNotConnected',
      tone: 'subdued',
      clickable: true,
    });
  });

  it('not_connected → da collegare', () => {
    const integration: IntegrationStatus = {
      ...CONNECTED_INTEGRATION,
      status: 'not_connected',
    };
    const state = tileState(KLAVIYO_ENTRY, integration);
    expect(state).toEqual({
      label: 'tileNotConnected',
      tone: 'subdued',
      clickable: true,
    });
  });

  it('connected senza conflitti → installata', () => {
    const state = tileState(KLAVIYO_ENTRY, CONNECTED_INTEGRATION);
    expect(state).toEqual({
      label: 'tileInstalled',
      tone: 'success',
      clickable: true,
    });
  });

  it('connected con conflitti → richiede attenzione', () => {
    const integration: IntegrationStatus = {
      ...CONNECTED_INTEGRATION,
      openConflicts: 3,
    };
    const state = tileState(KLAVIYO_ENTRY, integration);
    expect(state).toEqual({
      label: 'tileNeedsAttention',
      tone: 'caution',
      clickable: true,
    });
  });

  it('needs_reconnect → richiede attenzione', () => {
    const integration: IntegrationStatus = {
      ...CONNECTED_INTEGRATION,
      status: 'needs_reconnect',
    };
    const state = tileState(KLAVIYO_ENTRY, integration);
    expect(state).toEqual({
      label: 'tileNeedsAttention',
      tone: 'caution',
      clickable: true,
    });
  });

  it('le etichette dei riquadri esistono in italiano e in inglese', () => {
    for (const label of [
      'tileInstalled',
      'tileNotConnected',
      'tileNeedsAttention',
      'tileNotAvailable',
    ] as const) {
      expect(typeof it_.customers.integrations[label]).toBe('string');
      expect(typeof en.customers.integrations[label]).toBe('string');
    }
    expect(it_.customers.integrations.tileInstalled).toBe('Installata');
    expect(en.customers.integrations.tileInstalled).toBe('Installed');
    expect(it_.customers.integrations.tileNotConnected).toBe('Da collegare');
    expect(en.customers.integrations.tileNotConnected).toBe('Not connected');
    expect(it_.customers.integrations.tileNeedsAttention).toBe('Richiede attenzione');
    expect(en.customers.integrations.tileNeedsAttention).toBe('Needs attention');
    expect(it_.customers.integrations.tileNotAvailable).toBe('Non disponibile');
    expect(en.customers.integrations.tileNotAvailable).toBe('Not available');
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
