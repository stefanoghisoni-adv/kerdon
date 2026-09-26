// app/lib/shipping/order-logistics-facts.ts
//
// I fatti logistici di un ordine — pacchi partiti, reso, opzione di
// spedizione — dalla forma in cui li consegna GraphQL.
//
// UN SOLO ALGORITMO. La sincronizzazione a pagine, il webhook (che rilegge
// l'ordine con la stessa query) e il recupero dello storico
// (getOrderShippingFacts) passano tutti di qui, con gli stessi campi
// (LOGISTICS_FACTS_FIELDS). Se contassero in modo diverso, il costo di un
// ordine dipenderebbe da chi l'ha scritto per ultimo.
//
// SCONOSCIUTO NON E' ZERO. GraphQL puo' rispondere 200 con un campo nullo dove
// lo schema promette un valore: dati oscurati (Protected Customer Data), un
// campo non chiesto, un elenco non completato. Qui un campo cosi' diventa
// "sconosciuto" (`unknown`), e chi scrive lascia intatto il valore gia'
// salvato invece di sovrascriverlo con zero o NULL. Le regole, tutte sui campi
// che lo schema 2026-07 dichiara non nulli:
// - `fulfillments` ([Fulfillment!]!) non e' una lista, oppure una spedizione ha
//   `status` (FulfillmentStatus!) o `trackingInfo` ([FulfillmentTrackingInfo!]!)
//   non valorizzati: pacchi sconosciuti;
// - `returns` (ReturnConnection!) o i suoi `nodes` nulli, pagine non esaurite
//   (`hasNextPage` ancora vero), o un reso valido senza `createdAt`: reso
//   sconosciuto;
// - `shippingLines` (ShippingLineConnection!) o i suoi `nodes` nulli, o un
//   titolo (String!) nullo: opzione sconosciuta. Una stringa vuota invece e'
//   un dato: nessuna opzione.
// Un errore GraphQL vero (`errors` nella risposta) non arriva fin qui: il
// client solleva, e non si scrive niente.

import { countShippedPackages, type FulfillmentLike } from './package-count';

/**
 * Spedizioni chieste nella query d'elenco e nel lotto del recupero.
 *
 * `fulfillments` e' una lista con `first`, non una connessione: non si pagina.
 * Dieci per ordine tengono basso il costo di una pagina da 50 ordini; un
 * ordine che ne ha dieci o piu' si rilegge da solo con FULFILLMENTS_MAX.
 */
export const FULFILLMENTS_FIRST = 10;

/**
 * Il massimo che `first` accetta su una lista dell'Admin API (250). Oltre non
 * si puo' leggere: l'ordine si conta su 250 spedizioni e lo si scrive nei log.
 */
export const FULFILLMENTS_MAX = 250;

/** Resi nella prima pagina: e' una connessione, oltre si pagina. */
export const RETURNS_FIRST = 5;

/**
 * La versione dell'algoritmo dei fatti logistici scritta su
 * `orders.logistics_facts_version`. Si alza quando cambia il modo di contare:
 * il recupero dello storico rilegge una volta sola gli ordini scritti con una
 * versione precedente (o senza versione).
 *
 * 1: pacchi dai tracking distinti per spedizione, reso solo se OPEN o CLOSED
 *    (data del primo), nessun troncamento silenzioso.
 */
export const LOGISTICS_FACTS_VERSION = 1;

/** I campi GraphQL che servono ai fatti, uguali per ogni strada. */
export const LOGISTICS_FACTS_FIELDS = `
    fulfillments(first: ${FULFILLMENTS_FIRST}) { status trackingInfo { number } }
    returns(first: ${RETURNS_FIRST}) { pageInfo { hasNextPage endCursor } nodes { status createdAt } }
    shippingLines(first: 1) { nodes { title } }`;

export interface GqlReturnNode {
  status: string | null;
  createdAt: string | null;
}

/** La parte di un ordine GraphQL che serve ai fatti. */
export interface GqlLogisticsNode {
  fulfillments?: ReadonlyArray<FulfillmentLike | null> | null;
  returns?: {
    pageInfo?: { hasNextPage: boolean; endCursor: string | null } | null;
    nodes: ReadonlyArray<GqlReturnNode> | null;
  } | null;
  shippingLines?: { nodes: ReadonlyArray<{ title: string | null }> | null } | null;
}

export type LogisticsFactField = 'fulfillments' | 'returns' | 'shippingLines';

export interface OrderLogisticsFacts {
  /** Pacchi partiti; null = sconosciuto. */
  packageCount: number | null;
  /** Almeno un numero di tracking su una spedizione qualsiasi; null = sconosciuto. */
  tracked: boolean | null;
  /** Data del primo reso OPEN o CLOSED, null se non ce n'e' (o se sconosciuto: vedi `unknown`). */
  returnedAt: string | null;
  /** Titolo della prima shipping line, null se non c'e' (o se sconosciuto: vedi `unknown`). */
  shippingMethod: string | null;
  /** I gruppi di campi che non si sono potuti leggere. Vuoto = tutto noto. */
  unknown: LogisticsFactField[];
}

