// app/lib/gdpr/compliance-model.ts
//
// Le regole del ritentativo di una richiesta di conformita', senza database.
//
// Stanno in un file loro perche' sono la parte che va provata, e con una query
// in mezzo si potevano solo affermare. E' la stessa divisione gia' fatta per la
// coda (`queue-model`), per le riparazioni (`repair-ledger`) e per le revoche
// (`revocation-model`).
//
// IL NUMERO DEL TENTATIVO SI DEFINISCE QUI, UNA VOLTA SOLA. Prima non era
// definito da nessuna parte, e per questo era sbagliato: la presa incrementava
// `attempts`, poi chi decideva la lettera morta riceveva `attempts + 1` — cioe'
// lo stesso tentativo logico veniva contato due volte, e la richiesta di una
// persona vera si fermava al quarto tentativo dicendo di averne fatti cinque.
// La regola, adesso, e' una frase sola: il tentativo in corso e' il valore che
// `attempts` ha DOPO la presa, va da 1 a MAX_ATTEMPTS, e MAX_ATTEMPTS e'
// l'ultimo che viene davvero eseguito — non il primo che non lo e'.

/**
 * Quanti tentativi prima di smettere e chiamare qualcuno.
 *
 * Il quinto si esegue: si diventa lettera morta quando il tentativo numero
 * cinque e' FALLITO, non quando sta per cominciare.
 */
export const MAX_ATTEMPTS = 5;

/**
 * Per quanto una presa resta valida senza essere rinnovata.
 *
 * Non c'e' nessun battito che la rinnovi, quindi va commisurata al lavoro piu'
 * lungo: l'esportazione di un negozio con molti ordini fa parecchie richieste
 * al progetto del merchant. Quindici minuti sono larghi per un tentativo vivo e
 * stretti abbastanza da non lasciare una richiesta GDPR in mano a
 * un'invocazione morta per piu' di un paio di giri del cron.
 */
export const COMPLIANCE_LEASE_MS = 15 * 60_000;

/** Da quanto parte l'attesa fra un tentativo e l'altro. */
export const COMPLIANCE_BACKOFF_BASE_MS = 5 * 60_000;

/** E dove si ferma: oltre un'ora non ha piu' senso allontanarli. */
export const COMPLIANCE_BACKOFF_MAX_MS = 60 * 60_000;

/**
 * L'attesa prima del prossimo tentativo: esponenziale, con jitter.
 *
 * L'esponenziale perche' riprovare subito rifarebbe lo stesso errore e
 * brucerebbe i tentativi in un giro solo — che era il comportamento di prima,
 * con un'attesa fissa per tutti e cinque.
 *
 * Il jitter perche' quando il progetto di un merchant smette di rispondere non
 * fallisce una richiesta: falliscono insieme tutte quelle di quel negozio.
 * Senza, tornerebbero pronte nello stesso istante e rifarebbero la stessa
 * ondata contro un servizio che si sta ancora rialzando. Meta' fissa e meta'
 * casuale: l'attesa non scende mai sotto la meta' del dovuto, ma i ritentativi
 * si sparpagliano.
 */
export function complianceBackoffMs(
  attemptNumber: number,
  random: () => number = Math.random,
): number {
  const esponenziale = COMPLIANCE_BACKOFF_BASE_MS * 2 ** Math.max(0, attemptNumber - 1);
  const base = Math.min(esponenziale, COMPLIANCE_BACKOFF_MAX_MS);
  return Math.round(base / 2 + (base / 2) * random());
}

/** Quando la richiesta tornera' prendibile dopo un tentativo fallito. */
export function nextComplianceAttemptAt(
  attemptNumber: number,
  now: Date,
  random: () => number = Math.random,
): Date {
  return new Date(now.getTime() + complianceBackoffMs(attemptNumber, random));
}

/**
 * Se il tentativo appena fallito era l'ultimo.
 *
 * `>=` e non `>`: il tentativo numero MAX_ATTEMPTS e' stato eseguito ed e'
 * andato male, quindi non ce ne sono altri da fare. Con `>` si sarebbe fatto un
 * tentativo in piu' del dichiarato, che e' lo stesso errore di prima al
 * contrario.
 */
export function isExhausted(attemptNumber: number): boolean {
  return attemptNumber >= MAX_ATTEMPTS;
}

/** Lo stato in cui la richiesta resta dopo un tentativo fallito. */
export function statusAfterFailure(attemptNumber: number): 'failed' | 'dead_letter' {
  return isExhausted(attemptNumber) ? 'dead_letter' : 'failed';
}
