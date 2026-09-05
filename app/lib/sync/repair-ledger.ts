// app/lib/sync/repair-ledger.ts
//
// Il registro delle riparazioni di UNA corsa, tenuto in memoria fino al
// momento in cui la corsa si chiude.
//
// PERCHE' IN MEMORIA E NON SCRITTO SUBITO. Perche' il confine incrementale e la
// riparazione devono nascere o morire insieme. Scrivendo ogni riparazione
// appena si scopre, una corsa stroncata a meta' lascerebbe righe di
// riparazione senza il confine che le giustifica; scrivendole tutte insieme al
// confine, nello stesso commit, i due casi possibili sono soltanto due: o la
// corsa ha chiuso — e allora il confine e' avanzato E le riparazioni esistono —
// oppure non ha chiuso, e allora il confine e' rimasto dov'era e la corsa
// successiva riscopre gli stessi guasti da sola. Non c'e' una terza via in cui
// qualcosa si perde.
//
// Nessun import: le regole si provano senza database.

import type { RepairOperation, RepairResourceType } from './failure-taxonomy';

/**
 * Quante riparazioni una corsa puo' aprire prima di essere dichiarata rotta.
 *
 * Oltre questa soglia non e' piu' "qualche risorsa e' andata storta": e' il
 * database del merchant che non risponde, o un permesso che e' cambiato. In
 * quel caso una lista di duecento righe da rilavorare non aiuta nessuno, e la
 * risposta giusta e' far fallire la corsa lasciando il confine dov'era — cosi'
 * la corsa dopo ripassa su tutto invece di inseguire un elenco.
 */
export const MAX_REPAIRS_PER_RUN = 200;

/** Come si nomina una riparazione: e' anche la sua chiave sul database. */
export interface RepairKey {
  resourceType: RepairResourceType;
  /** L'id su Shopify, come testo: gli id di Shopify non stanno in un intero. */
  resourceId: string;
  operation: RepairOperation;
}

export interface RepairDraft extends RepairKey {
  /**
   * Quando la risorsa e' stata modificata su Shopify.
   *
   * E' il dato da cui dipende tutto il resto: e' fin qui che il confine
   * incrementale viene tenuto indietro, ed e' cosi' che la corsa successiva
   * ritrova la risorsa nel delta senza che nessuno debba andarla a ripescare.
   * `null` quando Shopify non l'ha detto: allora il confine si tiene indietro
   * all'inizio della corsa, che e' la scelta prudente.
   */
  sourceUpdatedAt: Date | null;
  /**
   * Cosa serve a ripetere l'operazione, o a capirla guardandola dopo. Per una
   * cancellazione e' l'elenco degli id: si conserva anche quando la
   * riparazione passera' dal delta, perche' e' l'unica traccia di cosa era
   * rimasto indietro.
   */
  details?: Record<string, unknown>;
  /** L'errore, gia' redatto da chi ha chiamato. */
  reason: string;
  /** Se la corsa incrementale successiva ci ripassa da sola. */
  recoveredByDelta: boolean;
}

export interface RepairLedger {
  /** Registra un guasto riparabile. Ripetuto sulla stessa chiave, si fonde. */
  open(draft: RepairDraft): void;
  /** La risorsa e' stata scritta bene: se aveva una riparazione aperta, e' chiusa. */
  resolve(key: RepairKey): void;
  /** Le riparazioni da scrivere, in ordine di apertura. */
  drafts(): RepairDraft[];
  /** Le chiavi da chiudere. */
  resolutions(): RepairKey[];
  /**
   * Troppe: la corsa non ha piu' titolo per dichiararsi parziale, e deve
   * fallire lasciando il confine invariato.
   */
  readonly overflowed: boolean;
}

export function repairKeyOf(key: RepairKey): string {
  return `${key.resourceType}:${key.resourceId}:${key.operation}`;
}

