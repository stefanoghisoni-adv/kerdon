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
 * DUE FAMIGLIE, UNA POSTA IN ARRIVO. I primi due sono amministrativi — parlano
 * del negozio e del suo abbonamento — e sono quelli per cui questa posta in
 * arrivo e' nata. Gli altri sono operativi: prodotti, clienti e ordini. Prima
 * facevano tutto il lavoro DENTRO la richiesta HTTP, cioe' rileggevano da
 * Shopify, interrogavano due database e scrivevano, e solo alla fine
 * rispondevano. Un timeout li' voleva dire che Shopify ritentava e si rifaceva
 * tutto da capo, con alcune pulizie che fallivano lasciando un avviso nel log
 * mentre la consegna risultava riuscita lo stesso.
 *
 * Sono nella stessa posta in arrivo e non in una seconda perche' le regole che
 * servono sono identiche: una ricevuta per `X-Shopify-Webhook-Id`, una presa
 * condizionata sullo stato, tentativi distanziati, lettera morta e replay.
 * Duplicarle avrebbe voluto dire due deduplica libere di divergere.
 *
 * I tre webhook di conformita' NON stanno qui: hanno gia' la loro posta in
 * arrivo (`compliance_requests`), con i termini di legge e il payload che si
 * cancella da solo. Il perche' sono due tabelle e non una sta nell'intestazione
 * di `inbox.server`.
 */
export const WEBHOOK_TOPICS = [
  'app/uninstalled',
  'app_subscriptions/update',
  'products/create',
  'products/update',
  'products/delete',
  'customers/create',
  'customers/update',
  'customers/delete',
  'orders/create',
  'orders/updated',
  'refunds/create',
  'orders/delete',
] as const;

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

/**
 * Quanto grande puo' essere il corpo di una consegna.
 *
 * Il controllo sta PRIMA della lettura completa e prima del parse, e non e' una
 * cortesia verso la memoria: senza, un corpo enorme — sbagliato, o spedito
 * apposta — veniva bufferizzato per intero, poi passato all'HMAC e poi a
 * `JSON.parse`, tre volte il suo peso, dentro la richiesta che deve rispondere
 * entro il budget. Il tetto e' largo per quel che Shopify manda davvero: un
 * ordine con centinaia di righe o un prodotto con centinaia di varianti stanno
 * abbondantemente sotto.
 */
export const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Il budget di risposta, ed e' il motivo per cui il lavoro non sta piu' dentro
 * la richiesta.
 *
 * `TARGET` e' dove deve stare il novantacinquesimo percentile, `HARD` e' il
 * muro: oltre quello Shopify considera la consegna non riuscita e ritenta, e
 * ritentare quando in realta' avevamo appena finito e' il modo esatto in cui
 * nascevano i doppioni. Una ricevuta e' due scritture sul database owner e
 * nient'altro; tutto cio' che parla con Shopify o con il database del merchant
 * sta dopo la risposta.
 */
export const WEBHOOK_RESPONSE_TARGET_MS = 1_000;
export const WEBHOOK_RESPONSE_HARD_LIMIT_MS = 5_000;

/** Com'e' andata una raffica di risposte, misurata sul budget. */
export interface ResponseBudgetReport {
  p95Ms: number;
  maxMs: number;
  withinTarget: boolean;
  withinHardLimit: boolean;
}

/**
 * Il giudizio sul budget, calcolato in un posto solo.
 *
 * Sta qui e non dentro un test perche' la soglia e il modo di calcolarla sono
 * la regola, non l'attrezzo di chi la prova: due test che calcolassero il
 * percentile ognuno a modo suo misurerebbero due cose diverse e nessuno se ne
 * accorgerebbe.
 */
export function responseBudgetReport(durationsMs: readonly number[]): ResponseBudgetReport {
  if (durationsMs.length === 0) {
    return { p95Ms: 0, maxMs: 0, withinTarget: true, withinHardLimit: true };
  }
  const ordinate = [...durationsMs].sort((a, b) => a - b);
  // Il percentile "piu' vicino al rango", quello che su pochi campioni non
  // interpola fra due misure che non sono mai state prese.
  const indice = Math.min(ordinate.length - 1, Math.ceil(0.95 * ordinate.length) - 1);
  const p95Ms = ordinate[Math.max(0, indice)];
  const maxMs = ordinate[ordinate.length - 1];
  return {
    p95Ms,
    maxMs,
    withinTarget: p95Ms < WEBHOOK_RESPONSE_TARGET_MS,
    withinHardLimit: maxMs < WEBHOOK_RESPONSE_HARD_LIMIT_MS,
  };
}
