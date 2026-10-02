import { describe, it, expect } from 'vitest';
import {
  INTEGRATIONS,
  categoriesInUse,
  searchIntegrations,
  getIntegration,
  IntegrationCategory,
  IntegrationEntry,
} from './registry';

describe('integrations registry', () => {
  describe('INTEGRATIONS constant', () => {
    it('includes klaviyo as available', () => {
      const klaviyo = INTEGRATIONS.find((i) => i.id === 'klaviyo');
      expect(klaviyo).toBeDefined();
      expect(klaviyo?.status).toBe('available');
      expect(klaviyo?.name).toBe('Klaviyo');
      expect(klaviyo?.category).toBe('crm');
      expect(klaviyo?.logo).toBe('/integrations/klaviyo.webp');
    });

    it('includes omnisend as coming_soon', () => {
      const omnisend = INTEGRATIONS.find((i) => i.id === 'omnisend');
      expect(omnisend).toBeDefined();
      expect(omnisend?.status).toBe('coming_soon');
      expect(omnisend?.name).toBe('Omnisend');
      expect(omnisend?.category).toBe('crm');
      expect(omnisend?.logo).toBe('');
    });
  });

  describe('categoriesInUse()', () => {
    it('returns crm category', () => {
      const categories = categoriesInUse();
      expect(categories).toEqual(['crm']);
    });

    it('returns categories in order: crm, database, csv', () => {
      // Create a test list with all categories
      const testList = [
        {
          id: 'omnisend' as const,
          name: 'CSV',
          category: 'csv' as const,
          logo: '',
          status: 'available' as const,
        },
        {
          id: 'klaviyo' as const,
          name: 'Database',
          category: 'database' as const,
          logo: '',
          status: 'available' as const,
        },
        {
          id: 'omnisend' as const,
          name: 'CRM',
          category: 'crm' as const,
          logo: '',
          status: 'available' as const,
        },
      ] as const satisfies readonly IntegrationEntry[];
      const categories = categoriesInUse(testList);
      expect(categories).toEqual(['crm', 'database', 'csv']);
    });

    it('only includes categories that have entries', () => {
      const testList = [
        {
          id: 'omnisend' as const,
          name: 'CSV',
          category: 'csv' as const,
          logo: '',
          status: 'available' as const,
        },
      ] as const satisfies readonly IntegrationEntry[];
      const categories = categoriesInUse(testList);
      expect(categories).toEqual(['csv']);
    });
  });

  describe('searchIntegrations()', () => {
    it('finds klaviyo when searching KLAV in all categories', () => {
      const results = searchIntegrations('KLAV', 'all');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('klaviyo');
    });

    it('case insensitive search finds klaviyo', () => {
      const results = searchIntegrations('klaviyo', 'all');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('klaviyo');
    });

    it('returns empty array when searching in database category', () => {
      const results = searchIntegrations('', 'database');
      expect(results).toHaveLength(0);
    });

    it('returns empty array for non-matching query', () => {
      const results = searchIntegrations('xyz', 'all');
      expect(results).toHaveLength(0);
    });

    it('filters by category', () => {
      const results = searchIntegrations('', 'crm');
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((i) => i.category === 'crm')).toBe(true);
    });

    it('supports accent-insensitive search', () => {
      const testList = [
        {
          id: 'omnisend' as const,
          name: 'Intégration',
          category: 'crm' as const,
          logo: '',
          status: 'available' as const,
        },
      ] as const satisfies readonly IntegrationEntry[];
      const results = searchIntegrations('integration', 'all', testList);
      expect(results).toHaveLength(1);
    });
  });

  describe('getIntegration()', () => {
    it('returns null for non-existent integration', () => {
      const result = getIntegration('x');
      expect(result).toBeNull();
    });

    it('returns klaviyo by id', () => {
      const result = getIntegration('klaviyo');
      expect(result).toBeDefined();
      expect(result?.name).toBe('Klaviyo');
    });

    it('returns omnisend by id', () => {
      const result = getIntegration('omnisend');
      expect(result).toBeDefined();
      expect(result?.name).toBe('Omnisend');
    });

    it('case sensitive id lookup', () => {
      const result = getIntegration('KLAVIYO');
      expect(result).toBeNull();
    });
  });
});
