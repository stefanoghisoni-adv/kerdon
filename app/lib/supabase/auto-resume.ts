// app/lib/supabase/auto-resume.ts
//
// "Il database del merchant e' fermo da troppo: lo riaccendiamo noi?"
//
// PERCHE' ESISTE. Un progetto Supabase gratuito messo in pausa non resta in
// pausa per sempre: passata una certa finestra non e' piu' riattivabile, e di
// quel database restano soltanto le copie di sicurezza da scaricare. Il banner
// che sta accanto a questo file dice al merchant che il tempo e' limitato, ma
// dirlo non basta: il merchant che non apre l'app non lo legge, ed e' proprio
// lui quello che sta per perdere il database — l'app viene messa in pausa
// perche' nessuno la tocca da settimane.
//
// Qui c'e' SOLO la regola: da quando si conta, quando si interviene, quando
// invece si sta fermi. Nessuna rete, nessun Prisma, nessuna cache — come in
// `database-pause.ts`, ed e' la stessa ragione: sono decisioni che toccano
// l'infrastruttura di qualcun altro, e devono essere provate davvero invece che
// affermate. Chi va a chiedere e a premere sta in `auto-resume.server.ts`.
import type { DatabaseAvailability } from './database-pause';

/**
 * Quanto dura la finestra di riattivazione, secondo la lettura PRUDENTE.
 *
 * NON e' un numero che Supabase ci dica: la data di scadenza non compare in
 * nessun campo del progetto ne' in nessun endpoint della sua API. Va stimata, e
 * le due fonti ufficiali non coincidono:
 *
 *   - la guida al pausing dei progetti gratuiti dice "there is a 1-year window
 *     to restore the project on the platform from within Supabase Studio", ed e'
 *     coerente con cio' che un merchant vede davvero scritto sulla pagina del
 *     proprio progetto (pausa a meta' settembre 2026, riattivabile fino al 16
 *     settembre 2027);
 *   - il changelog, per i progetti messi in pausa dopo il 24/06/2024, parla di
 *     90 giorni.
 *
 * Due fonti ufficiali che dicono cose diverse sono un'incertezza, non una
 * media: qui si prende la piu' corta. Il costo dei due errori non e' lo stesso.
 * Se la finestra e' davvero un anno e noi ci comportiamo come se fossero 90
 * giorni, il danno e' che un database viene riacceso qualche mese prima del
 * necessario — cioe' torna a sincronizzare, che e' quello che il merchant vuole
 * comunque. Se la finestra e' davvero 90 giorni e noi ci comportiamo come se
 * fosse un anno, il danno e' un database che non torna piu'. Non e' un
 * arrotondamento: e' l'unica delle due asimmetrie che si possa reggere.
 */
export const FINESTRA_PRUDENTE_GIORNI = 90;

const GIORNO_MS = 24 * 60 * 60 * 1000;

/**
 * Da quanto tempo un database dev'essere fermo perche' lo riaccendiamo noi.
 *
 * Sessanta giorni: due terzi della finestra prudente, e trenta giorni di
 * margine dentro di essa.
 *
 * NON DI PIU', perche' il margine serve tutto: se la riattivazione viene
 * rifiutata — troppe richieste, un guasto di Supabase, il collegamento
 * all'account decaduto — bisogna poter riprovare piu' volte E avere ancora
 * tempo davanti per dire al merchant che deve intervenire lui. Una soglia
 * appoggiata agli ultimi giorni trasforma il primo rifiuto in una perdita.
 *
 * NON DI MENO, perche' la pausa non e' un guasto: e' il modo in cui il piano
 * gratuito di Supabase spegne quel che nessuno usa. Un merchant che ha messo in
 * pausa il progetto di proposito, o che semplicemente non lo tocca da un mese,
 * non deve trovarselo riacceso subito — e Supabase lo rimetterebbe in pausa
 * poco dopo, lasciandoci a inseguire.
 *
 * Se la finestra vera fosse un anno, intervenire al sessantesimo giorno resta
 * innocuo: il database torna su e la sincronizzazione riparte. E' la direzione
 * in cui si puo' sbagliare.
 */
export const SOGLIA_INTERVENTO_MS = 60 * GIORNO_MS;

/**
 * Quanto si aspetta fra un tentativo automatico e il successivo.
 *
 * Sei ore, e il numero nasce da chi chiama: il giro del cron non e' giornaliero
 * — su Vercel lo e', ma la stessa rotta la chiama anche GitHub Actions ogni
 * mezz'ora. Senza questo freno un database che non torna su produrrebbe
 * quarantotto richieste di riattivazione al giorno verso Supabase, che e'
 * esattamente il martellamento che non deve poter esistere.
 *
 * Sei ore lasciano comunque ~120 occasioni dentro i trenta giorni di margine:
 * molte piu' di quante ne servano, e nessuna ravvicinata.
 */