/**
 * Fonde due segnalazioni sulla stessa risorsa e sulla stessa operazione.
 *
 * Due regole, e sono opposte di proposito:
 *
 * - la **data di modifica** si tiene la piu' RECENTE, perche' e' quella che
 *   descrive la risorsa da riportare a posto;
 * - il **confine di una spazzata** si tiene il piu' VECCHIO, perche' una
 *   spazzata rieseguita con un confine piu' vecchio cancella di meno, e fra due
 *   errori possibili quello che cancella di meno e' l'unico accettabile.
 *
 * Gli elenchi di id si uniscono senza doppioni: due pagine possono nominare la
 * stessa riga, e perderne una vorrebbe dire non sapere piu' cosa era rimasto
 * indietro.
 */
export function mergeDrafts(esistente: RepairDraft, nuovo: RepairDraft): RepairDraft {
  const sourceUpdatedAt =
    esistente.sourceUpdatedAt === null || nuovo.sourceUpdatedAt === null
      ? null
      : new Date(Math.max(esistente.sourceUpdatedAt.getTime(), nuovo.sourceUpdatedAt.getTime()));

  return {
    ...nuovo,
    sourceUpdatedAt,
    details: mergeDetails(esistente.details, nuovo.details),
    // Basta che una delle due non torni dal delta perche' la riparazione debba
    // essere spinta: dare per recuperabile qualcosa che non lo e' vorrebbe dire
    // aspettare un evento che non arrivera' mai.
    recoveredByDelta: esistente.recoveredByDelta && nuovo.recoveredByDelta,
  };
}

function mergeDetails(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!a) return b;
  if (!b) return a;

  const fuso: Record<string, unknown> = { ...a, ...b };

  const idsA = Array.isArray(a.ids) ? a.ids : null;
  const idsB = Array.isArray(b.ids) ? b.ids : null;
  if (idsA || idsB) fuso.ids = Array.from(new Set([...(idsA ?? []), ...(idsB ?? [])]));

  // Il confine di una spazzata: il piu' vecchio dei due (vedi mergeDrafts).
  if (typeof a.before === 'string' && typeof b.before === 'string') {
    fuso.before = a.before < b.before ? a.before : b.before;
  }

  return fuso;
}

export function createRepairLedger(): RepairLedger {
  const aperte = new Map<string, RepairDraft>();
  const chiuse = new Map<string, RepairKey>();
  let troppe = false;

  return {
    open(draft) {
      const chiave = repairKeyOf(draft);
      // Chi si e' appena riaperto non e' piu' risolto: succede quando una
      // risorsa viene scritta e poi la sua cancellazione fallisce.
      chiuse.delete(chiave);

      const esistente = aperte.get(chiave);
      if (esistente) {
        aperte.set(chiave, mergeDrafts(esistente, draft));
        return;
      }

      if (aperte.size >= MAX_REPAIRS_PER_RUN) {
        troppe = true;
        return;
      }
      aperte.set(chiave, draft);
    },

    resolve(key) {
      const chiave = repairKeyOf(key);
      // Se in questa stessa corsa la risorsa era stata segnata e poi e'
      // riuscita, la segnalazione non deve sopravvivere al successo.
      aperte.delete(chiave);
      chiuse.set(chiave, key);
    },

    drafts() {
      return [...aperte.values()];
    },

    resolutions() {
      return [...chiuse.values()];
    },

    get overflowed() {
      return troppe;
    },
  };
}

/** Una riparazione gia' sul database, per quel che serve a decidere. */
export interface OpenRepair extends RepairKey {
  id: string;
  sourceUpdatedAt: Date | null;
  attempts: number;
  nextAttemptAt: Date;
  recoveredByDelta: boolean;
}

