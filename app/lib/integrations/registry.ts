export type IntegrationCategory = 'crm' | 'database' | 'csv';
export type IntegrationId = 'klaviyo' | 'omnisend';

export interface IntegrationEntry {
  id: IntegrationId;
  name: string;
  category: IntegrationCategory;
  logo: string;
  status: 'available' | 'coming_soon';
}

export const INTEGRATIONS: readonly IntegrationEntry[] = [
  {
    id: 'klaviyo',
    name: 'Klaviyo',
    category: 'crm',
    logo: '/integrations/klaviyo.webp',
    status: 'available',
  },
  {
    id: 'omnisend',
    name: 'Omnisend',
    category: 'crm',
    logo: '',
    status: 'coming_soon',
  },
];

/**
 * Get a single integration by ID, or null if not found
 */
export function getIntegration(id: string): IntegrationEntry | null {
  return INTEGRATIONS.find((integration) => integration.id === id) ?? null;
}
