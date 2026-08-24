/**
 * Data e ora di una corsa, nel fuso del negozio.
 *
 * Il fuso e' quello che il merchant ha impostato su Shopify, non quello del
 * browser: due persone dello stesso negozio in due paesi diversi devono leggere
 * la stessa ora, altrimenti "l'ultima sincronizzazione" diventa un'opinione.
 */
export function formatSyncDate(
  iso: string,
  timeZone: string | null | undefined,
  locale: string,
): string {
  return new Date(iso).toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}