/**
 * Gli stati di un reso che fanno pagare il rientro (DEC-02): OPEN (in corso,
 * la merce e' in viaggio o sta per esserlo) e CLOSED (completato). REQUESTED
 * non e' ancora stato accettato, DECLINED e CANCELED non avverranno.
 */
const RESO_VALIDO = new Set(['OPEN', 'CLOSED']);

function istante(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/**
 * La data da scrivere in `returned_at`: `createdAt` del reso OPEN o CLOSED
 * piu' vecchio. Il primo e non l'ultimo perche' `returned_at` dice da quando
 * l'ordine e' "reso", e un secondo reso sullo stesso ordine non ne sposta
 * l'inizio; il costo del rientro si conta comunque una volta per ordine.
 * `createdAt` e non `closedAt` perche' un reso OPEN non e' ancora chiuso, e le
 * due date devono avere lo stesso significato per ogni stato.
 *
 * null se nessun reso qualifica: un reso OPEN poi annullato sparisce alla
 * lettura successiva, e con lui il costo.
 */
export function qualifyingReturnAt(nodes: ReadonlyArray<GqlReturnNode>): string | null {
  let primo: string | null = null;
  for (const r of nodes) {
    if (!RESO_VALIDO.has((r.status ?? '').toUpperCase()) || !r.createdAt) continue;
    if (primo === null || istante(r.createdAt) < istante(primo)) primo = r.createdAt;
  }
  return primo;
}

function spedizioniLeggibili(f: GqlLogisticsNode['fulfillments']): f is ReadonlyArray<FulfillmentLike | null> {
  if (!Array.isArray(f)) return false;
  return f.every(
    (s) => s != null && typeof s.status === 'string' && Array.isArray(s.trackingInfo),
  );
}

export function deriveOrderLogisticsFacts(o: GqlLogisticsNode): OrderLogisticsFacts {
  const unknown: LogisticsFactField[] = [];

  let packageCount: number | null = null;
  let tracked: boolean | null = null;
  if (spedizioniLeggibili(o.fulfillments)) {
    packageCount = countShippedPackages(o.fulfillments);
    tracked = o.fulfillments.some((f) => (f?.trackingInfo ?? []).some((t) => !!t?.number?.trim()));
  } else {
    unknown.push('fulfillments');
  }

  let returnedAt: string | null = null;
  const resi = o.returns?.nodes;
  if (
    !Array.isArray(resi) ||
    o.returns?.pageInfo?.hasNextPage === true ||
    resi.some((r) => RESO_VALIDO.has((r?.status ?? '').toUpperCase()) && !r.createdAt)
  ) {
    unknown.push('returns');
  } else {
    returnedAt = qualifyingReturnAt(resi);
  }

  let shippingMethod: string | null = null;
  const righe = o.shippingLines?.nodes;
  if (!Array.isArray(righe) || (righe.length > 0 && typeof righe[0]?.title !== 'string')) {
    unknown.push('shippingLines');
  } else {
    // La prima riga decide: il costo si abbina a un'opzione sola, e un ordine
    // con piu' shipping line e' raro. Un titolo vuoto non abbina niente,
    // quindi vale come assente.
    shippingMethod = righe[0]?.title || null;
  }

  return { packageCount, tracked, returnedAt, shippingMethod, unknown };
}

/**
 * I fatti di un ordine come li usa il recupero dello storico.
 *
 * - `found` false: l'ordine non c'e' piu' su Shopify (nodo nullo).
 * - `method`: '' = nessuna opzione (sentinella), null = sconosciuta.
 * - `packageCount`: null = sconosciuto.
 * - `returnedAt` vale solo con `returnsKnown`.
 */
export interface OrderShippingFacts {
  found: boolean;
  method: string | null;
  packageCount: number | null;
  returnedAt: string | null;
  returnsKnown: boolean;
}

export const ORDINE_NON_TROVATO: OrderShippingFacts = {
  found: false,
  method: '',
  packageCount: null,
  returnedAt: null,
  returnsKnown: false,
};

/** Dai fatti derivati alla forma del recupero. */
export function toShippingFacts(f: OrderLogisticsFacts): OrderShippingFacts {
  return {
    found: true,
    method: f.unknown.includes('shippingLines') ? null : (f.shippingMethod ?? ''),
    packageCount: f.unknown.includes('fulfillments') ? null : f.packageCount,
    returnedAt: f.unknown.includes('returns') ? null : f.returnedAt,
    returnsKnown: !f.unknown.includes('returns'),
  };
}
