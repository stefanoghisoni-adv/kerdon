// app/lib/consent/revocation-model.ts
//
// Le regole del registro delle revoche, senza database sotto.
//
// COSA C'ERA PRIMA, in una riga: la revoca era best effort da capo a fondo.
// `forgetVisitor` restituiva 'failed' senza dire quale dei tre gesti fosse
// fallito, le rotte quel valore non lo guardavano, e il cookie `kerdon_eid`
// veniva fatto scadere comunque — cioe' spariva dal browser proprio il
// riferimento con cui si sarebbe potuto riprovare.
//
// LA DISTINZIONE CHE QUESTO MODULO ESISTE PER TENERE, ed e' la stessa della
// posta in arrivo dei webhook: "presa in carico" e "applicata" sono due cose
// diverse. La presa in carico e' la riga durevole, e senza quella non si
// risponde ok a nessuno. L'applicazione ha i suoi tentativi, il suo
// distanziamento e la sua lettera morta, e puo' andare male quante volte serve
// senza che nessuno la scambi per un rifiuto.
//
// Nessun import, come per `queue-model` e `inbox-model`: un modulo che non
// tocca Prisma si prova in un secondo, e il distanziamento e la lettera morta
// sono esattamente le regole che nessuno provava finche' vivevano dentro il
// SQL.

/**
 * Cosa una revoca puo' chiedere di disfare.
 *
 * Elenco chiuso e controllato alla presa in carico: uno scopo che nessun
 * processore sa lavorare non deve poter creare una riga: resterebbe in attesa
 * per sempre, che e' il difetto che la coda ha gia' pagato una volta.
 *
 * Ce n'e' uno solo, e vale la pena dire cosa NON c'e'. Il ritiro del consenso
 * al marketing di un cliente non e' qui: quello non cancella niente — segna
 * `accepts_marketing = false` e basta, per scelta di prodotto (vedi
 * `customers/consent-withdrawal.ts`) — ed e' gia' durevole per conto suo, con
 * il 500 del webhook che fa ritentare Shopify e con `sync_repairs` che lo
 * trattiene nel delta. Aggiungerlo qui vorrebbe dire un terzo posto da tenere
 * allineato per un lavoro che non ha bisogno di questo registro.
 */
export const REVOCATION_SCOPES = ['tracking_identity'] as const;

export type RevocationScope = (typeof REVOCATION_SCOPES)[number];

export function isRevocationScope(value: unknown): value is RevocationScope {
  return (REVOCATION_SCOPES as readonly unknown[]).includes(value);
}

/**
 * Gli stati di una revoca presa in carico.
 *
 * Non c'e' 'failed', ed e' la stessa scelta gia' fatta per la coda e per la
 * posta dei webhook: un tentativo andato male torna 'queued' con
 * `nextAttemptAt` spostato in avanti. Cosi' la domanda "cosa c'e' da lavorare
 * adesso" ha una risposta sola, e non due liste da tenere allineate.
 */
export type RevocationStatus = 'queued' | 'processing' | 'completed' | 'dead_letter';

/**
 * Gli stati in cui un tentativo puo' lasciare la revoca.
 *
 * 'processing' non c'e': e' lo stato di chi ha la riga in mano adesso, e chi ha
 * appena finito non ce l'ha piu'.
 */
export type SettledRevocationStatus = Exclude<RevocationStatus, 'processing'>;

/**
 * Come e' finito un tentativo.
 *
 * - `done`: tutti i passi sono andati, o non c'era niente da fare.
 * - `retry`: almeno un passo e' fallito davvero, e riprovare ha senso.
 * - `dead_letter`: riprovare non cambierebbe niente — il soggetto cifrato non
 *   c'e' piu', lo scopo non lo sa lavorare nessuno.
 */
export type RevocationOutcome = 'done' | 'retry' | 'dead_letter';

/** Quanti tentativi prima di smettere e chiamare qualcuno. */
export const MAX_REVOCATION_ATTEMPTS = 5;

/** La prima attesa dopo un fallimento. Le successive raddoppiano. */
export const REVOCATION_BACKOFF_BASE_MS = 60_000;

/** Il tetto dell'attesa: oltre, raddoppiare non serve piu' a niente. */
export const REVOCATION_BACKOFF_MAX_MS = 30 * 60_000;

/**
 * Per quanto vale una presa.
 *
 * Il lavoro dura secondi — tre scritture sul progetto del merchant — quindi
 * cinque minuti sono larghissimi per un tentativo vivo e stretti abbastanza da
 * non lasciare una riga in mano a un'invocazione morta piu' a lungo di un giro
 * del cron.
 */
export const REVOCATION_LEASE_MS = 5 * 60_000;

