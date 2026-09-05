// app/lib/queue/queue-model.ts
//
// Le regole della coda, senza database sotto.
//
// Stanno qui separate da chi le esegue perche' sono la parte che deve valere
// identica in due posti: nel SQL che la implementa su Postgres (queue-store) e
// nel consumatore che decide cosa fare dopo (drain). Finche' erano scritte una
// volta sola dentro il SQL non c'era modo di provarle senza un database, e
// infatti nessuno le provava: la coda vecchia rimuoveva il job su eccezione, e
// quel comportamento non e' mai comparso in un test perche' non c'era niente da
// interrogare che non fosse Redis.
//
// Nessun import: e' voluto. Un modulo che non tocca ne' Prisma ne' Redis si
// puo' chiamare da qualunque parte, anche da un test che gira in un secondo.

/**
 * I tipi di lavoro che la coda accetta.
 *
 * Elenco chiuso, e controllato all'accodamento. Prima non lo era: un tipo che
 * il drenaggio non riconosceva veniva saltato con un `continue`, e l'item
 * restava `waiting` per sempre senza che nessuno se ne accorgesse — una coda
 * che accumula lavoro invisibile e' peggio di una che lo rifiuta subito.
 *
 * 'retry-failed-webhook' non c'e' piu': nessuno lo accodava, il processor
 * lanciava "not yet implemented", e tenerlo in elenco significava solo lasciare
 * aperta la porta a righe che nessuno avrebbe lavorato.
 */
export const SYNC_REQUEST_TYPES = [
  'manual-sync',
  'initial-bulk-sync',
  'periodic-sync-check',
  'compliance-request',
] as const;

export type SyncRequestType = (typeof SYNC_REQUEST_TYPES)[number];

export function isSyncRequestType(value: unknown): value is SyncRequestType {
  return (SYNC_REQUEST_TYPES as readonly unknown[]).includes(value);
}

/** Un item della coda, per quel che serve a deciderne la sorte. */
export interface SyncRequestRow {
  id: string;
  shopId: string | null;
  type: string;
  payload: unknown;
  status: SyncRequestStatus;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  fencingToken: number;
}

/**
 * Gli stati possibili.
 *
 * Non c'e' 'failed', e la mancanza e' voluta: un tentativo andato male torna
 * 'queued' con `nextAttemptAt` spostato in avanti. Cosi' la domanda "cosa c'e'
 * da fare adesso" ha una risposta sola, e non due liste da tenere allineate.
 */
export type SyncRequestStatus = 'queued' | 'processing' | 'completed' | 'dead_letter';

/**
 * La presa di possesso: chi ha l'item e con quale gettone.
 *
 * Il gettone e' quello che distingue questa presa da tutte le precedenti. Senza
 * di lui, un processo che si risveglia dopo aver perso il lease — un deploy a
 * meta' lavoro, una funzione riesumata dopo una pausa — dichiarerebbe
 * completato un lavoro che nel frattempo sta facendo qualcun altro.
 */
export interface SyncRequestLease {
  id: string;
  owner: string;
  fencingToken: number;
}

/**
 * Quanto dura una presa prima di essere riprendibile da chiunque.
 *
 * Un minuto, e non i dieci del lucchetto di prima. Corta si puo': il battito
 * del cuore la rinnova finche' il lavoro dura, quindi la durata non deve
 * coprire il lavoro piu' lungo immaginabile — deve solo essere piu' lunga
 * dell'intervallo fra due battiti. Il guadagno e' dall'altra parte: quando
 * un'invocazione muore davvero, il suo lavoro riparte in un minuto invece che
 * in dieci.
 */
export const LEASE_TTL_MS = 60_000;

/**
 * Ogni quanto si rinnova la presa. Un terzo della durata: due battiti persi di
 * fila non bastano a perdere il lease, tre si'.
 */
export const HEARTBEAT_MS = 20_000;

/** Quanti tentativi prima di smettere e chiamare qualcuno. */
export const MAX_ATTEMPTS = 5;

/** La prima attesa dopo un fallimento. Le successive raddoppiano. */
export const BACKOFF_BASE_MS = 60_000;

/** Il tetto dell'attesa: oltre, raddoppiare non serve piu' a niente. */
export const BACKOFF_MAX_MS = 30 * 60_000;

/**
 * L'ampiezza della finestra di deduplica.
 *
 * Due clic sul pulsante a pochi secondi l'uno dall'altro sono la stessa
 * richiesta, e devono produrre un item solo. Due clic a dieci minuti di
 * distanza no: il secondo e' una richiesta nuova, e fonderla nella prima
 * vorrebbe dire ignorarla — il merchant ha appena cambiato qualcosa su Shopify
 * e sta chiedendo di rivederlo.
 */
export const DEDUP_WINDOW_MS = 60_000;

/**
 * Quanto puo' durare un lavoro prima di essere interrotto, per tipo.
 *
 * Sotto il tetto di durata di una funzione su Vercel (cinque minuti) di
 * proposito: al tetto la piattaforma stacca la corrente a meta' di una
 * scrittura e non lascia niente scritto da nessuna parte. Interrompendosi da
 * soli un istante prima, invece, l'item torna in coda con il suo motivo e il
 * lucchetto viene rilasciato — la differenza fra un lavoro rimandato e un
 * lavoro perso.
 */
export const MAX_RUN_MS: Record<SyncRequestType, number> = {
  'manual-sync': 270_000,
  'initial-bulk-sync': 270_000,
  'periodic-sync-check': 270_000,
  // Piu' corto: qui non si scarica un catalogo, si leggono o si cancellano le
  // righe di una persona sola.
  'compliance-request': 120_000,
};

