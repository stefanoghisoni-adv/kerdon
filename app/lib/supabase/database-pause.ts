// app/lib/supabase/database-pause.ts
//
// "Il database del merchant e' fermo, e cosa puo' farci?"
//
// PERCHE' ESISTE. Un progetto Supabase gratuito che nessuno tocca per un po'
// viene messo in pausa: i dati restano tutti, ma il database non risponde piu'.
// Da quel momento ogni lettura fallisce, la sincronizzazione non scrive piu'
// niente, e l'app mostrava soltanto delle card vuote — cioe' raccontava un
// negozio senza numeri invece di un database spento. Il merchant non aveva modo
// di sapere ne' che cosa fosse successo ne' che bastava un clic per rimediare.
//
// Qui c'e' SOLO la regola: quali stati vogliono dire fermo, quando un clic sul
// pulsante conta ancora come "riattivazione in corso", e quando la
// sincronizzazione va fatta ripartire. Nessuna rete, nessuna cache, nessun
// Prisma: e' l'unico modo perche' i casi che contano siano provati davvero
// invece che affermati. Chi parla con Supabase sta in `database-pause.server.ts`,
// chi lo mostra e' il banner in dashboard.

/**
 * Gli stati che la Management API dichiara per un progetto.
 *
 * NON sono indovinati: sono l'enum `status` di `V1ProjectResponse` nello
 * schema OpenAPI pubblicato da Supabase (https://api.supabase.com/api/v1-json),
 * che e' la stessa fonte da cui nasce la pagina di riferimento dell'API. Stanno
 * scritti qui per intero perche' la classifica qui sotto ne tiene dentro pochi
 * e ne lascia fuori molti: senza l'elenco davanti, "ne manca uno?" e' una
 * domanda a cui si risponde a memoria.
 */
export const SUPABASE_PROJECT_STATUSES = [
  'INACTIVE',
  'ACTIVE_HEALTHY',
  'ACTIVE_UNHEALTHY',
  'COMING_UP',
  'UNKNOWN',
  'GOING_DOWN',
  'INIT_FAILED',
  'REMOVED',
  'RESTORING',
  'UPGRADING',
  'PAUSING',
  'RESTORE_FAILED',
  'RESTARTING',
  'PAUSE_FAILED',
  'RESIZING',
] as const;

/** Come sta il database del merchant, detto in termini che il banner usa. */
export type DatabaseAvailability =
  /** Risponde: nessun avviso da mostrare. */
  | 'attivo'
  /** Fermo, e nessuno lo sta rimettendo in piedi. */
  | 'in-pausa'
  /** Fermo, ma qualcuno ha gia' chiesto di riaccenderlo. */
  | 'in-riattivazione'
  /**
   * Nessuna delle tre: uno stato che non sappiamo leggere, o una lettura non
   * riuscita. Non si mostra niente — vedi `classifyProjectStatus`.
   */
  | 'sconosciuto';

/**
 * Da uno stato di Supabase a come sta il database.
 *
 * DIFENSIVA DI PROPOSITO, in tutte e due le direzioni.
 *
 * Attivo e' il solo `ACTIVE_HEALTHY`. `ACTIVE_UNHEALTHY`, `RESIZING`,
 * `UPGRADING` non sono la pausa e non sono un guasto nostro, ma nemmeno un
 * database su cui promettere che la sincronizzazione stia lavorando: cadono
 * fra gli "sconosciuti", dove nessun avviso viene mostrato e nessuna
 * sincronizzazione viene fatta ripartire. Meglio tacere che dire una cosa
 * sbagliata su un database che non e' nostro.
 *
 * Ferme sono `INACTIVE` — quello che la documentazione mostra come esempio di
 * progetto in pausa — e `PAUSING`, che e' la pausa che sta scendendo: le query
 * li' falliscono gia', e aspettare che il numero cambi vorrebbe dire lasciare
 * il merchant davanti alle card vuote proprio nei minuti in cui l'avviso
 * servirebbe.
 *
 * In riattivazione sono `RESTORING` e `COMING_UP`, i due stati della risalita.
 * `RESTARTING` no: un riavvio non e' un ritorno dalla pausa, e chiamarlo cosi'
 * accenderebbe l'avviso su un progetto che nessuno aveva mai spento.
 *
 * `PAUSE_FAILED` e `RESTORE_FAILED` restano fuori a bella posta: sono due
 * fallimenti del piano di controllo di Supabase su cui il nostro pulsante non
 * ha nessuna presa, e dichiararli "in pausa" offrirebbe al merchant un gesto
 * che non risolve. La sua strada li' e' la dashboard di Supabase.
 */
