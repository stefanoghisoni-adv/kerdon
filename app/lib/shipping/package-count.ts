// app/lib/shipping/package-count.ts
//
// Quanti pacchi ha spedito un ordine, dalle spedizioni (fulfillment) che
// Shopify ha registrato.
//
// PERCHE' COSI'. Il merchant che paga il corriere a collo vuole il costo per
// pacco, e l'unica traccia dei pacchi che Shopify tiene e' l'elenco delle
// spedizioni dell'ordine: ogni spedizione partita e' un pacco. Contano solo
// quelle partite davvero (FulfillmentStatus, verificato sulla 2026-07):
// SUCCESS, piu' OPEN e PENDING, deprecati ma ancora possibili sugli ordini
// vecchi. CANCELLED, ERROR e FAILURE no: una spedizione annullata o fallita
// non e' mai uscita dal magazzino, e contarla farebbe pagare un pacco mai
// partito. Lo stesso per uno stato assente o sconosciuto. Il rischio opposto
// e' coperto altrove: un ordine spedito con zero pacchi contati ne paga
// comunque uno (effectivePackageCount).
//
// In un file suo perche' lo usano due strade che devono contare allo stesso
// modo: la scrittura dell'ordine (orderNodeFields) e il recupero dello storico
// (shipping-method-backfill). Due conteggi scritti a mano divergerebbero.

const PARTITA = new Set(['SUCCESS', 'OPEN', 'PENDING']);

/** Una spedizione come arriva da Shopify: basta lo stato. */
export interface FulfillmentLike {
  status?: string | null;
}

/**
 * Le spedizioni partite davvero. Zero se non ce n'e' nessuna: il calcolo del
 * costo poi decide cosa vuol dire zero su un ordine spedito
 * (`effectivePackageCount`), qui si conta e basta.
 */
export function countShippedPackages(fulfillments: ReadonlyArray<FulfillmentLike | null> | null | undefined): number {
  if (!fulfillments) return 0;
  return fulfillments.filter((f) => f != null && PARTITA.has((f.status ?? '').toUpperCase())).length;
}
