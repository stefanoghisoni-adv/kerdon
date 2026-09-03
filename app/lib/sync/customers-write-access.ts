/**
 * Il negozio ci ha concesso di SCRIVERE sui suoi clienti?
 *
 * Come per gli ordini (`orders-access`), non e' una questione di piano ma di
 * permesso, e i permessi si concedono all'installazione: un negozio installato
 * quando l'app leggeva soltanto ha dato `read_customers` e basta, e finche' non
 * riautorizza ogni scrittura risponderebbe 403.
 *
 * Serve a una cosa sola, oggi: riportare su Shopify la data di nascita che il
 * merchant ha scritto a mano nel suo database. Senza il permesso quella
 * riscrittura si salta — non e' un guasto e non deve far fallire la
 * sincronizzazione dei clienti, che di suo legge e basta. Constatare prima
 * evita di mandare una mutation destinata a tornare indietro, e di riprovarci
 * a ogni corsa.
 */

/** Lo scope che serve per scrivere un metafield del cliente. */
export const CUSTOMER_WRITE_SCOPE = 'write_customers';

export function hasCustomerWriteAccess(scopes: string | null | undefined): boolean {
  const granted = new Set(
    (scopes ?? '')
      .split(',')
      .map((scope) => scope.trim().toLowerCase())
      .filter(Boolean),
  );
  return granted.has(CUSTOMER_WRITE_SCOPE);
}