/**
 * Se l'item si puo' prendere adesso.
 *
 * Due casi, e il secondo e' quello che rende la coda viva: un item 'processing'
 * il cui lease e' scaduto e' un'invocazione morta a meta', e va ripreso. Senza
 * questo un solo timeout basterebbe a fermare per sempre quel negozio.
 */
export function isClaimable(row: SyncRequestRow, now: Date): boolean {
  if (row.status === 'queued') return row.nextAttemptAt.getTime() <= now.getTime();
  if (row.status === 'processing') {
    return row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() <= now.getTime();
  }
  return false;
}

/**
 * Se chi presenta questo lease e' ancora il proprietario dell'item.
 *
 * Il confronto e' su proprietario E gettone. Solo il proprietario non
 * basterebbe: due invocazioni della stessa funzione possono avere lo stesso
 * nome, e soprattutto la stessa invocazione che riprende un item dopo averlo
 * perso si ripresenterebbe con l'identita' giusta e il gettone vecchio.
 */
export function holdsLease(row: SyncRequestRow, lease: SyncRequestLease): boolean {
  return row.leaseOwner === lease.owner && row.fencingToken === lease.fencingToken;
}

/**
 * L'attesa prima del prossimo tentativo: esponenziale, con jitter.
 *
 * Il jitter non e' un abbellimento. Senza, tutti gli item falliti nello stesso
 * giro — ed e' il caso normale, perche' quando Shopify o Supabase non rispondono
 * falliscono tutti insieme — tornerebbero pronti nello stesso istante, e il
 * giro dopo rifarebbero la stessa ondata contro un servizio che si sta ancora
 * rialzando. Meta' fissa e meta' casuale: l'attesa non scende mai sotto la
 * meta' del dovuto, ma i ritentativi si sparpagliano.
 */
export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
  const esponenziale = BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  const base = Math.min(esponenziale, BACKOFF_MAX_MS);
  return Math.round(base / 2 + (base / 2) * random());
}

/** Quando l'item tornera' prendibile dopo un fallimento. */
export function nextAttemptAfterFailure(
  attempts: number,
  now: Date,
  random: () => number = Math.random,
): Date {
  return new Date(now.getTime() + backoffDelayMs(attempts, random));
}

/**
 * Se si e' esaurita la pazienza.
 *
 * Smettere e' una decisione, non una resa: un lavoro che continua a fallire non
 * si aggiusta ritentandolo altre mille volte, e finche' resta in coda nessuno
 * lo guarda. La lettera morta e' lo stato che lo rende visibile.
 */
export function isExhausted(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS;
}

/**
 * La chiave di deduplica per un lavoro legato a un negozio.
 *
 * Tipo, negozio e finestra. Non c'e' altro dentro di proposito: se ci finisse
 * un dato che cambia a ogni richiesta — un istante al millisecondo, un id di
 * sessione — la deduplica non dedurrebbe piu' niente, e due clic tornerebbero a
 * produrre due corse sovrapposte, che e' il guasto da cui e' partito tutto.
 */
export function dedupKeyFor(type: SyncRequestType, shopId: string | null, at: Date): string {
  const finestra = Math.floor(at.getTime() / DEDUP_WINDOW_MS);
  return `${type}:${shopId ?? 'senza-negozio'}:${finestra}`;
}

/**
 * La chiave di deduplica per un lavoro che ne ha gia' una sua.
 *
 * Una richiesta di conformita' e' identificata dalla sua riga su Postgres: la
 * stessa non deve produrre due item nemmeno a distanza di giorni, quindi qui la
 * finestra non c'entra e sarebbe anzi dannosa.
 */
export function naturalDedupKey(type: SyncRequestType, chiave: string): string {
  return `${type}:${chiave}`;
}

/** Il tetto di lunghezza di `lastError`: la colonna e' un log, non un archivio. */
const MAX_ERROR_LEN = 500;

const REDAZIONI: Array<[RegExp, string]> = [
  // Le credenziali dentro un indirizzo: `postgresql://utente:parola@host`.
  [/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://[credenziali]@'],
  // Un'autorizzazione riportata per esteso.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [omesso]'],
  // `token=...`, `apikey: ...`, `"password": "..."` e simili.
  [
    /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|signature)\b(["']?\s*[:=]\s*["']?)[^\s"',;)&]+/gi,
    '$1$2[omesso]',
  ],
  // Un indirizzo email: nei messaggi di PostgREST ci finisce il filtro della
  // query, e il filtro sui clienti e' spesso proprio l'email della persona.
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  // Quel che resta e sembra una chiave: una sequenza lunga senza spazi ne'
  // vocali di comodo. Prende i JWT, gli hex a 64 caratteri, i service role.
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[omesso]'],
];

/**
 * Il messaggio d'errore, ripulito di quel che non deve finire in una colonna.
 *
 * Non e' zelo: `lastError` la si legge in un log, in un pannello, in una
 * segnalazione incollata in chat. Un errore di Supabase riporta volentieri
 * l'URL con dentro la chiave, e un errore di PostgREST riporta il filtro della
 * query — che sui clienti e' l'email di una persona. Un messaggio d'errore e'
 * il posto piu' facile del mondo dove far uscire un segreto senza volerlo.
 */
export function redactError(error: unknown): string {
  const grezzo =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'errore sconosciuto';

  let pulito = grezzo;
  for (const [cerca, sostituisci] of REDAZIONI) pulito = pulito.replace(cerca, sostituisci);

  return pulito.length > MAX_ERROR_LEN ? `${pulito.slice(0, MAX_ERROR_LEN)}…` : pulito;
}
