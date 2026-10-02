import { describe, it, expect } from 'vitest';
import {
  customerRankKey,
  createCustomerQuota,
  customerQuotaStatus,
  isCustomerLimitReached,
} from './customer-limit';

describe('customerRankKey', () => {
  it('riduce la data di Shopify all ora locale, come la salva la colonna senza fuso', () => {
    // La colonna `created_at` dei clienti e' TIMESTAMP senza fuso: Postgres
    // scarta lo scostamento e tiene l'ora scritta. La graduatoria deve leggere
    // la stessa cosa da entrambe le parti, o un cliente letto da Shopify e lo
    // stesso cliente riletto dal database finirebbero in posti diversi.
    expect(customerRankKey('2024-03-01T10:00:00-05:00')).toBe('2024-03-01T10:00:00');
    expect(customerRankKey('2024-03-01T10:00:00')).toBe('2024-03-01T10:00:00');
    expect(customerRankKey('2024-03-01 10:00:00')).toBe('2024-03-01T10:00:00');
    expect(customerRankKey('2024-03-01T10:00:00.123+00:00')).toBe('2024-03-01T10:00:00');
  });

  it('data assente o illeggibile: la piu vecchia', () => {
    expect(customerRankKey(null)).toBe('');
    expect(customerRankKey(undefined)).toBe('');
    expect(customerRankKey('ieri')).toBe('');
  });
});

describe('createCustomerQuota', () => {
  it('senza tetto ammette tutti', () => {
    const quota = createCustomerQuota(null);
    expect(quota.admit({ id: 1, createdAt: null })).toBe(true);
    expect(quota.admit({ id: 2, createdAt: null })).toBe(true);
    expect(quota.remaining()).toBeNull();
  });

  it('tetto zero: non entra nessuno', () => {
    const quota = createCustomerQuota(0);
    expect(quota.admit({ id: 1, createdAt: '2024-01-01T00:00:00Z' })).toBe(false);
    expect(quota.remaining()).toBe(0);
  });

  it('a quota piena un cliente piu recente resta fuori', () => {
    const seed = [
      { id: 10, createdAt: '2024-01-01T00:00:00' },
      { id: 11, createdAt: '2024-01-02T00:00:00' },
    ];
    const quota = createCustomerQuota(2, seed);
    expect(quota.admit({ id: 99, createdAt: '2025-01-01T00:00:00Z' })).toBe(false);
  });

  it('chi e gia dentro resta dentro e non consuma un secondo posto', () => {
    const seed = [
      { id: 10, createdAt: '2024-01-01T00:00:00' },
      { id: 11, createdAt: '2024-01-02T00:00:00' },
    ];
    const quota = createCustomerQuota(2, seed);
    expect(quota.admit({ id: 11, createdAt: '2024-01-02T00:00:00+02:00' })).toBe(true);
    expect(quota.admit({ id: 10, createdAt: '2024-01-01T00:00:00Z' })).toBe(true);
    expect(quota.remaining()).toBe(0);
  });

  it('i primi N per data di creazione, a parita l id: in qualunque ordine arrivino', () => {
    const clienti = [
      { id: 5, createdAt: '2024-05-01T00:00:00Z' },
      { id: 3, createdAt: '2024-01-01T00:00:00Z' },
      { id: 4, createdAt: '2024-01-01T00:00:00Z' },
      { id: 1, createdAt: '2024-09-01T00:00:00Z' },
    ];
    const avanti = createCustomerQuota(2);
    clienti.forEach((c) => avanti.admit(c));
    const indietro = createCustomerQuota(2);
    [...clienti].reverse().forEach((c) => indietro.admit(c));
    expect(avanti.chosenIds()).toEqual([3, 4]);
    expect(indietro.chosenIds()).toEqual([3, 4]);
  });

  it('il tetto si conta sui primi N gia sincronizzati anche se il database ne ha di piu (piano piu piccolo)', () => {
    // Dopo un passaggio a un piano piu piccolo la tabella ne ha piu del tetto:
    // restano tutti, ma si aggiornano solo i primi N.
    const seed = [
      { id: 1, createdAt: '2024-01-01T00:00:00' },
      { id: 2, createdAt: '2024-01-02T00:00:00' },
      { id: 3, createdAt: '2024-01-03T00:00:00' },
    ];
    const quota = createCustomerQuota(2, seed);
    expect(quota.admit({ id: 3, createdAt: '2024-01-03T00:00:00Z' })).toBe(false);
    expect(quota.admit({ id: 1, createdAt: '2024-01-01T00:00:00Z' })).toBe(true);
  });
});

describe('isCustomerLimitReached', () => {
  it('senza tetto mai', () => {
    expect(isCustomerLimitReached(9999, null)).toBe(false);
    expect(isCustomerLimitReached(9999, undefined)).toBe(false);
  });
  it('al tetto o oltre', () => {
    expect(isCustomerLimitReached(250, 250)).toBe(true);
    expect(isCustomerLimitReached(251, 250)).toBe(true);
    expect(isCustomerLimitReached(249, 250)).toBe(false);
    expect(isCustomerLimitReached(0, 0)).toBe(true);
  });
});

describe('customerQuotaStatus', () => {
  it('sotto il tetto: tutti attivi', () => {
    expect(customerQuotaStatus(120, 250)).toEqual({ synced: 120, limit: 250, active: 120, paused: 0 });
  });
  it('oltre il tetto dopo un cambio di piano: gli eccedenti sono fermi, non persi', () => {
    expect(customerQuotaStatus(600, 500)).toEqual({ synced: 600, limit: 500, active: 500, paused: 100 });
  });
  it('senza tetto', () => {
    expect(customerQuotaStatus(42, null)).toEqual({ synced: 42, limit: null, active: 42, paused: 0 });
  });
  it('valori sporchi diventano zero', () => {
    expect(customerQuotaStatus(Number.NaN, 250)).toEqual({ synced: 0, limit: 250, active: 0, paused: 0 });
    expect(customerQuotaStatus(-3, 250)).toEqual({ synced: 0, limit: 250, active: 0, paused: 0 });
  });
});
