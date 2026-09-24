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
// conto chiuso: tengono il costo con cui erano state calcolate, qualunque cosa
// succeda al costo di listino.
//
// E QUANDO UN COSTO PRIMA NON C'ERA? Allora non si ferma niente. Fermare
// l'assenza sembrava la scelta coerente — "quelle vendite sono sempre state
// senza costo, restano senza" — ed era invece il modo di renderle invisibili
// per sempre: la riga restava senza valore ma marcata come "conto chiuso", e da
// li' in poi nessun costo inserito poteva piu' rientrarci. Il merchant
// compilava il costo che l'app gli chiedeva di compilare, tornava sui clienti e
// trovava di nuovo profitto zero, senza niente da premere per cambiarlo.
//
// Il congelamento esiste per proteggere un costo PRECEDENTE REALE (ho comprato
// a 3, adesso compro a 5: le vendite vecchie restano a 3). Dove quel costo non
// c'e', non c'e' niente da proteggere e non c'e' nemmeno una scelta da fare: le
// due strade portano allo stesso posto, e quelle righe prendono il costo nuovo
// come tutte le altre.
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

/**
 * Cosa comporta la scelta, viste anche le righe su cui cadrebbe.
 *
 * `previousCost` non e' un parametro di comodo ed e' obbligatorio apposta: senza
 * di lui questa funzione rispondeva "congela" anche quando non c'era niente da
 * congelare, e chi chiamava non aveva modo di accorgersene. Il risultato era una
 * riga con `unit_cost_frozen_at` valorizzato e nessun costo dentro: una vendita
 * dichiarata "gia' contata" che dal profitto era esclusa per sempre.
 *
 * Quindi `future` congela solo dove c'e' un costo utilizzabile da conservare.
 * Dove non c'e', non fa niente — ed e' la cosa giusta da fare, non una
 * rinuncia: quelle righe non hanno un passato da difendere e seguono il costo
 * di listino, che fra un istante sara' quello appena inserito.
 */
export function costScopeEffect(scope: CostScope, previousCost: unknown): CostScopeEffect {
  if (scope === 'all') return { freezeExisting: false, clearFrozen: true };
  return { freezeExisting: costToFreeze(previousCost) !== null, clearFrozen: false };
}

/**
 * C'e' davvero qualcosa da chiedere al merchant?
 *
 * La domanda "fin dove arriva questo costo" ha senso finche' una delle due
 * risposte cambia i numeri che ha gia' letto. Se nessuna delle varianti che sta
 * salvando aveva un costo, non c'e' nessun numero da proteggere: le due risposte
 * fanno la stessa cosa, e un dialogo che chiede di scegliere fra due esiti
 * identici e' solo un passaggio in piu' — per giunta insinuando che qualcosa
 * possa andare storto a seconda di come si risponde.
 */
export function needsCostScopeChoice(previousCosts: unknown[]): boolean {
  return previousCosts.some((costo) => costToFreeze(costo) !== null);
}

/**
 * Il valore da fissare sulle righe gia' scritte.
 *
 * E' il costo che quelle righe stavano usando fino a un istante fa, cioe' il
 * costo del prodotto PRIMA della modifica — mai quello nuovo.
 *
 * `null` non e' "fissa l'assenza": e' "non c'e' niente da fissare", ed e' il
 * motivo per cui `costScopeEffect` lo interroga prima di decidere se congelare.
 * Fissare un'assenza scriveva la data del congelamento su una riga senza
 * valore, e quella riga spariva dal profitto per sempre.
 *
 * Il numero non si arrotonda e non si corregge: o e' un costo utilizzabile, o
 * non e' niente. Un valore fuori scala trattato come zero direbbe che quella
 * merce era gratis.
 */
export function costToFreeze(previousCost: unknown): number | null {
  if (previousCost === null || previousCost === undefined || previousCost === '') return null;
  const numero = Number(previousCost);
  if (!Number.isFinite(numero) || numero < 0) return null;
  return numero;
}
