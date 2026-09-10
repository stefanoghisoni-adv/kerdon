// app/lib/sync/product-scope.ts
//
// Chi resta dentro l'ambito della sincronizzazione quando il piano ha un tetto,
// e perche' il tetto non e' mai un permesso di cancellare.
//
// IL GUASTO DA CUI NASCE QUESTO FILE. La corsa completa smetteva di impaginare
// appena raggiungeva il tetto di prodotti del piano, e poi eseguiva lo stesso la
// spazzata globale — "via tutte le righe che questa corsa non ha riscritto".
// Ma tutto cio' che stava oltre il tetto non era stato riscritto perche' non era
// nemmeno stato guardato: risultava vecchio, e spariva. Un negozio che passava a
// un piano piu' piccolo non perdeva l'aggiornamento dei prodotti in eccedenza,
// perdeva i prodotti. E la pagina dei piani intanto prometteva l'esatto
// contrario.
//
// LA POLITICA, IN UNA RIGA. Il tetto decide quali risorse CONTINUANO a essere
// aggiornate, non quali esistono. Le eccedenti si marcano fuori ambito: le loro
// righe restano dove sono, ferme, e l'interfaccia dice da quando.
//
// DUE COSE CHE SEMBRAVANO UNA SOLA. "L'impaginazione e' finita" e "mi sono
// fermato per la quota" davano lo stesso risultato al codice che spazzava, e
// sono opposte: nel primo caso quel che non e' stato riscritto non esiste piu'
// su Shopify, nel secondo non e' stato nemmeno chiesto. La spazzata globale
// vale solo nel primo.
//
// PERCHE' LA SCELTA DEV'ESSERE DETERMINISTICA. Perche' altrimenti dipende
// dall'ordine in cui arrivano le pagine, e l'ordine in cui arrivano le pagine
// non e' una cosa che il merchant sceglie: due corse dello stesso catalogo con
// lo stesso piano darebbero due sottoinsiemi diversi, e a ogni giro qualcosa
// entrerebbe e qualcos'altro si fermerebbe. Qui la graduatoria e' totale — data
// di creazione su Shopify, e a parita' l'id — quindi "i primi N" e' lo stesso
// insieme comunque siano arrivati.

/**
 * Quante pagine di prodotti una corsa completa accetta di scorrere.
 *
 * Serve a due cose insieme. La prima e' il tempo: una corsa gira dentro una
 * funzione che prima o poi viene interrotta, e un catalogo smisurato la
 * porterebbe a essere uccisa sempre nello stesso punto, senza mai chiudersi.
 * La seconda e' che un cursore che non finisce mai — un difetto dell'API, un
 * token che si ripete — diventerebbe un anello infinito che nessuno interrompe.
 *
 * Fermarsi qui NON e' finire l'impaginazione, ed e' il motivo per cui le due
 * cose sono diventate due variabili distinte: quel che sta oltre non e' stato
 * guardato, quindi non e' spazzabile.
 *
 * Duecentocinquanta prodotti a pagina: quattrocento pagine sono centomila
 * prodotti, cioe' molto oltre il piu' capiente dei piani con tetto.
 */
export const MAX_PRODUCT_PAGES = 400;

/** Perche' una risorsa e' dentro o fuori dall'ambito. */
export type ProductScopeReason = 'in_scope' | 'plan_quota';

/**
 * Un prodotto visto da questa corsa, ridotto a cio' che serve a metterlo in
 * graduatoria. Non porta il corpo del prodotto di proposito: di un catalogo
 * intero se ne tengono in memoria decine di migliaia, e due campi si possono
 * tenere, un prodotto con le sue varianti no.
 */
export interface ScopeCandidate {
  productId: number;
  /** `created_at` come lo scrive Shopify. Assente su risorse molto vecchie. */
  createdAt?: string | null;
}

/**
 * La graduatoria: dal piu' vecchio al piu' recente, e a parita' l'id piu'
 * basso.
 *
 * E' la stessa di `sortByCreatedAtAsc`, e non e' un caso: quello decide in che
 * ordine la quota viene spesa, questo decide chi la quota se la tiene. Se
 * fossero due ordini diversi, la corsa scriverebbe un insieme e il registro ne
 * dichiarerebbe un altro.
 *
 * Le date ISO si confrontano come testo — stesso ordine del tempo, senza
 * passare da `Date` e senza NaN se il formato non fosse quello atteso. Una data
 * assente vale stringa vuota, cioe' "vecchissimo": un prodotto senza data di
 * creazione e' un prodotto che c'e' da prima che Shopify la scrivesse, e
 * trattarlo come nuovo lo butterebbe fuori dall'ambito a ogni corsa.
 */
export function compareScopeRank(a: ScopeCandidate, b: ScopeCandidate): number {
  const left = a.createdAt ?? '';
  const right = b.createdAt ?? '';
  if (left !== right) return left < right ? -1 : 1;
  return a.productId - b.productId;
}

