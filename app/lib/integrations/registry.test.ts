import { describe, it, expect } from 'vitest';
import {
  INTEGRATIONS,
  getIntegration,
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
      expect(omnisend?.logo).toBe('/integrations/omnisend.png');
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