export function classifyProjectStatus(status: string): DatabaseAvailability {
  switch (status.toUpperCase()) {
    case 'ACTIVE_HEALTHY':
      return 'attivo';
    case 'INACTIVE':
    case 'PAUSING':
      return 'in-pausa';
    case 'RESTORING':
    case 'COMING_UP':
      return 'in-riattivazione';
    default:
      return 'sconosciuto';
  }
}

/**
 * Perche' il pulsante non puo' funzionare, quando non puo'.
 *
 * Esiste perche' un pulsante che non riattiva niente e' peggio di nessun
 * pulsante: in questi casi il banner smette di offrirlo e porta il merchant
 * dove il gesto riesce davvero, cioe' sulla pagina del suo database.
 *
 * NON c'e' un caso "progetto oltre la data di riattivabilita'", e l'assenza e'
 * voluta: Supabase non lo distingue. Per la richiesta di riattivazione dichiara
 * 401, 403 e 429 e nient'altro, e un progetto oltre la finestra torna indietro
 * come 403 esattamente come il permesso mancante. Tenere qui un caso che non
 * sappiamo riconoscere vorrebbe dire scrivere un messaggio che non sapremmo mai
 * quando mostrare — e i due casi finiscono comunque nello stesso gesto: aprire
 * la pagina del database su Supabase, dove la data e' scritta.
 */
export type ResumeBlock =
  /** All'app manca il permesso di riaccendere progetti su quell'account. */
  | 'no_permission'
  /** Il collegamento all'account non vale piu': va rifatto dalle Impostazioni. */
  | 'reconnect';

/**
 * Quel che si sa del database fermo di un negozio, e da quando.
 *
 * Vive sul server (vedi `database-pause.server.ts`): sopravvive al cambio di
 * scheda, alla chiusura del browser e al passaggio da un dispositivo all'altro.
 * E' la stessa lezione di `pending-sync.ts` — un `useState` con l'ora del clic
 * muore alla prima navigazione e lascia il merchant a guardare due schermate
 * che si contraddicono.
 */
export interface DatabasePauseState {
  /** Lo stato grezzo letto da Supabase: serve nei log, non a schermo. */
  status: string;
  availability: DatabaseAvailability;
  /** Quando lo abbiamo chiesto l'ultima volta. */
  checkedAt: string;
  /**
   * Quando il merchant ha premuto "Riattiva database", se l'ha premuto.
   *
   * E' il pezzo di verita' che Supabase per qualche istante non ha ancora: il
   * progetto risponde `INACTIVE` anche subito dopo che la riattivazione e'
   * stata accettata. Senza questa data il banner tornerebbe a dire "in pausa"
   * con il pulsante acceso un attimo dopo il clic, e il merchant premerebbe di
   * nuovo credendo di non aver premuto.
   */
  resumeRequestedAt?: string | null;
  /** L'ultimo motivo per cui il pulsante non ha potuto funzionare. */
  resumeBlocked?: ResumeBlock | null;
  /**
   * A chiedere la riattivazione e' stata l'app, non il merchant.
   *
   * Cambia quello che il banner racconta, e non e' un dettaglio: "stiamo
   * riaccendendo il database che hai chiesto di riaccendere" e "abbiamo
   * riacceso noi il tuo database perche' stava per non essere piu'
   * riaccendibile" sono due notizie diverse, e la seconda e' l'unico modo che
   * il merchant ha di sapere che l'app fa questa cosa.
   *
   * Assente, e non `false`, quando il gesto e' del merchant: cosi' lo stato
   * scritto sul percorso normale resta esattamente quello di prima.
   */
  resumedByApp?: boolean | null;
}

