// app/lib/shipping/package-count.ts
//
// Quanti pacchi ha spedito un ordine, e se e' partito, dalle spedizioni
// (fulfillment) che Shopify ha registrato.
//
// LA REGOLA (decisione del merchant owner): IL TRACKING FA FEDE.
// - Una spedizione con almeno un numero di tracking non vuoto conta, QUALUNQUE
//   sia il suo stato, CANCELLED, ERROR e FAILURE compresi. Porta tanti pacchi
//   quanti sono i suoi numeri di tracking DISTINTI (spazi attorno tolti: " A "
//   e "A" sono lo stesso collo; stringhe vuote ignorate). Perche': un numero
//   di tracking vuol dire che il pacco e' stato preparato e consegnato al
//   corriere, quindi il costo c'e' stato, anche se poi la spedizione e' stata
//   annullata, dirottata o e' tornata indietro. Il multi-collo e' il motivo
//   per cui `trackingInfo` e' una lista.
// - Una spedizione SENZA tracking vale un pacco solo se e' partita davvero
//   (FulfillmentStatus SUCCESS, piu' OPEN e PENDING, deprecati ma ancora
//   possibili sugli ordini vecchi; verificato sulla 2026-07). Senza tracking,
//   CANCELLED, ERROR, FAILURE o uno stato sconosciuto valgono zero: niente
//   prova che il pacco sia uscito.
// - Il conteggio e' per spedizione: lo stesso numero su due spedizioni
//   diverse conta due volte, perche' Shopify non dice che sia lo stesso collo.
// - L'ordine e' spedito se una spedizione qualsiasi ha un tracking, o se una
//   e' SUCCESS, OPEN o PENDING (orderShipped). Un ordine spedito con zero
//   pacchi contati ne paga comunque uno (effectivePackageCount).
//
// In un file suo perche' lo usano tutte le strade che scrivono pacchi e stato
// — la sincronizzazione, il webhook e il recupero dello storico, attraverso
// deriveOrderLogisticsFacts — e devono contare allo stesso modo. Il ricalcolo
// legge i valori che loro hanno scritto.

/** Gli stati di una spedizione partita davvero. */
export const SHIPPED_FULFILLMENT_STATUSES = ['SUCCESS', 'OPEN', 'PENDING'] as const;

const PARTITA = new Set<string>(SHIPPED_FULFILLMENT_STATUSES);

/** Una spedizione come arriva da Shopify: stato e numeri di tracking. */
export interface FulfillmentLike {
  status?: string | null;
  trackingInfo?: ReadonlyArray<{ number?: string | null } | null> | null;
}

/** La spedizione e' partita davvero per stato (SUCCESS, OPEN, PENDING)? */
export function isShippedFulfillment(f: FulfillmentLike): boolean {
  return PARTITA.has((f.status ?? '').toUpperCase());
}

/** I numeri di tracking distinti e non vuoti di una spedizione. */
function trackingDistinti(f: FulfillmentLike): number {
  const numeri = new Set<string>();
  for (const t of f.trackingInfo ?? []) {
    const numero = (t?.number ?? '').trim();
    if (numero) numeri.add(numero);
  }
  return numeri.size;
}

/** I pacchi di una spedizione, secondo la regola in testa al file. */
export function packagesOfFulfillment(f: FulfillmentLike): number {
  const tracking = trackingDistinti(f);
  if (tracking > 0) return tracking;
  return isShippedFulfillment(f) ? 1 : 0;
}

/**
 * I pacchi dell'ordine. Zero se nessuna spedizione conta: il calcolo del
 * costo poi decide cosa vuol dire zero su un ordine spedito
 * (`effectivePackageCount`), qui si conta e basta.
 */
export function countShippedPackages(fulfillments: ReadonlyArray<FulfillmentLike | null> | null | undefined): number {
  if (!fulfillments) return 0;
  let totale = 0;
  for (const f of fulfillments) {
    if (f != null) totale += packagesOfFulfillment(f);
  }
  return totale;
}

/**
 * L'ordine e' partito? Si' se una spedizione ha un tracking (qualunque stato)
 * o se una e' SUCCESS, OPEN o PENDING.
 */
export function orderShipped(fulfillments: ReadonlyArray<FulfillmentLike | null> | null | undefined): boolean {
  if (!fulfillments) return false;
  return fulfillments.some((f) => f != null && (trackingDistinti(f) > 0 || isShippedFulfillment(f)));
}