/** L'esito della scelta: chi resta dentro e chi si ferma per la quota. */
export interface ScopeDecision {
  inScope: ScopeCandidate[];
  outOfQuota: ScopeCandidate[];
}

/**
 * Chi sta dentro l'ambito, dato tutto quello che c'e' su Shopify.
 *
 * `limit` nullo e' il piano senza tetto: sono dentro tutti, e non c'e' nessuna
 * eccedenza da marcare.
 *
 * I doppioni si riducono a uno prima di decidere: la stessa risorsa vista in
 * due pagine e' una risorsa sola, e contarla due volte consumerebbe due posti
 * di quota per un prodotto solo.
 */
export function decideProductScope(
  candidates: readonly ScopeCandidate[],
  limit: number | null | undefined,
): ScopeDecision {
  const unici = new Map<number, ScopeCandidate>();
  for (const candidato of candidates) {
    const esistente = unici.get(candidato.productId);
    // A parita' di id vince la data piu' vecchia: se due letture della stessa
    // risorsa non concordano, quella che la fa entrare e' la piu' prudente —
    // togliere l'ambito a chi ce l'ha significa fermare dei dati.
    if (!esistente || compareScopeRank(candidato, esistente) < 0) {
      unici.set(candidato.productId, candidato);
    }
  }

  const ordinati = [...unici.values()].sort(compareScopeRank);
  if (limit == null) return { inScope: ordinati, outOfQuota: [] };

  const tetto = Math.max(0, limit);
  return {
    inScope: ordinati.slice(0, tetto),
    outOfQuota: ordinati.slice(tetto),
  };
}

/** Cosa e' successo offrendo un candidato al selettore. */
export interface ScopeOffer {
  /** Il candidato e' dentro l'ambito: va scritto. */
  admitted: boolean;
  /**
   * Chi ha perso il posto per farglielo. Nullo quasi sempre: succede solo se le
   * pagine arrivano fuori ordine e ne arriva una piu' vecchia a quota gia'
   * piena.
   */
  displaced: ScopeCandidate | null;
}

/**
 * La quota mentre la corsa e' ancora in mezzo alle pagine.
 *
 * PERCHE' NON BASTA `decideProductScope` DA SOLA. Perche' quella vuole l'elenco
 * completo, e l'elenco completo lo si ha solo alla fine — mentre la scrittura
 * deve poter avvenire pagina per pagina, altrimenti bisognerebbe tenere in
 * memoria un catalogo intero o impaginarlo due volte.
 *
 * PERCHE' IL RISULTATO E' LO STESSO. Perche' "tieni i migliori N" applicato a
 * uno per volta, con lo scarto del peggiore quando si sfora, da' esattamente i
 * migliori N dell'insieme completo — comunque siano arrivati. E' la stessa
 * proprieta' su cui poggia la determinatezza: l'ordine delle pagine non cambia
 * chi resta.
 *
 * Uno scarto costa una scrittura inutile (la risorsa era gia' stata scritta
 * quando era entrata), mai una cancellazione: le righe di chi esce dall'ambito
 * restano dove sono. E' il motivo per cui si puo' decidere in corsa senza
 * rischiare niente.
 */
export interface ScopeSelector {
  offer(candidate: ScopeCandidate): ScopeOffer;
  /** Chi e' dentro adesso, in graduatoria. */
  chosen(): ScopeCandidate[];
  /** Chi e' stato scartato lungo la strada, in graduatoria. */
  displaced(): ScopeCandidate[];
  /** Quanti posti restano. `null` quando il piano non ha tetto. */
  remaining(): number | null;
}

export function createScopeSelector(
  limit: number | null | undefined,
  seed: readonly ScopeCandidate[] = [],
): ScopeSelector {
  const tetto = limit == null ? null : Math.max(0, limit);
  // Tenuto ordinato per graduatoria: l'ultimo elemento e' sempre il primo a
  // uscire. Con un tetto di qualche centinaio l'inserimento lineare costa meno
  // di qualunque struttura piu' furba, e si legge.
  const dentro: ScopeCandidate[] = [];
  const scartati = new Map<number, ScopeCandidate>();
  const visti = new Set<number>();

  function inserisci(candidato: ScopeCandidate): ScopeOffer {
    if (visti.has(candidato.productId)) {
      // Gia' offerto: la stessa risorsa in due pagine e' una risorsa sola. Si
      // risponde com'era andata la prima volta, senza consumare un secondo
      // posto.
      return {
        admitted: dentro.some((c) => c.productId === candidato.productId),
        displaced: null,
      };
    }
    visti.add(candidato.productId);

    if (tetto === null) {
      dentro.push(candidato);
      return { admitted: true, displaced: null };
    }
    if (tetto === 0) {
      scartati.set(candidato.productId, candidato);
      return { admitted: false, displaced: null };
    }

    let posizione = dentro.length;
    while (posizione > 0 && compareScopeRank(dentro[posizione - 1], candidato) > 0) {
      posizione--;
    }
    dentro.splice(posizione, 0, candidato);

    if (dentro.length <= tetto) return { admitted: true, displaced: null };

    const uscito = dentro.pop() as ScopeCandidate;
    scartati.set(uscito.productId, uscito);
    if (uscito.productId === candidato.productId) {
      // Il candidato era gia' peggiore di tutti: non e' mai entrato davvero, e
      // dire che ha sostituito qualcuno sarebbe falso.
      return { admitted: false, displaced: null };
    }
    return { admitted: true, displaced: uscito };
  }

  for (const candidato of seed) inserisci(candidato);

  return {
    offer: inserisci,
    chosen: () => [...dentro],
    displaced: () =>
      [...scartati.values()].sort(compareScopeRank),
    remaining: () => (tetto === null ? null : Math.max(0, tetto - dentro.length)),
  };
}

