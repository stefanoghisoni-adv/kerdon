/**
 * Il dettaglio di una sincronizzazione: non quanti prodotti e clienti sono
 * passati, ma quali.
 *
 * Logica pura, senza database: il raccoglitore accumula in memoria mentre la
 * corsa avanza e viene svuotato una volta sola, alla fine (vedi
 * job-events.server.ts). Cosi' il dettaglio non aggiunge una scrittura per ogni
 * riga sincronizzata.
 */

export type SyncEventEntity = 'product' | 'customer' | 'order';

// Prodotti: 'added' | 'removed'. Clienti: 'added' | 'updated' | 'suspended'.
// Ordini: 'added' | 'updated' — non si cancellano e non si sospendono, al
// massimo cambiano stato.
export type SyncEventAction = 'added' | 'removed' | 'updated' | 'suspended';

/**
 * Quello che il processor sa al momento in cui l'evento accade. Gli id arrivano
 * come number (e' cosi' che Shopify li restituisce) e vengono normalizzati qui.
 *
 * L'entita' e' `'product'` e basta, e non e' una dimenticanza: dei clienti si
 * tiene solo il conteggio (vedi `count`), quindi una riga di dettaglio per un
 * cliente non deve poter essere nemmeno scritta. Qui il compilatore la ferma.
 */
export interface SyncEventDraft {
  entity: 'product';
  action: SyncEventAction;
  shopifyId?: number | bigint | null;
  variantId?: number | bigint | null;
  label: string;
  sublabel?: string | null;
}

/** La stessa riga, pronta per SyncJobEvent. */
export interface SyncEventRow {
  entity: SyncEventEntity;
  action: SyncEventAction;
  shopifyId: bigint | null;
  variantId: bigint | null;
  label: string;
  sublabel: string | null;
}

export interface SyncEventCounters {
  productsAdded: number;
  productsRemoved: number;
  customersAdded: number;
  customersUpdated: number;
  customersSuspended: number;
}

/**
 * Quante righe di dettaglio si conservano per categoria e per corsa. Il tetto
 * vale sulle righe salvate, NON sui contatori: chi legge deve poter scrivere
 * "mostrate 500 di 3.412", e per farlo il totale vero serve intero.
 */
export const MAX_EVENTS_PER_ENTITY = 500;

/**
 * Per quante corse si conserva il dettaglio. La tab Logs mostra le ultime 20
 * (MAX_JOBS in app/routes/logs.tsx): oltre quelle nessuno puo' piu' aprire il
 * dettaglio, quindi tenerlo significherebbe solo occupare spazio.
 */
export const MAX_JOBS_WITH_DETAIL = 20;

export interface SyncEventBuffer {
  /** Registra un evento: conta sempre, salva finche' c'e' spazio. */
  add(draft: SyncEventDraft): void;
  /**
   * Registra soltanto il conteggio, senza nessuna riga di dettaglio.
   *
   * E' la via dei clienti. Il registro delle sincronizzazioni vive sul database
   * dell'applicazione, e li' i dati dei clienti del merchant non devono
   * arrivare: ne' il nome — per Shopify dato protetto di livello 2 — ne'
   * l'identificativo Shopify, che a una persona resta comunque riferibile.
   * L'informativa dichiara che quei dati "vivono nel progetto database del
   * merchant" e il DPA elenca fra i dati trattati da noi solo configurazione,
   * credenziali e registri: una riga per cliente contraddirebbe entrambi.
   *
   * Il merchant perde un dettaglio — sa quanti clienti sono cambiati, non chi —
   * e lo ritrova nel proprio database, che e' dove abbiamo promesso che stesse.
   */
  count(entity: SyncEventEntity, action: SyncEventAction): void;
  /** Assorbe un altro raccoglitore (contatori sommati, righe accodate). */
  absorb(other: SyncEventBuffer): void;
  /** Le righe tenute finora, senza svuotare. */
  pending(): SyncEventRow[];
  /** Le righe tenute finora, svuotando: chi le prende se ne fa carico. */
  drain(): SyncEventRow[];
  counters(): SyncEventCounters;
}

function emptyCounters(): SyncEventCounters {
  return {
    productsAdded: 0,
    productsRemoved: 0,
    customersAdded: 0,
    customersUpdated: 0,
    customersSuspended: 0,
  };
}

/**
 * Gli id Shopify stanno su colonne BigInt. Un valore che non e' un intero non e'
 * un id: meglio una riga senza id che una conversione che lancia in mezzo a una
 * sincronizzazione.
 */
function toBigIntOrNull(value: number | bigint | null | undefined): bigint | null {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  if (!Number.isInteger(value)) return null;
  return BigInt(value);
}

function toRow(draft: SyncEventDraft): SyncEventRow {
  return {
    entity: draft.entity,
    action: draft.action,
    shopifyId: toBigIntOrNull(draft.shopifyId),
    variantId: toBigIntOrNull(draft.variantId),
    label: draft.label,
    sublabel: draft.sublabel ?? null,
  };
}

export function createEventBuffer(
  maxPerEntity: number = MAX_EVENTS_PER_ENTITY,
): SyncEventBuffer {
  const rows: SyncEventRow[] = [];
  const counters = emptyCounters();
  // Contate a parte dalle righe in `rows`: drain() svuota l'array, ma il tetto
  // deve continuare a valere sull'intera corsa, non ripartire da zero.
  const kept: Record<SyncEventEntity, number> = { product: 0, customer: 0, order: 0 };

  function tally(entity: SyncEventEntity, action: SyncEventAction): void {
    if (entity === 'product') {
      if (action === 'added') counters.productsAdded++;
      else if (action === 'removed') counters.productsRemoved++;
      return;
    }
    if (action === 'added') counters.customersAdded++;
    else if (action === 'updated') counters.customersUpdated++;
    else if (action === 'suspended') counters.customersSuspended++;
  }

  function keep(row: SyncEventRow): void {
    if (kept[row.entity] >= maxPerEntity) return;
    kept[row.entity]++;
    rows.push(row);
  }

  return {
    add(draft) {
      const row = toRow(draft);
      tally(row.entity, row.action);
      keep(row);
    },
    count(entity, action) {
      tally(entity, action);
    },
    absorb(other) {
      const incoming = other.counters();
      counters.productsAdded += incoming.productsAdded;
      counters.productsRemoved += incoming.productsRemoved;
      counters.customersAdded += incoming.customersAdded;
      counters.customersUpdated += incoming.customersUpdated;
      counters.customersSuspended += incoming.customersSuspended;
      // Le righe arrivano gia' contate: qui si accodano soltanto.
      for (const row of other.pending()) keep(row);
    },
    pending() {
      return [...rows];
    },
    drain() {
      return rows.splice(0, rows.length);
    },
    counters() {
      return { ...counters };
    },
  };
}

/**
 * Etichetta di una riga prodotto. Il titolo puo' mancare sulle righe rimosse
 * (colonna letta da un database che non controlliamo): l'id resta comunque
 * un'informazione utile a chi legge il dettaglio.
 */
export function formatProductLabel(row: {
  product_title?: string | null;
  shopify_product_id?: number | null;
}): string {
  const title = row.product_title?.trim();
  if (title) return title;
  return row.shopify_product_id != null
    ? `Prodotto ${row.shopify_product_id}`
    : 'Prodotto senza titolo';
}