/**
 * L'attesa prima del prossimo tentativo: esponenziale, con jitter.
 *
 * Il jitter non e' un abbellimento, ed e' la differenza rispetto alla posta dei
 * webhook, che ne fa a meno. Li' i tentativi partono dal solo giro del cron,
 * gia' distanziato per conto suo; qui il primo tentativo e' sincrono, dentro la
 * richiesta del visitatore, e quando il progetto di un merchant smette di
 * rispondere falliscono insieme tutte le revoche di quel negozio. Senza jitter
 * tornerebbero pronte nello stesso istante e rifarebbero la stessa ondata
 * contro un servizio che si sta ancora rialzando.
 *
 * Meta' fissa e meta' casuale: l'attesa non scende mai sotto la meta' del
 * dovuto, ma i ritentativi si sparpagliano.
 */
export function revocationBackoffMs(
  attempts: number,
  random: () => number = Math.random,
): number {
  const esponenziale = REVOCATION_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  const base = Math.min(esponenziale, REVOCATION_BACKOFF_MAX_MS);
  return Math.round(base / 2 + (base / 2) * random());
}

/** Quando la revoca tornera' prendibile dopo un fallimento. */
export function nextRevocationAttemptAt(
  attempts: number,
  now: Date,
  random: () => number = Math.random,
): Date {
  return new Date(now.getTime() + revocationBackoffMs(attempts, random));
}

/** Se si e' esaurita la pazienza. */
export function isExhausted(attempts: number): boolean {
  return attempts >= MAX_REVOCATION_ATTEMPTS;
}

/**
 * Lo stato in cui finisce una revoca appena lavorata.
 *
 * Sta qui e non dentro chi scrive la riga perche' e' la regola che decide se la
 * revoca continua a esistere come lavoro da fare: sbagliarla vuol dire o
 * ritentare in eterno, o dichiarare applicata una revoca che non lo e'.
 */
export function statusAfterAttempt(
  outcome: RevocationOutcome,
  attempts: number,
): SettledRevocationStatus {
  if (outcome === 'done') return 'completed';
  if (outcome === 'dead_letter') return 'dead_letter';
  return isExhausted(attempts) ? 'dead_letter' : 'queued';
}

/**
 * Il singolo gesto di una revoca, e com'e' andato.
 *
 * 'skipped' e 'done' non sono la stessa cosa e non vanno confusi: 'skipped' e'
 * la tabella che non esiste — un negozio collegato prima della DDL del grafo
 * non ha `users`, e li' non c'e' niente da cancellare — mentre 'failed' e' un
 * errore vero. E' la distinzione che prima non c'era: `forgetVisitor` faceva
 * diventare successo il primo caso e avviso silenzioso il secondo.
 */
export type RevocationStepName =
  /** `customers.external_id` azzerato: il legame browser-cliente. */
  | 'customer_unlink'
  /** `users.merged_into` azzerato: i rimandi degli altri browser. */
  | 'merge_pointers'
  /** La riga del visitatore, cancellata. */
  | 'user_delete';

export type RevocationStepOutcome = 'done' | 'skipped' | 'failed';

export interface RevocationStep {
  step: RevocationStepName;
  outcome: RevocationStepOutcome;
  /** Il motivo, gia' redatto. Solo quando c'e' qualcosa da dire. */
  detail?: string;
}

/** L'esito completo di un passaggio sul grafo di identita' di un visitatore. */
export interface ForgetResult {
  /**
   * 'forgotten' quando nessun passo e' fallito — quelli saltati compresi, che
   * sono lavoro che non c'era da fare. 'failed' appena uno fallisce.
   */
  outcome: 'forgotten' | 'failed';
  steps: RevocationStep[];
}

/** Se un esito per passi si puo' dichiarare applicato. */
export function allStepsSettled(steps: readonly RevocationStep[]): boolean {
  return steps.every((s) => s.outcome !== 'failed');
}

/**
 * Il motivo da scrivere sulla riga, ricavato dai passi.
 *
 * Nomina i passi falliti, mai il soggetto: questa stringa finisce in un log e
 * in un allarme, e un identificativo di browser li' dentro sarebbe esattamente
 * il dato che la revoca doveva togliere di mezzo.
 */
export function failureSummary(steps: readonly RevocationStep[]): string | null {
  const falliti = steps.filter((s) => s.outcome === 'failed');
  if (falliti.length === 0) return null;
  return falliti.map((s) => `${s.step}: ${s.detail ?? 'errore sconosciuto'}`).join('; ');
}

/**
 * Per quanto si tengono le revoche concluse prima di toglierle di mezzo.
 *
 * Una settimana, come per la coda e per la posta dei webhook. Il testo cifrato
 * pero' non aspetta la potatura: si azzera nell'istante stesso in cui la revoca
 * riesce (vedi `REVOCATION_CIPHERTEXT_TTL_MS` per l'altro caso).
 */
export const REVOCATION_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * La ritenzione breve del testo cifrato sulle revoche abbandonate.
 *
 * Su una riuscita il soggetto sparisce subito: non serve piu' a niente e
 * tenerlo sarebbe conservare l'identificativo che si e' appena finito di
 * cancellare. Su una lettera morta invece serve ancora, perche' e' l'unica cosa
 * da cui il replay puo' ripartire — ma non per sempre: passati trenta giorni
 * nessuno ci sta piu' lavorando, e quel che resta e' la sola prova HMAC.
 */
export const REVOCATION_CIPHERTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
