import { describe, it, expect } from 'vitest';
import { coverage, coverageTone, freshness } from './coverage';

describe('coverage', () => {
  it('dice quanta parte e pronta, non quanto piano resta', () => {
    // 13 su 26 e' meta' catalogo. Che il piano ne consenta 200 e' un'altra
    // domanda, e mescolarle faceva sembrare una buona notizia un catalogo per
    // meta' incompleto.
    expect(coverage(13, 26)).toEqual({ percent: 50, ready: 13, total: 26, missing: 13 });
  });

  it('senza niente da coprire non c e una percentuale', () => {
    // Uno zero rosso su un negozio vuoto sarebbe un allarme inventato.
    expect(coverage(0, 0).percent).toBeNull();
  });

  it('non inventa numeri negativi se i conteggi litigano', () => {
    expect(coverage(30, 20).missing).toBe(0);
  });
});

describe('coverageTone', () => {
  it('verde solo quando non manca niente', () => {
    // Il 96% resta incompleto: dipingerlo di verde toglie la ragione per cui lo
    // si mostra.
    expect(coverageTone(coverage(100, 100))).toBe('success');
    expect(coverageTone(coverage(96, 100))).toBe('warning');
  });

  it('senza copertura non c e tono', () => {
    expect(coverageTone(coverage(0, 0))).toBeUndefined();
  });
});

describe('freshness', () => {
  const now = new Date('2026-08-24T12:00:00Z');

  it('dentro la cadenza del piano e aggiornato', () => {
    expect(
      freshness({ lastSync: '2026-08-24T06:00:00Z', frequencyHours: 24, now }),
    ).toBe('fresh');
  });

  it('un ritardo di poche ore non e un guasto', () => {
    // Chiamare guasto un ritardo fisiologico insegna a ignorare l'avviso.
    expect(
      freshness({ lastSync: '2026-08-23T04:00:00Z', frequencyHours: 24, now }),
    ).toBe('fresh');
  });

  it('oltre il margine va detto', () => {
    expect(
      freshness({ lastSync: '2026-08-21T12:00:00Z', frequencyHours: 24, now }),
    ).toBe('stale');
  });

  it('mai sincronizzato non e ne fresco ne vecchio', () => {
    expect(freshness({ lastSync: null, frequencyHours: 24, now })).toBe('never');
    expect(freshness({ lastSync: 'non-una-data', frequencyHours: 24, now })).toBe('never');
  });

  it('senza cadenza nota si concede la piu lenta dei piani', () => {
    expect(freshness({ lastSync: '2026-08-23T22:00:00Z', frequencyHours: null, now })).toBe(
      'fresh',
    );
  });
});
