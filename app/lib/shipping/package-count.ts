// app/lib/shipping/package-count.ts
//
// Quanti pacchi ha spedito un ordine, dalle spedizioni (fulfillment) che
// Shopify ha registrato.
//
// PERCHE' COSI'. Il merchant che paga il corriere a collo vuole il costo per
// pacco. Una spedizione di Shopify non e' sempre un pacco: una spedizione
// multi-collo porta piu' numeri di tracking (`trackingInfo` e' una lista, e
// Shopify ne accetta piu' d'uno per spedizione proprio per questo). Quindi:
// - per ogni spedizione partita, i numeri di tracking DISTINTI e non vuoti
//   (spazi attorno tolti: " A " e "A" sono lo stesso pacco);
// - una spedizione partita senza nessun tracking vale un pacco: e' uscita, un
//   collo l'ha fatto di sicuro;
// - il conteggio e' per spedizione: lo stesso numero su due spedizioni diverse
//   conta due volte, perche' Shopify non dice che sia lo stesso collo.
//
// Contano solo le spedizioni partite davvero (FulfillmentStatus, verificato
// sulla 2026-07): SUCCESS, piu' OPEN e PENDING, deprecati ma ancora possibili
// sugli ordini vecchi. CANCELLED, ERROR e FAILURE no: una spedizione annullata
// o fallita non e' mai uscita dal magazzino, anche se porta un tracking. Lo
// stesso per uno stato assente o sconosciuto. Il rischio opposto e' coperto
// altrove: un ordine spedito con zero pacchi contati ne paga comunque uno
// (effectivePackageCount).
//
// In un file suo perche' lo usano tutte le strade che scrivono i pacchi — la
// sincronizzazione, il webhook e il recupero dello storico, attraverso
// deriveOrderLogisticsFacts — e devono contare allo stesso modo.

/** Gli stati di una spedizione partita davvero. */
export const SHIPPED_FULFILLMENT_STATUSES = ['SUCCESS', 'OPEN', 'PENDING'] as const;

const PARTITA = new Set<string>(SHIPPED_FULFILLMENT_STATUSES);

/** Una spedizione come arriva da Shopify: stato e numeri di tracking. */
export interface FulfillmentLike {
  status?: string | null;
  trackingInfo?: ReadonlyArray<{ number?: string | null } | null> | null;
}

/** I pacchi di una spedizione gia' riconosciuta come partita. */
function pacchiDi(f: FulfillmentLike): number {
  const numeri = new Set<string>();
  for (const t of f.trackingInfo ?? []) {
    const numero = (t?.number ?? '').trim();
    if (numero) numeri.add(numero);
  }
  return Math.max(1, numeri.size);
}

/**
 * I pacchi partiti davvero. Zero se non e' partita nessuna spedizione: il
 * calcolo del costo poi decide cosa vuol dire zero su un ordine spedito
 * (`effectivePackageCount`), qui si conta e basta.
 */
export function countShippedPackages(fulfillments: ReadonlyArray<FulfillmentLike | null> | null | undefined): number {
  if (!fulfillments) return 0;
  let totale = 0;
  for (const f of fulfillments) {
    if (f != null && PARTITA.has((f.status ?? '').toUpperCase())) totale += pacchiDi(f);
  }
  return totale;
}