/** Le condizioni in cui si puo' spazzare, e quelle in cui non si deve. */
export interface SweepPreconditions {
  /** L'impaginazione di Shopify e' arrivata in fondo davvero. */
  paginationComplete: boolean;
  /** Quanti prodotti sono arrivati con l'elenco delle varianti troncato. */
  productsWithIncompleteVariants: number;
}

export type SweepBlock = 'pagination_incomplete' | 'variants_incomplete';

export type SweepVerdict =
  | { allowed: true }
  | { allowed: false; reason: SweepBlock };

/**
 * Se la spazzata globale si puo' fare.
 *
 * La spazzata poggia tutta su una premessa: "non riscritto adesso" significa
 * "non esiste piu' su Shopify". Ci sono due modi di rendere falsa quella
 * premessa, e finora se ne controllava uno solo.
 *
 * Il primo e' l'elenco delle varianti monco — gia' controllato: le varianti che
 * non abbiamo letto non sono state riscritte pur essendo vivissime.
 *
 * Il secondo e' l'impaginazione interrotta, ed e' quello che costava un
 * catalogo: fermarsi al tetto del piano lascia fuori tutto il resto del
 * negozio, che risulta vecchio senza esserlo. Chiamare quella fermata "fine
 * dell'impaginazione" e' esattamente lo scambio che questo file esiste per
 * impedire.
 */
export function sweepVerdict(pre: SweepPreconditions): SweepVerdict {
  if (!pre.paginationComplete) {
    return { allowed: false, reason: 'pagination_incomplete' };
  }
  if (pre.productsWithIncompleteVariants > 0) {
    return { allowed: false, reason: 'variants_incomplete' };
  }
  return { allowed: true };
}

/** Una riga del registro dell'ambito, come la legge chi deve contarla. */
export interface ScopeEntrySummary {
  productId: number;
  inScope: boolean;
  /**
   * L'ultima volta che questa risorsa e' stata aggiornata mentre era dentro
   * l'ambito. Su una risorsa ferma e' la data del dato che il merchant sta
   * guardando.
   */
  lastInScopeAt?: Date | string | null;
}

/** Quante risorse si aggiornano, quante sono ferme, e da quando. */
export interface ScopeCounts {
  active: number;
  paused: number;
  /**
   * La data del dato piu' recente fra quelli fermi: da li' in poi, di quelle
   * risorse, non si sa piu' niente. Nullo se non c'e' niente di fermo o se
   * nessuna di quelle righe porta una data.
   */
  pausedDataFrom: Date | null;
}

/**
 * I conti che l'interfaccia mostra.
 *
 * Si tengono separati apposta: un totale solo rimetterebbe insieme le due cose
 * che tutto questo lavoro serve a distinguere — dati che si aggiornano e dati
 * che sono fermi. Presentare i secondi insieme ai primi vorrebbe dire spacciare
 * per fresco un numero di sei mesi fa.
 */
export function scopeCounts(entries: readonly ScopeEntrySummary[]): ScopeCounts {
  let active = 0;
  let paused = 0;
  let pausedDataFrom: Date | null = null;

  for (const entry of entries) {
    if (entry.inScope) {
      active++;
      continue;
    }
    paused++;
    if (!entry.lastInScopeAt) continue;
    const quando = new Date(entry.lastInScopeAt);
    if (Number.isNaN(quando.getTime())) continue;
    // La piu' recente fra le ferme: e' la piu' generosa che si possa dire senza
    // mentire — "da qui in avanti non e' stato aggiornato niente".
    if (pausedDataFrom === null || quando.getTime() > pausedDataFrom.getTime()) {
      pausedDataFrom = quando;
    }
  }

  return { active, paused, pausedDataFrom };
}
