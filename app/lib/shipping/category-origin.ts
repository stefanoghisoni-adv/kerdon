// app/lib/shipping/category-origin.ts
import type { CategoryOrigin } from './types';

/**
 * L'origine di una categoria letta dal JSON salvato: 'shopify' solo se c'e'
 * scritto proprio quello, 'manual' in ogni altro caso (assente, sconosciuta o
 * di un altro tipo). Non solleva mai: una categoria con l'origine rovinata
 * resta una categoria valida.
 */
export function normalizeOrigin(value: unknown): CategoryOrigin {
  return value === 'shopify' ? 'shopify' : 'manual';
}
