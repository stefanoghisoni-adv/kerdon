import type { Dictionary } from '~/lib/i18n/context';
/**
 * Le piattaforme verso cui un negozio manda dati, raccolte per categoria.
 *
 * Serve al passo che chiede se il merchant ha gia' un'infrastruttura server
 * side: le spunte dicono per cosa gli servirebbe, e quella risposta vale piu'
 * della domanda secca.
 *
 * L'elenco e' scritto qui e non nel database: sono nomi di prodotti altrui, non
 * dati del negozio, e cambiano quando cambiamo noi idea su cosa supportare.
 */

export interface TrackingPlatform {
  name: string;
  /** Spuntata all'apertura: sono quelle che quasi ogni negozio usa. */
  preselected?: boolean;
}

export interface TrackingCategory {
  id: keyof Dictionary['tracking']['serverSide']['categories'];
  platforms: TrackingPlatform[];
}

export const TRACKING_CATEGORIES: TrackingCategory[] = [
  {
    id: 'social',
    platforms: [
      { name: 'Meta Ads', preselected: true },
      { name: 'Google Ads', preselected: true },
      { name: 'TikTok Ads' },
      { name: 'Pinterest Ads' },
    ],
  },
  {
    id: 'email',
    platforms: [{ name: 'Klaviyo' }],
  },
  {
    id: 'crm',
    platforms: [{ name: 'HubSpot' }, { name: 'GoHighLevel' }],
  },
  {
    id: 'analytics',
    platforms: [{ name: 'Google Analytics 4', preselected: true }],
  },
];

/** Le piattaforme spuntate all'apertura del passo. */
export function defaultSelection(
  categories: TrackingCategory[] = TRACKING_CATEGORIES,
): string[] {
  return categories.flatMap((category) =>
    category.platforms.filter((p) => p.preselected).map((p) => p.name),
  );
}

/** Quante, di una categoria, sono spuntate adesso. */
export function selectedInCategory(
  category: TrackingCategory,
  selected: readonly string[],
): number {
  return category.platforms.filter((p) => selected.includes(p.name)).length;
}

/**
 * Le due risposte possibili.
 *
 * `needs` e' una richiesta di contatto, `has` una dichiarazione: sono cose
 * diverse e vanno distinte, ma entrambe chiudono il passo — nessuno deve
 * restare bloccato dalla configurazione per non aver voluto essere ricontattato.
 */
export type ServerSideAnswer = 'needs' | 'has' | 'dismissed';

export function isServerSideAnswer(value: unknown): value is ServerSideAnswer {
  // 'dismissed' non e' una risposta alla domanda ma alla card: il merchant ha
  // detto "non adesso", e la card non deve tornare a ogni apertura. Senza un
  // valore per quel gesto l'unico modo di chiuderla sarebbe stato dichiarare
  // qualcosa che non ha dichiarato.
  return value === 'needs' || value === 'has' || value === 'dismissed';
}

/**
 * I nomi accettati da chi salva la risposta.
 *
 * Solo quelli del catalogo: la lista arriva dal browser, e senza questo filtro
 * chiunque potrebbe scriverci dentro qualunque cosa.
 */
export function knownPlatforms(
  names: unknown,
  categories: TrackingCategory[] = TRACKING_CATEGORIES,
): string[] {
  if (!Array.isArray(names)) return [];
  const catalog = new Set(
    categories.flatMap((category) => category.platforms.map((p) => p.name)),
  );
  return names.filter(
    (name): name is string => typeof name === 'string' && catalog.has(name),
  );
}
