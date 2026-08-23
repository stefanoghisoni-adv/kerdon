/**
 * Il negozio ci ha concesso di leggere i suoi ordini?
 *
 * Non e' una questione di piano ma di permesso, e i permessi si concedono
 * all'installazione: un negozio installato prima che gli ordini esistessero non
 * li ha dati, e finche' non riautorizza ogni chiamata risponderebbe 403.
 * Chiederglieli non e' compito di questo codice — qui si constata soltanto, per
 * non tentare una sincronizzazione che non puo' riuscire.
 */

/** Gli scope che servono, entrambi. */
export const ORDER_SCOPES = ['read_orders', 'read_all_orders'] as const;

/**
 * `read_all_orders` da solo non basta: e' un'estensione di `read_orders`, non
 * un permesso a se'. Senza il primo, la cronologia completa non si apre.
 */
export function hasOrdersAccess(scopes: string | null | undefined): boolean {
  const granted = new Set(
    (scopes ?? '')
      .split(',')
      .map((scope) => scope.trim().toLowerCase())
      .filter(Boolean),
  );
  return ORDER_SCOPES.every((scope) => granted.has(scope));
}
