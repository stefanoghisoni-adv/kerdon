// app/lib/webhooks/inbox-model.ts
//
// Le regole della posta in arrivo dei webhook amministrativi, senza database
// sotto.
//
// COSA C'ERA PRIMA. Le due rotte — `app/uninstalled` e
// `app_subscriptions/update` — facevano il lavoro dentro la richiesta HTTP e
// avvolgevano tutto in un try/catch che rispondeva 200 lo stesso. Per Shopify
// il 200 e' la ricevuta: da quel momento l'evento risulta consegnato e non
// viene ritentato mai piu'. Un negozio disinstallato mentre il database owner
// non rispondeva restava attivo nei registri per sempre; un abbonamento
// terminato non faceva retrocedere il piano, e nessuna riga da nessuna parte
// ricordava che c'era stato un evento da lavorare.
//
// LA DISTINZIONE CHE QUESTO MODULO ESISTE PER TENERE. "Ricevuto" e "elaborato"
// sono due cose diverse e hanno due destinatari diversi. Il 200 risponde alla
// prima domanda soltanto — l'evento e' scritto da qualche parte e non si perde
// piu' — e la seconda ha i suoi tentativi, il suo distanziamento e la sua
// lettera morta. Se la ricevuta non si riesce a scrivere si risponde 5xx: e'
// l'unica risposta onesta, perche' l'unica cosa che rimetterebbe le cose a
// posto e' che Shopify ritenti.
//
// Nessun import, come per `queue-model`: un modulo che non tocca Prisma si
// prova in un secondo, e le regole del distanziamento e della lettera morta
// sono esattamente quelle che nessuno provava finche' vivevano dentro il SQL.

/**
 * I topic che questa posta in arrivo accetta.
 *
 * Elenco chiuso e controllato alla ricevuta. Un topic sconosciuto non deve
 * poter creare una riga che nessun processore sa lavorare: resterebbe in attesa
 * per sempre, che e' il difetto che la coda ha gia' pagato una volta.
 *
 * I tre webhook di conformita' NON stanno qui: hanno gia' la loro posta in
 * arrivo (`compliance_requests`), con i termini di legge e il payload che si
 * cancella da solo. Il perche' sono due tabelle e non una sta nell'intestazione
 * di `inbox.server`.
 */
export const WEBHOOK_TOPICS = ['app/uninstalled', 'app_subscriptions/update'] as const;

export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export function isWebhookTopic(value: unknown): value is WebhookTopic {
  return (WEBHOOK_TOPICS as readonly unknown[]).includes(value);
}

/**
 * Gli stati di un evento ricevuto.
 *
 * Non c'e' 'failed', ed e' la stessa scelta gia' fatta per la coda: un
 * tentativo andato male torna 'queued' con `nextAttemptAt` spostato in avanti.
 * Cosi' la domanda "cosa c'e' da lavorare adesso" ha una risposta sola, e non
 * due liste da tenere allineate.
 */
export type WebhookEventStatus = 'queued' | 'processing' | 'completed' | 'dead_letter';

/**
 * Gli stati in cui un tentativo puo' lasciare l'evento.
 *
 * 'processing' non c'e': e' lo stato di chi ha la riga in mano adesso, e chi ha
 * appena finito non ce l'ha piu'. Restringerlo qui fa si' che chi scrive la
 * conclusione non possa riportare l'evento in lavorazione per sbaglio —
 * resterebbe li' finche' il drenaggio non lo dichiara abbandonato.
 */
export type SettledWebhookStatus = Exclude<WebhookEventStatus, 'processing'>;

/**
 * Come e' finita l'elaborazione di un evento.
 *
 * - `done`: l'effetto e' applicato, o non c'era niente da applicare.
 * - `retry`: qualcosa non ha risposto e riprovare ha senso.
 * - `dead_letter`: riprovare non cambierebbe niente — un payload che non si
 *   riesce a leggere, un listino senza piano gratuito — e continuare a
 *   ritentare vorrebbe dire solo che non se ne accorge nessuno.
 */
export type WebhookOutcome = 'done' | 'retry' | 'dead_letter';

/** Quanti tentativi prima di smettere e chiamare qualcuno. */
export const MAX_WEBHOOK_ATTEMPTS = 5;

/** La prima attesa dopo un fallimento. Le successive raddoppiano. */
export const WEBHOOK_BACKOFF_BASE_MS = 60_000;

/** Il tetto dell'attesa: oltre, raddoppiare non serve piu' a niente. */
export const WEBHOOK_BACKOFF_MAX_MS = 30 * 60_000;

/**
 * Da quando una lavorazione ferma si considera abbandonata.
 *
 * Su una funzione serverless l'invocazione puo' morire fra la presa e la
 * chiusura: senza questa soglia l'evento resterebbe 'processing' per sempre, e
 * un negozio disinstallato resterebbe attivo esattamente come prima di tutto
 * questo lavoro. Largo abbastanza da non strappare un'elaborazione ancora viva
 * — queste durano millisecondi, non minuti.
 */
export const WEBHOOK_STALE_MS = 5 * 60_000;

/**
 * Quando si puo' ritentare, dopo `attempts` tentativi andati male.
 *
 * Raddoppio con tetto, senza jitter: qui i tentativi partono dal giro del cron,
 * che e' gia' distanziato per conto suo, e due eventi che scadono nello stesso
 * istante non si accavallano perche' il drenaggio li lavora in fila.
 */
export function nextWebhookAttemptAt(attempts: number, now: Date): Date {
  const esponente = Math.max(0, attempts - 1);
  const attesa = Math.min(
    WEBHOOK_BACKOFF_BASE_MS * 2 ** esponente,
    WEBHOOK_BACKOFF_MAX_MS,
  );
  return new Date(now.getTime() + attesa);
}

/** Se dopo questo tentativo si smette di riprovare da soli. */
export function isExhausted(attempts: number): boolean {
  return attempts >= MAX_WEBHOOK_ATTEMPTS;
}

/**
 * Lo stato in cui finisce un evento appena lavorato.
 *
 * Sta qui e non dentro chi scrive la riga perche' e' la regola che decide se un
 * evento continua a esistere come lavoro da fare: sbagliarla vuol dire o
 * ritentare in eterno, o dichiarare fatto qualcosa che non e' successo.
 */
export function statusAfterAttempt(
  outcome: WebhookOutcome,
  attempts: number,
): SettledWebhookStatus {
  if (outcome === 'done') return 'completed';
  if (outcome === 'dead_letter') return 'dead_letter';
  return isExhausted(attempts) ? 'dead_letter' : 'queued';
}
