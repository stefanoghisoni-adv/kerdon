import { describe, it, expect } from 'vitest';
import { resolveSyncState } from './sync-state';

const connectedAt = new Date('2026-07-17T10:00:00Z');
const before = new Date('2026-07-17T09:00:00Z');
const after = new Date('2026-07-17T11:00:00Z');

describe('resolveSyncState', () => {
  it('idle senza connessione verificata', () => {
    expect(resolveSyncState({ status: 'completed', startedAt: after }, null)).toBe('idle');
  });

  it('idle senza nessuna corsa completa', () => {
    expect(resolveSyncState(null, connectedAt)).toBe('idle');
  });

  it('completed se la corsa e completata DOPO la connessione', () => {
    expect(resolveSyncState({ status: 'completed', startedAt: after }, connectedAt)).toBe(
      'completed',
    );
  });

  it('in_progress se la corsa e running dopo la connessione', () => {
    expect(resolveSyncState({ status: 'running', startedAt: after }, connectedAt)).toBe(
      'in_progress',
    );
  });

  // Il caso da cui nasceva l'attesa senza fine: una corsa fallita veniva
  // riportata come 'idle', cioe' indistinguibile da "mai avvenuta", e chi
  // aspettava il passaggio a 'completed' non lo vedeva mai arrivare.
  it('failed e uno stato suo, non un ripiego su idle', () => {
    expect(resolveSyncState({ status: 'failed', startedAt: after }, connectedAt)).toBe('failed');
  });

  it('idle: una corsa completata PRIMA della connessione non conta (riconnessione)', () => {
    expect(resolveSyncState({ status: 'completed', startedAt: before }, connectedAt)).toBe('idle');
  });

  it('uno stato sconosciuto vale come idle', () => {
    expect(resolveSyncState({ status: 'queued', startedAt: after }, connectedAt)).toBe('idle');
  });
});