/**
 * Fin dove il confine incrementale va tenuto indietro.
 *
 * Prende le riparazioni ancora aperte — quelle di questa corsa e quelle che
 * erano gia' li' — e restituisce la piu' vecchia data di modifica fra quelle
 * che il delta puo' riportare. Da quel punto in avanti la corsa successiva
 * rilegge, e ritrova la risorsa senza che nessuno debba andarla a cercare.
 *
 * Le riparazioni che il delta NON riporta (la data di nascita verso Shopify, la
 * spazzata) non tengono indietro niente: rileggere Shopify non le aggiusta, e
 * bloccare il confine per loro vorrebbe dire rileggere il catalogo intero a
 * ogni giro senza avvicinarsi di un passo alla soluzione.
 *
 * `null` quando non c'e' niente da trattenere: il confine avanza intero.
 *
 * `senzaData` e' dove ci si ferma quando la risorsa non porta la sua data di
 * modifica. Dev'essere il punto da cui QUESTA corsa ha cominciato a leggere,
 * non il suo inizio: fermarsi all'inizio della corsa non trattiene niente — il
 * confine sarebbe finito li' comunque — e la risorsa verrebbe scavalcata
 * esattamente come prima. Fermarsi al punto di partenza della lettura invece
 * significa che il confine non avanza affatto, che e' la sola risposta onesta
 * quando non si sa dire fin dove si e' arrivati.
 */
export function watermarkHoldBack(
  aperte: readonly { sourceUpdatedAt: Date | null; recoveredByDelta: boolean }[],
  senzaData: Date,
): Date | null {
  let piuVecchia: Date | null = null;

  for (const riparazione of aperte) {
    if (!riparazione.recoveredByDelta) continue;
    const quando = riparazione.sourceUpdatedAt ?? senzaData;
    if (piuVecchia === null || quando.getTime() < piuVecchia.getTime()) piuVecchia = quando;
  }

  return piuVecchia;
}

/** Quanti giri si concede una riparazione prima di chiamare qualcuno. */
export const MAX_REPAIR_ATTEMPTS = 5;

/** La prima attesa fra due tentativi di riparazione. Le successive raddoppiano. */
export const REPAIR_BACKOFF_BASE_MS = 5 * 60_000;

/** Il tetto dell'attesa: oltre, raddoppiare non serve piu' a niente. */
export const REPAIR_BACKOFF_MAX_MS = 6 * 60 * 60_000;

/**
 * Quando si potra' ritentare.
 *
 * Il distanziamento serve anche qui, e per un motivo in piu' rispetto alla
 * coda: una riparazione la ritenta la corsa successiva, e le corse arrivano a
 * cadenza fissa. Senza attesa, una riparazione impossibile verrebbe ritentata a
 * ogni giro contro un servizio che sta ancora male, e brucerebbe i suoi cinque
 * tentativi in mezza giornata invece che in una settimana.
 */
export function nextRepairAttemptAt(attempts: number, now: Date): Date {
  const esponenziale = REPAIR_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return new Date(now.getTime() + Math.min(esponenziale, REPAIR_BACKOFF_MAX_MS));
}

/** Una riparazione da scrivere, gia' fusa con quella che c'era. */
export interface RepairWrite extends RepairKey {
  sourceUpdatedAt: Date | null;
  recoveredByDelta: boolean;
  details?: Record<string, unknown>;
  lastError: string;
  attempts: number;
  nextAttemptAt: Date;
  status: 'pending' | 'dead_letter';
}

export interface RepairCommitPlan {
  /** Le riparazioni da aprire o riaprire. */
  writes: RepairWrite[];
  /** Gli id delle righe da chiudere: la risorsa e' stata scritta bene. */
  resolvedIds: string[];
  /** Quelle che hanno finito i tentativi: fermano da sole, e vanno segnalate. */
  deadLettered: RepairWrite[];
  /** Quante restano aperte dopo questo commit: e' cio' che rende parziale la corsa. */
  openAfter: number;
  /** Fin dove il confine va tenuto indietro, o null se puo' avanzare intero. */
  holdBackTo: Date | null;
}

/**
 * Cosa scrivere alla chiusura della corsa, deciso senza toccare il database.
 *
 * Sta qui e non nel modulo che scrive perche' e' la parte che va provata: la
 * fusione con quel che c'era gia', il conto dei tentativi, la lettera morta e —
 * soprattutto — il calcolo di fin dove il confine puo' arrivare. Con la query
 * in mezzo, quelle regole si potevano solo affermare.
 */