/**
 * Per quanto un clic continua a voler dire "riattivazione in corso" mentre
 * Supabase dichiara ancora il progetto fermo.
 *
 * Venti minuti perche' la riattivazione richiede minuti, non secondi, e il suo
 * stato non si vede subito. Ma non per sempre: passata la finestra senza che il
 * progetto si sia mosso, la richiesta non ha attecchito, e continuare a dire
 * "sta ripartendo" sarebbe una bugia che nessuno smentisce mai — con il
 * pulsante spento dentro, e il merchant senza piu' nessun gesto da fare. Oltre
 * la finestra si torna a "in pausa": pulsante di nuovo suo, e la strada della
 * dashboard Supabase sempre li' accanto.
 */
export const RESUME_IN_PROGRESS_WINDOW_MS = 20 * 60_000;

function ms(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Come sta il database ADESSO, tenendo conto anche del clic del merchant.
 *
 * Perche' non basta `state.availability`: fra il clic e il momento in cui
 * Supabase comincia a dichiarare `RESTORING` passa del tempo, e in quel tratto
 * lo stato letto e' ancora `INACTIVE`. E' lo stesso buco che in
 * `pending-sync.ts` stava fra il clic e la partenza del lavoro, e si tappa allo
 * stesso modo: con un fatto scritto sul server, non con una spia del browser.
 */
export function effectiveAvailability(
  state: DatabasePauseState,
  now: Date,
): DatabaseAvailability {
  if (
    state.availability === 'in-pausa' &&
    state.resumeRequestedAt &&
    ms(state.resumeRequestedAt) > now.getTime() - RESUME_IN_PROGRESS_WINDOW_MS
  ) {
    return 'in-riattivazione';
  }
  return state.availability;
}

/** Il database non lavora: la sincronizzazione e' ferma e va detto. */
export function databaseIsStopped(availability: DatabaseAvailability): boolean {
  return availability === 'in-pausa' || availability === 'in-riattivazione';
}

/**
 * Se al merchant va offerto il pulsante, oppure la strada della dashboard.
 *
 * Tre no, e sono i tre che contano: mentre la riattivazione e' gia' in corso
 * (premere di nuovo non aggiunge niente), quando l'app non ha il permesso o non
 * ha piu' un collegamento valido, e quando Supabase non riaccende piu' quel
 * progetto. In tutti e tre il banner resta, resta warning, e cambia solo cio'
 * che chiede di fare.
 */
export function shouldOfferResume(state: DatabasePauseState, now: Date): boolean {
  if (effectiveAvailability(state, now) !== 'in-pausa') return false;
  return !state.resumeBlocked;
}

/**
 * Da fermo a di nuovo attivo: e' qui che la sincronizzazione va rimessa in
 * moto.
 *
 * Il merchant ha premuto un pulsante e se n'e' andato; quando il database
 * torna, i suoi dati sono vecchi di giorni e nessuno glieli aggiorna finche'
 * non apre l'app e preme "Sincronizza". Fargli fare due gesti per una cosa
 * sola non ha senso: il secondo lo facciamo noi.
 *
 * Solo da FERMO ad attivo: un database che era gia' attivo e resta attivo non
 * deve accodare niente: questo controllo passa anche da una pagina che si
 * ricarica da sola, e accodare a ogni giro sarebbe una sincronizzazione ogni
 * pochi secondi.
 */
export function syncShouldRestart(
  previous: DatabaseAvailability,
  next: DatabaseAvailability,
): boolean {
  return databaseIsStopped(previous) && next === 'attivo';
}

/**
 * Se lo stato che abbiamo in mano e' vecchio abbastanza da richiederne uno
 * nuovo.
 *
 * E' il freno che tiene fede al vincolo: a Supabase non si chiede niente a ogni
 * apertura di pagina. Si richiede solo per un negozio di cui sappiamo gia' che
 * il database e' fermo — dove la domanda "e' tornato?" e' l'unica che conti — e
 * comunque non piu' di una volta al minuto.
 */
export function stateIsStale(
  state: DatabasePauseState,
  now: Date,
  maxAgeMs: number,
): boolean {
  return ms(state.checkedAt) <= now.getTime() - maxAgeMs;
}