export const ATTESA_FRA_TENTATIVI_MS = 6 * 60 * 60 * 1000;

/**
 * Quante volte, al massimo, ci proviamo da soli per una stessa pausa.
 *
 * Dieci: con l'attesa qui sopra sono due giorni e mezzo di tentativi. Oltre, se
 * Supabase continua a rifiutare, il problema non e' il momento ed e' inutile
 * continuare a bussare: restano quasi quattro settimane in cui il banner —
 * warning, perche' la sincronizzazione e' ferma — dice al merchant che deve
 * riaccenderlo lui. Un contatore che non si ferma mai sarebbe un martellamento
 * lento, non una riprova.
 *
 * Il conto si azzera quando il progetto risulta di nuovo attivo: una pausa
 * successiva ha il suo budget, non gli avanzi della precedente.
 */
export const TENTATIVI_MASSIMI = 10;

/** La scelta del merchant e la memoria dei tentativi, come il DB owner la tiene. */
export interface AutoResumeSetting {
  /**
   * L'interruttore in Impostazioni. `null` = mai toccato.
   *
   * Nullo vale acceso, perche' acceso e' il comportamento dichiarato dell'app —
   * quello scritto accanto all'interruttore e dentro il banner, che il merchant
   * legge prima che accada. Spento e' una scelta esplicita e si rispetta: il
   * database e' suo.
   */
  enabled: boolean | null;
  /** L'ultima volta che il giro automatico si e' occupato di questo negozio. */
  lastAttemptAt: Date | null;
  /** Quante riattivazioni abbiamo gia' chiesto per la pausa in corso. */
  attempts: number;
}

/** Cosa il giro automatico decide di fare per un negozio, e perche'. */
export type AutoResumeDecision =
  /** Si chiede la riattivazione. */
  | 'riattiva'
  /** Non sappiamo se il merchant ci abbia detto di no: non si tocca niente. */
  | 'non-configurato'
  /** L'interruttore e' spento: il merchant se ne occupa da se'. */
  | 'spento'
  /** Disinstallato, in cancellazione, sospeso: non e' piu' roba nostra. */
  | 'negozio-escluso'
  /** Il database risponde: non c'e' niente da riaccendere. */
  | 'database-attivo'
  /** Sta gia' ripartendo: chiederlo di nuovo non aggiunge niente. */
  | 'gia-in-corso'
  /** Uno stato che non sappiamo leggere: in dubbio non si tocca. */
  | 'stato-non-letto'
  /** Fermo, ma non da abbastanza: la pausa non e' un guasto. */
  | 'troppo-presto'
  /** Ci abbiamo appena provato: si aspetta. */
  | 'in-attesa'
  /** Ci abbiamo provato troppe volte: adesso tocca al merchant. */
  | 'tentativi-esauriti';

/** Tutto cio' su cui la decisione si fonda, passato esplicito. */
export interface AutoResumeFacts {
  /**
   * Come sta il database, gia' passato per `effectiveAvailability`: cosi' un
   * clic del merchant di un minuto fa conta come riattivazione in corso anche
   * se Supabase dichiara ancora il progetto fermo.
   */
  availability: DatabaseAvailability;
  /**
   * Il negozio puo' ancora usare l'app (`use_app`).
   *
   * E' la domanda che tiene fuori chi non va toccato: disinstallati, negozi in
   * cancellazione, autorizzazione decaduta, prova finita. Riaccendere
   * l'infrastruttura di chi se n'e' andato e' esattamente cio' che non deve
   * succedere — e la risposta non si ricompone qui, la da' `capabilities.ts`
   * come a tutti gli altri.
   */
  allowed: boolean;
  /**
   * La riga del DB owner, o `null` se non c'e' ancora nessun posto dove
   * leggerla.
   *
   * `null` NON vuol dire "acceso": vuol dire che non sappiamo se il merchant ci
   * abbia detto di no, e in dubbio su un gesto che tocca la sua infrastruttura
   * non si agisce. Succede nella finestra fra il rilascio del codice e
   * l'esecuzione della migrazione.
   */
  setting: AutoResumeSetting | null;
  /**
   * L'ultimo istante in cui il database ha DATO PROVA di essere vivo.
   *
   * E' da qui che si conta, e non da quando ci siamo accorti della pausa: la
   * pausa comincia dopo l'ultima prova di vita, quindi contare da li' da' il
   * tempo trascorso PIU' LUNGO compatibile con i fatti. E' la stima pessimista,
   * che e' l'unica che non fa arrivare tardi.
   *
   * `null` = nessuna prova di vita. E' il caso cieco — vedi `tempoFermoMs`.
   */
  lastProofOfLife: Date | null;
  now: Date;
}

/**
 * Da quanto il database e' fermo, al massimo di quanto i fatti consentano.
 *
 * `null` quando non c'e' nessuna prova di vita: non e' "zero", ed e' proprio la
 * differenza che conta.
 */