export function planRepairCommit(opts: {
  ledger: RepairLedger;
  /** Le riparazioni gia' aperte per questo negozio, lette a inizio corsa. */
  existing: readonly OpenRepair[];
  /**
   * Da dove questa corsa ha cominciato a leggere. E' il punto in cui ci si
   * ferma quando una risorsa non porta la sua data di modifica: fermarsi
   * all'inizio della corsa non tratterrebbe niente.
   */
  deltaFloor: Date;
  now: Date;
}): RepairCommitPlan {
  const { ledger, existing, deltaFloor, now } = opts;

  const perChiave = new Map<string, OpenRepair>();
  for (const riga of existing) perChiave.set(repairKeyOf(riga), riga);

  const risolte = new Set(ledger.resolutions().map(repairKeyOf));
  const resolvedIds: string[] = [];
  for (const [chiave, riga] of perChiave) {
    if (risolte.has(chiave)) resolvedIds.push(riga.id);
  }

  const writes: RepairWrite[] = [];
  const deadLettered: RepairWrite[] = [];

  for (const draft of ledger.drafts()) {
    const chiave = repairKeyOf(draft);
    const prima = perChiave.get(chiave);
    // Il tentativo si conta qui, non quando si prova: una riparazione che fa
    // morire il processo prima di poter riferire qualunque cosa deve comunque
    // avvicinarsi alla lettera morta, altrimenti gira in tondo per sempre.
    const attempts = (prima?.attempts ?? 0) + 1;
    const esaurita = attempts >= MAX_REPAIR_ATTEMPTS;

    const write: RepairWrite = {
      resourceType: draft.resourceType,
      resourceId: draft.resourceId,
      operation: draft.operation,
      sourceUpdatedAt: mergeSourceUpdatedAt(prima?.sourceUpdatedAt, draft.sourceUpdatedAt),
      recoveredByDelta: draft.recoveredByDelta,
      details: draft.details,
      lastError: draft.reason,
      attempts,
      nextAttemptAt: nextRepairAttemptAt(attempts, now),
      status: esaurita ? 'dead_letter' : 'pending',
    };

    writes.push(write);
    if (esaurita) deadLettered.push(write);
  }

  // Quel che resta aperto dopo questo commit: le nuove ancora vive, piu' quelle
  // di prima che nessuno ha chiuso e che questa corsa non ha ritoccato.
  const scritte = new Set(writes.map(repairKeyOf));
  const aperteDopo: { sourceUpdatedAt: Date | null; recoveredByDelta: boolean }[] = [];

  for (const write of writes) {
    if (write.status === 'dead_letter') continue;
    aperteDopo.push(write);
  }
  for (const [chiave, riga] of perChiave) {
    if (risolte.has(chiave) || scritte.has(chiave)) continue;
    aperteDopo.push(riga);
  }

  return {
    writes,
    resolvedIds,
    deadLettered,
    openAfter: aperteDopo.length,
    holdBackTo: watermarkHoldBack(aperteDopo, deltaFloor),
  };
}

/**
 * La data di modifica fra quella che c'era e quella nuova: la piu' recente.
 *
 * E' quella che descrive la risorsa da rimettere a posto.
 *
 * `undefined` e `null` non sono la stessa cosa, e confonderli costava la data.
 * `undefined` vuol dire che una riga prima non c'era: allora vale quella nuova,
 * e basta. `null` vuol dire che la riga c'era e la data non la sapeva: allora
 * non la sa nemmeno adesso, e senza data il confine si ferma al punto da cui la
 * corsa ha cominciato a leggere — che e' la scelta prudente.
 */
function mergeSourceUpdatedAt(prima: Date | null | undefined, adesso: Date | null): Date | null {
  if (prima === undefined) return adesso;
  if (prima === null || adesso === null) return null;
  return prima.getTime() >= adesso.getTime() ? prima : adesso;
}
