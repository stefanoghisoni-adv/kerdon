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
 * Normalize a string for case and accent-insensitive comparison
 */
function normalizeString(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Get categories in use in the specified list, in order: crm, database, csv
 * Only returns categories that have at least one entry
 */
export function categoriesInUse(
  list?: readonly IntegrationEntry[]
): IntegrationCategory[] {
  const integrations = list ?? INTEGRATIONS;
  const categories: IntegrationCategory[] = ['crm', 'database', 'csv'];
  const usedCategories = new Set(integrations.map((i) => i.category));
  return categories.filter((cat) => usedCategories.has(cat));
}

/**
 * Search integrations by query string and optional category filter
 * Search is case and accent-insensitive on the name field
 */
export function searchIntegrations(
  query: string,
  category: IntegrationCategory | 'all',
  list?: readonly IntegrationEntry[]
): IntegrationEntry[] {
  const integrations = list ?? INTEGRATIONS;
  const normalizedQuery = normalizeString(query);

  return integrations.filter((integration) => {
    // Filter by category if specified
    if (category !== 'all' && integration.category !== category) {
      return false;
    }

    // Filter by query (case and accent-insensitive)
    if (normalizedQuery && !normalizeString(integration.name).includes(normalizedQuery)) {
      return false;
    }

    return true;
  });
}

/**
 * Get a single integration by ID, or null if not found
 */
export function getIntegration(id: string): IntegrationEntry | null {
  return INTEGRATIONS.find((integration) => integration.id === id) ?? null;
}
