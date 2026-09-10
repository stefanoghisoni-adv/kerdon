import { describe, it, expect } from 'vitest';
import { hasPausedRows, readScopeStatus } from './scope-status';

describe('i conti dell avviso sui prodotti fermi', () => {
  it('tiene separate le attive dalle ferme', () => {
    const s = readScopeStatus({ active: 50, paused: 350, pausedDataFrom: '2026-03-01T10:00:00Z' });
    expect(s.active).toBe(50);
    expect(s.paused).toBe(350);
    expect(s.pausedDataFrom).toBe('2026-03-01T10:00:00.000Z');
  });

  it('senza risposta non inventa numeri', () => {
    expect(readScopeStatus(undefined)).toEqual({ active: 0, paused: 0, pausedDataFrom: null });
  });

  it('valori insensati diventano zero invece di finire a schermo', () => {
    const s = readScopeStatus({ active: -3, paused: Number.NaN, pausedDataFrom: 'ieri' });
    expect(s.active).toBe(0);
    expect(s.paused).toBe(0);
    expect(s.pausedDataFrom).toBeNull();
  });

  it('l avviso parla solo se c e davvero qualcosa di fermo', () => {
    expect(hasPausedRows(readScopeStatus({ active: 40, paused: 0 }))).toBe(false);
    expect(hasPausedRows(readScopeStatus({ active: 40, paused: 1 }))).toBe(true);
  });
});
