// app/lib/products/cost-scope.ts
//
// Fin dove arriva la modifica di un costo.
//
// IL PROBLEMA. Il costo del prodotto non e' un dato storico: si legge dai
// prodotti nel momento in cui si guarda, quindi correggerlo oggi riscrive il
// profitto di sei mesi fa. Il merchant vede cambiare numeri che aveva gia'
// letto, gia' esportato, gia' usato per decidere — e non ha chiesto niente del
// genere: ha solo corretto un costo.
//
// PERCHE' NON SI PUO' SEMPLICEMENTE "TENERE LO STORICO". Perche' lo storico dei
// costi non ce l'ha nessuno. Shopify conserva il costo ATTUALE
// (`InventoryItem.unitCost`) e basta: quanto costava quel prodotto il giorno di
// un ordine di marzo non e' scritto da nessuna parte, ne' da noi ne' da loro.
// Ricostruirlo vorrebbe dire inventarlo, e un margine inventato e' peggio di un
// margine mancante — il secondo si vede, il primo no.
//
// COSA SI PUO' FARE ONESTAMENTE. Fermare il valore in uso nel momento in cui si
// decide di cambiarlo. Da quel momento le righe d'ordine gia' scritte hanno il
// conto chiuso: tengono il costo con cui erano state calcolate, e se un costo
// non ce l'avevano restano senza — fuori dal profitto, come sono sempre state,
// invece di adottarne uno deciso dopo.
//
// LE DUE STRADE, come le vede il merchant:
//
//  - `future`: il costo nuovo vale da adesso in avanti. Gli ordini gia'
//    registrati non cambiano.
//  - `all`: il costo nuovo vale anche per il passato. E' il comportamento che
//    c'e' sempre stato, e resta disponibile perche' e' quello giusto quando il
//    costo di prima era semplicemente sbagliato.

/** Le due strade fra cui il merchant sceglie. */
export type CostScope = 'future' | 'all';

/**
 * La scelta non ha un valore predefinito, e non e' una dimenticanza.
 *
 * Un valore predefinito qui vorrebbe dire decidere al posto suo che cosa
 * succede ai numeri che ha gia' letto. Se la richiesta non porta una scelta
 * riconoscibile, la si rifiuta invece di indovinare.
 */
export function isCostScope(value: unknown): value is CostScope {
  return value === 'future' || value === 'all';
}

/** Cosa comporta la scelta, per le righe d'ordine gia' scritte. */
export interface CostScopeEffect {
  /**
   * Chiudere il conto sulle righe non ancora fissate: da qui in poi tengono il
   * costo che avevano, qualunque cosa succeda a quello del prodotto.
   */
  freezeExisting: boolean;
  /**
   * Riaprire il conto: le righe tornano a seguire il costo corrente, cioe' il
   * comportamento di sempre.
   */
  clearFrozen: boolean;
}

export function costScopeEffect(scope: CostScope): CostScopeEffect {
  return scope === 'future'
    ? { freezeExisting: true, clearFrozen: false }
    : { freezeExisting: false, clearFrozen: true };
}

/**
 * Il valore da fissare sulle righe gia' scritte.
 *
 * E' il costo che quelle righe stavano usando fino a un istante fa, cioe' il
 * costo del prodotto PRIMA della modifica — mai quello nuovo. Se prima non
 * c'era, non c'e' niente da fissare e si fissa l'assenza: quelle vendite sono
 * sempre state senza costo, e restano senza.
 *
 * Il numero non si arrotonda e non si corregge: o e' un costo utilizzabile, o
 * e' un'assenza. Un valore fuori scala trattato come zero direbbe che quella
 * merce era gratis.
 */
export function costToFreeze(previousCost: unknown): number | null {
  if (previousCost === null || previousCost === undefined || previousCost === '') return null;
  const numero = Number(previousCost);
  if (!Number.isFinite(numero) || numero < 0) return null;
  return numero;
}
