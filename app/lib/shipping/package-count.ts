// app/lib/shipping/package-count.ts
//
// Quanti pacchi ha spedito un ordine, dalle spedizioni (fulfillment) che
// Shopify ha registrato.
//
// PERCHE' COSI'. Il merchant che paga il corriere a collo vuole il costo per
// pacco, e l'unica traccia dei pacchi che Shopify tiene e' l'elenco delle
// spedizioni dell'ordine: ogni spedizione e' un invio, cioe' un pacco. Le
// annullate (stato CANCELLED, verificato sulla 2026-07: FulfillmentStatus)
// non sono mai partite, quindi non contano. Gli altri stati contano: SUCCESS e'
// il caso normale, e OPEN/PENDING (deprecati) o ERROR/FAILURE riguardano la
// richiesta al servizio di evasione, non dicono che il pacco non esista.
//
// In un file suo perche' lo usano due strade che devono contare allo stesso
// modo: la scrittura dell'ordine (orderNodeFields) e il recupero dello storico
// (shipping-method-backfill). Due conteggi scritti a mano divergerebbero.

const NON_PARTITA = 'CANCELLED';

/** Una spedizione come arriva da Shopify: basta lo stato. */
export interface FulfillmentLike {
  status?: string | null;
}

/**
 * Le spedizioni non annullate. Zero se non ce n'e' nessuna: il calcolo del
 * costo poi decide cosa vuol dire zero su un ordine spedito
 * (`effectivePackageCount`), qui si conta e basta.
 */
export function countShippedPackages(fulfillments: ReadonlyArray<FulfillmentLike | null> | null | undefined): number {
  if (!fulfillments) return 0;
  return fulfillments.filter((f) => f != null && (f.status ?? '').toUpperCase() !== NON_PARTITA).length;
}