export function tempoFermoMs(facts: Pick<AutoResumeFacts, 'lastProofOfLife' | 'now'>): number | null {
  if (!facts.lastProofOfLife) return null;
  return facts.now.getTime() - facts.lastProofOfLife.getTime();
}

/**
 * La soglia e' stata superata?
 *
 * IL CASO CIECO. Un merchant che collega Kerdon a un progetto GIA' in pausa non
 * ci lascia nessuna prova di vita: nessuna sincronizzazione e' mai riuscita,
 * nessuna verifica del collegamento e' mai passata su un database che
 * rispondeva. Di quella pausa non sappiamo se sia cominciata ieri o undici mesi
 * fa, e non c'e' nessun modo di saperlo — Supabase non dice quando ha messo in
 * pausa un progetto ne' quando scade.
 *
 * Nel dubbio si interviene SUBITO, al primo giro. Aspettare su una data che non
 * conosciamo e' il modo di arrivare tardi: se la pausa fosse vecchia di undici
 * mesi, ogni giorno di attesa sarebbe preso da quel che resta. Il costo
 * dell'errore opposto — riaccendere un database fermo da un giorno — e' che il
 * database torna a sincronizzare, cioe' quel che il merchant si aspetta
 * dall'app che ha appena collegato.
 */
export function sogliaSuperata(facts: Pick<AutoResumeFacts, 'lastProofOfLife' | 'now'>): boolean {
  const fermo = tempoFermoMs(facts);
  if (fermo === null) return true;
  return fermo >= SOGLIA_INTERVENTO_MS;
}

/** L'interruttore, letto con il suo default. Nullo = acceso, vedi `AutoResumeSetting`. */
export function autoResumeIsOn(setting: AutoResumeSetting): boolean {
  return setting.enabled !== false;
}

/**
 * Che cosa fare, per un negozio, adesso.
 *
 * L'ORDINE DEI CONTROLLI NON E' INDIFFERENTE, ed e' scritto dal piu' vincolante
 * al meno: prima chi non va toccato (un negozio in cancellazione non deve nemmeno
 * arrivare a far valutare una soglia), poi il permesso del merchant, poi lo
 * stato del database, poi il tempo, poi i freni. Invertire i primi due
 * significherebbe leggere lo stato del progetto di un negozio che se n'e'
 * andato — cioe' toccarlo comunque, un po' meno.
 */
export function decideAutoResume(facts: AutoResumeFacts): AutoResumeDecision {
  if (!facts.allowed) return 'negozio-escluso';
  if (!facts.setting) return 'non-configurato';
  if (!autoResumeIsOn(facts.setting)) return 'spento';

  if (facts.availability === 'attivo') return 'database-attivo';
  if (facts.availability === 'in-riattivazione') return 'gia-in-corso';
  if (facts.availability !== 'in-pausa') return 'stato-non-letto';

  if (!sogliaSuperata(facts)) return 'troppo-presto';

  // I due freni, dopo la soglia e non prima: cosi' "troppo presto" resta
  // distinguibile da "ci ho gia' provato", che nei log sono due storie diverse.
  if (facts.setting.attempts >= TENTATIVI_MASSIMI) return 'tentativi-esauriti';
  if (
    facts.setting.lastAttemptAt &&
    facts.now.getTime() - facts.setting.lastAttemptAt.getTime() < ATTESA_FRA_TENTATIVI_MS
  ) {
    return 'in-attesa';
  }

  return 'riattiva';
}

/**
 * Vale la pena andare a chiedere a Supabase com'e' messo questo progetto?
 *
 * E' il filtro che tiene basso il costo del giro: senza, il cron chiederebbe lo
 * stato di ogni progetto di ogni negozio a ogni passaggio. Si chiede solo per i
 * negozi che non danno prova di vita da oltre la soglia — cioe' quelli per cui,
 * se davvero fossero fermi, sarebbe gia' ora di agire. Per tutti gli altri il
 * giro costa due query sul nostro database e nessuna chiamata di rete.
 *
 * Si guarda anche il freno, e PRIMA della chiamata: un negozio che non
 * sincronizza da mesi per ragioni che non c'entrano con la pausa passerebbe
 * questo filtro a ogni giro, e senza l'attesa produrrebbe una domanda a
 * Supabase ogni mezz'ora per sempre.
 */
export function vaInterrogato(
  facts: Pick<AutoResumeFacts, 'allowed' | 'setting' | 'lastProofOfLife' | 'now'>,
): boolean {
  if (!facts.allowed) return false;
  if (!facts.setting) return false;
  if (!autoResumeIsOn(facts.setting)) return false;
  if (!sogliaSuperata(facts)) return false;
  if (
    facts.setting.lastAttemptAt &&
    facts.now.getTime() - facts.setting.lastAttemptAt.getTime() < ATTESA_FRA_TENTATIVI_MS
  ) {
    return false;
  }
  return true;
}
