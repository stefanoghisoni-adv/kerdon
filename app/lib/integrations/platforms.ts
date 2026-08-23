import type { Dictionary } from '~/lib/i18n/context';

/**
 * Lo stato di una piattaforma nell'elenco Integrazioni.
 *
 * Vive sul database dell'owner: una piattaforma diventa disponibile il giorno
 * in cui la sua connessione e' pronta, e quel giorno non deve coincidere con un
 * rilascio dell'app.
 */
export type PlatformStatus = 'available' | 'coming_soon' | 'unavailable';

export interface Platform {
  slug: string;
  name: string;
  category: string;
  logoUrl: string | null;
  status: PlatformStatus;
}

/** Quello che il database dice, ridotto a cio' che l'app sa trattare. */
export function normalizeStatus(value: string | null | undefined): PlatformStatus {
  const status = (value ?? '').trim().toLowerCase();
  if (status === 'available' || status === 'unavailable') return status;
  // Tutto il resto — compreso un valore scritto storto — vale "in arrivo": e'
  // l'unico stato che non promette niente e non nega niente.
  return 'coming_soon';
}

/** Solo le piattaforme disponibili si installano. */
export function canInstall(status: PlatformStatus): boolean {
  return status === 'available';
}

export function statusLabel(
  status: PlatformStatus,
  t: Pick<Dictionary, 'integrations'>,
): string {
  if (status === 'available') return t.integrations.status.available;
  if (status === 'unavailable') return t.integrations.status.unavailable;
  return t.integrations.status.comingSoon;
}

/**
 * Il nome della categoria, tradotto quando la conosciamo.
 *
 * Le categorie stanno sul database come chiavi: l'app traduce quelle che sa, e
 * scrive com'e' quella che non conosce — cosi' aggiungerne una non richiede di
 * toccare il codice, e nel frattempo si legge lo stesso.
 */
export function categoryLabel(
  category: string,
  t: Pick<Dictionary, 'integrations'>,
): string {
  const known = t.integrations.categories as Record<string, string | undefined>;
  return known[category] ?? category;
}

/** Le iniziali da mostrare quando manca il logo: "Meta Ads" → "MA". */
export function platformInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

/** Le piattaforme raggruppate per categoria, nell'ordine deciso dall'owner. */
export function groupByCategory(platforms: Platform[]): { category: string; items: Platform[] }[] {
  const groups = new Map<string, Platform[]>();
  for (const platform of platforms) {
    const bucket = groups.get(platform.category);
    if (bucket) bucket.push(platform);
    else groups.set(platform.category, [platform]);
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
}
