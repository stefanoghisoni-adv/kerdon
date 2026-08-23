import { describe, it, expect } from 'vitest';
import {
  canInstall,
  categoryLabel,
  groupByCategory,
  normalizeStatus,
  platformInitials,
  statusLabel,
  type Platform,
} from './platforms';
import { it as itDict } from '~/lib/i18n/it';

describe('normalizeStatus', () => {
  it('riconosce gli stati che l app sa trattare', () => {
    expect(normalizeStatus('available')).toBe('available');
    expect(normalizeStatus('unavailable')).toBe('unavailable');
  });

  it('quello che non conosce vale "in arrivo"', () => {
    // E' l'unico stato che non promette niente e non nega niente: un valore
    // scritto storto sul database non deve mai far comparire "Installa".
    expect(normalizeStatus('quasi pronto')).toBe('coming_soon');
    expect(normalizeStatus(null)).toBe('coming_soon');
    expect(normalizeStatus('')).toBe('coming_soon');
  });

  it('spazi e maiuscole non contano: la riga la scrive una persona', () => {
    expect(normalizeStatus('  AVAILABLE ')).toBe('available');
  });
});

describe('canInstall', () => {
  it('si installa solo cio che e disponibile', () => {
    expect(canInstall('available')).toBe(true);
    expect(canInstall('coming_soon')).toBe(false);
    expect(canInstall('unavailable')).toBe(false);
  });
});

describe('categoryLabel', () => {
  it('traduce le categorie che conosce', () => {
    expect(categoryLabel('advertising', itDict)).toBe('Advertising');
    expect(categoryLabel('email', itDict)).toBe('Email marketing');
  });

  it('una categoria nuova si legge lo stesso', () => {
    // Aggiungerne una sul database non deve richiedere di toccare il codice.
    expect(categoryLabel('Analytics', itDict)).toBe('Analytics');
  });
});

describe('statusLabel', () => {
  it('dice lo stato nella lingua di chi guarda', () => {
    expect(statusLabel('coming_soon', itDict)).toBe('In arrivo');
  });
});

describe('platformInitials', () => {
  it('due lettere al massimo', () => {
    expect(platformInitials('Meta Ads')).toBe('MA');
    expect(platformInitials('Klaviyo')).toBe('K');
  });
});

describe('groupByCategory', () => {
  const platform = (slug: string, category: string): Platform => ({
    slug,
    name: slug,
    category,
    logoUrl: null,
    status: 'coming_soon',
  });

  it('raggruppa tenendo l ordine che arriva', () => {
    const groups = groupByCategory([
      platform('meta-ads', 'advertising'),
      platform('hubspot', 'crm'),
      platform('google-ads', 'advertising'),
    ]);

    expect(groups.map((g) => g.category)).toEqual(['advertising', 'crm']);
    expect(groups[0].items.map((p) => p.slug)).toEqual(['meta-ads', 'google-ads']);
  });
});
