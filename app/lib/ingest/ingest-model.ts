// app/lib/ingest/ingest-model.ts
//
// Le regole della credenziale di ingest, senza database e senza rete sotto.
//
// COSA C'ERA PRIMA, in una riga: le rotte che SCRIVONO — la riga del browser,
// le etichette, il legame fra un browser e una persona — chiedevano lo stesso
// identico token con cui il proxy SERVE i dati. Un merchant che avesse dato
// quella chiave a un'agenzia per far leggere i propri dati le aveva dato anche
// il permesso di creare browser e di tentare legami di identita', e quelle
// scritture passano dalla chiave di servizio del suo progetto, che salta le
// RLS. Una credenziale di sola lettura scriveva con i privilegi massimi.
//
// LE QUATTRO COSE CHE MANCAVANO, e che stanno tutte qui dentro come regole
// pure, provabili senza niente attorno:
//
//  1. LA SEPARAZIONE. Leggere e scrivere sono due permessi diversi, quindi sono
//     due credenziali diverse. La chiave di ingest NON si deriva da quella di
//     lettura — se si derivasse, chi ha l'una avrebbe l'altra e non avremmo
//     separato niente, avremmo solo cambiato nome alla stessa cosa.
//  2. IL DESTINATARIO DICHIARATO. Ogni firma dice a chi e' rivolta
//     (`audience`), con che versione di regole e' stata composta, e per quale
//     ambito. Una firma valida per un destinatario non vale per un altro: e' la
//     differenza fra un lasciapassare e un biglietto.
//  3. LA FINESTRA. Una firma ha un istante dentro, e vale per pochi minuti
//     attorno a quello. Senza, una richiesta catturata una volta si potrebbe
//     rigiocare per sempre, ed e' la forma piu' semplice di attacco contro un
//     endpoint pubblico che accetta scritture.
//  4. LA QUOTA. Per negozio e per credenziale, non per indirizzo IP — vedi
//     sotto perche' l'IP non e' un'identita'.
//
// Nessun import, come per `queue-model`, `revocation-model` e `inbox-model`: un
// modulo che non tocca Prisma ne' `crypto` si prova in un secondo, e la
// finestra, la profondita' e il secchiello sono esattamente le regole che
// nessuno proverebbe se vivessero dentro una rotta.

/**
 * A chi sono rivolte queste credenziali.
 *
 * Scritto dentro la stringa firmata e non solo accanto: una firma composta per
 * un altro destinatario — un domani, un'altra superficie della stessa app —
 * non deve poter essere presentata qui e risultare valida. Finche' c'e' un
 * destinatario solo sembra cerimonia; il giorno in cui ce ne sono due, senza
 * questo campo sono lo stesso.
 */
export const INGEST_AUDIENCE = 'ingest';

/**
 * La versione delle regole con cui una firma e' composta.
 *
 * Sta nella stringa firmata e nel prefisso della firma (`v1=`), cosi' il giorno
 * in cui la composizione cambia si possono accettare le due forme insieme per
 * una finestra invece di rompere ogni installazione nello stesso istante. Le
 * impronte GDPR hanno imparato questa lezione al contrario: erano nate senza
 * prefisso, e quando la firma e' cambiata si e' dovuto tenere in piedi un ramo
 * di verifica per le vecchie.
 */
export const INGEST_VERSION = 1;

/**
 * Cosa una credenziale di ingest puo' scrivere.
 *
 * Tre ambiti e non uno, perche' sono tre scritture con tre pesi diversi:
 *
 *  - `ingest:identity` conia e registra l'identificativo di un browser. E' il
 *    meno pesante: crea una riga anonima.
 *  - `ingest:browsers` scrive le etichette di quella riga (browser,
 *    dispositivo). Non riconosce nessuno: al peggio sporca un segmento.
 *  - `ingest:links` lega un browser a una persona con nome e cognome. E' la
 *    scrittura piu' pesante che questa app sappia fare, ed e' l'unica che, se
 *    ottenuta da chi non doveva, permette di attribuirsi gli acquisti di
 *    qualcun altro.
 *
 * Ogni rotta chiede SOLO il proprio. Un ambito unico "puo' scrivere" avrebbe
 * dato a chi installa il ponte in vetrina — che ha bisogno del primo — anche il
 * terzo, cioe' avrebbe rifatto in piccolo lo stesso errore da cui si parte.
 */
export const INGEST_SCOPES = ['ingest:identity', 'ingest:browsers', 'ingest:links'] as const;

export type IngestScope = (typeof INGEST_SCOPES)[number];

export function isIngestScope(value: unknown): value is IngestScope {
  return (INGEST_SCOPES as readonly unknown[]).includes(value);
}

/** Gli ambiti che una credenziale nuova riceve: tutti, ed e' una scelta. */
export const DEFAULT_INGEST_SCOPES: readonly IngestScope[] = INGEST_SCOPES;

/**
 * Il prefisso del valore mostrato al merchant.
 *
 * Diverso da `spx_` di proposito. I due valori si copiano a pochi centimetri
 * l'uno dall'altro dentro la stessa card, e un merchant che ne incolla uno al
 * posto dell'altro deve ottenere un rifiuto immediato e comprensibile, non una
 * scrittura che sembra funzionare.
 */
export const INGEST_PREFIX = 'kin_';

/**
 * Quanto a lungo la credenziale sostituita continua a valere.
 *
 * LA ROTAZIONE NON E' UN INTERRUTTORE. Fra il momento in cui il merchant
 * preme "ruota" e il momento in cui il valore nuovo e' pubblicato nel suo
 * container o nel suo Worker passano minuti, a volte giorni: chi deve
 * modificare un container server-side non lo fa dal telefono. Senza questa
 * finestra la rotazione sarebbe un'interruzione del tracciamento, e una misura
 * di sicurezza che si paga con un'interruzione e' una misura che nessuno usa.
 *
 * Quarantotto ore: abbastanza per attraversare un fine settimana, poche
 * abbastanza perche' una credenziale sostituita non resti in giro un mese.
 *
 * LA REVOCA NON HA NESSUNA FINESTRA, ed e' il contrario per costruzione: si
 * revoca quando si sa che una chiave e' in mano a qualcun altro, e "vale ancora
 * per due giorni" sarebbe esattamente la risposta sbagliata.
 */
export const INGEST_ROTATION_OVERLAP_MS = 48 * 60 * 60 * 1000;

/**
 * Perche' una credenziale non vale.
 *
 * Nominati uno per uno e non ridotti a un booleano perche' chi risponde ne fa
 * cose diverse: il log li distingue (una chiave revocata che continua a essere
 * usata e' una notizia, una scaduta e' routine), mentre al chiamante esce
 * sempre e solo un 401 — dire quale dei tre sarebbe raccontare a chi prova
 * chiavi a caso quanto si e' avvicinato.
 */
export type IngestKeyRefusal = 'unknown' | 'revoked' | 'expired' | 'wrong_audience' | 'out_of_scope';

/** Quel che di una credenziale serve a decidere se vale. */
export interface IngestKeyFacts {
  audience: string | null | undefined;
  scopes: readonly string[] | null | undefined;
  revokedAt: Date | null | undefined;
  /** Fine della finestra di sovrapposizione dopo una rotazione. null = nessuna. */
  expiresAt: Date | null | undefined;
}

/**
 * La credenziale vale, adesso, per questo ambito?
 *
 * L'ordine dei rifiuti non e' indifferente: la revoca viene prima della
 * scadenza perche' e' piu' grave e va vista nel log anche quando la chiave era
 * gia' scaduta per conto suo, e il destinatario viene prima dell'ambito perche'
 * una firma rivolta altrove non e' "quasi giusta", e' di un altro discorso.
 */
export function ingestKeyRefusal(
  key: IngestKeyFacts,
  scope: IngestScope,
  now: Date,
): IngestKeyRefusal | null {
  if (key.revokedAt != null) return 'revoked';
  if (key.expiresAt != null && key.expiresAt.getTime() <= now.getTime()) return 'expired';
  if ((key.audience ?? '') !== INGEST_AUDIENCE) return 'wrong_audience';
  if (!(key.scopes ?? []).includes(scope)) return 'out_of_scope';
  return null;
}

/**
 * Il tetto del corpo, in byte.
 *
 * Sedici kilobyte. Il corpo che le rotte di scrittura accettano e' un oggetto
 * piatto con cinque chiavi: un identificativo, un'email, un telefono e due
 * etichette. Anche con valori generosi non arriva a un kilobyte. Il tetto non
 * serve a contenere il caso normale — quello sta comodo cento volte dentro —
 * serve a fermare il caso ostile PRIMA di averlo letto tutto: senza, un corpo
 * da cinquanta megabyte viene scaricato per intero, tenuto in memoria e poi
 * passato a `JSON.parse`, e a quel punto il danno e' fatto anche se il parse
 * fallisce.
 */
export const MAX_INGEST_BODY_BYTES = 16 * 1024;

/**
 * La profondita' massima del JSON.
 *
 * Sei livelli su un oggetto che ne ha uno. Non e' il nesting a fare male di per
 * se': e' che `JSON.parse` e' ricorsivo, e un documento di pochi kilobyte fatto
 * di sole parentesi aperte — `[[[[[[…]]]]]]` — costa uno stack proporzionale
 * alla profondita'. Con il solo tetto sui byte quel documento passerebbe: sta
 * comodo in sedici kilobyte e porta dentro decine di migliaia di livelli.
 *
 * Si conta PRIMA del parse, sul testo, scorrendolo una volta sola. Contarla
 * dopo vorrebbe dire contarla quando il parse e' gia' avvenuto, cioe' non
 * contarla.
 */
export const MAX_INGEST_JSON_DEPTH = 6;

/**
 * La profondita' di annidamento di un testo JSON, senza parsarlo.
 *
 * Scorre i caratteri una volta sola e si ferma appena supera il tetto: su un
 * documento ostile non paga il costo di leggerlo tutto.
 *
 * Le stringhe vanno saltate, e non e' un dettaglio: un valore come
 * `"{{{{{{{{"` non e' annidamento, e' testo. Contarlo come parentesi vorrebbe
 * dire rifiutare un'email con una graffa dentro — cioe' trasformare una difesa
 * in un guasto per chi non c'entra niente. L'escape (`\"`) va rispettato per lo
 * stesso motivo, al contrario: senza, una stringa che finisce con una virgoletta
 * protetta farebbe credere allo scanner di essere uscito quando e' ancora dentro.
 */
export function jsonDepthWithin(raw: string, max: number = MAX_INGEST_JSON_DEPTH): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      depth++;
      if (depth > max) return false;
    } else if (c === '}' || c === ']') {
      depth--;
    }
  }

  return true;
}

/**
 * Per quanto vale una firma attorno al suo istante.
 *
 * Cinque minuti, in tutti e due i sensi. Larga abbastanza da sopportare gli
 * orologi storti — un container server-side che sbaglia di un minuto e mezzo e'
 * normale, e una finestra stretta lo farebbe rifiutare senza che nessuno capisca
 * perche' — e stretta abbastanza da rendere inutile catturare una richiesta per
 * rigiocarla domani.
 *
 * SIMMETRICA, cioe' si rifiuta anche una firma datata nel FUTURO. Un chiamante
 * onesto non ha nessun motivo di datare avanti; chi lo fa si sta comprando una
 * validita' che comincia dopo, ed e' il modo in cui una finestra "solo
 * all'indietro" diventa una finestra lunga quanto si vuole.
 */
export const INGEST_SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** L'istante della firma e' dentro la finestra? */
export function timestampWithinWindow(
  timestampMs: number,
  now: Date,
  window: number = INGEST_SIGNATURE_WINDOW_MS,
): boolean {
  if (!Number.isFinite(timestampMs)) return false;
  return Math.abs(now.getTime() - timestampMs) <= window;
}

/** Il tetto alla chiave di idempotenza: e' un'etichetta, non un corpo. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * La stringa su cui si calcola la firma.
 *
 * OGNI PEZZO C'E' PER UN ATTACCO PRECISO, e toglierne uno riapre esattamente
 * quello:
 *
 *  - la VERSIONE e il DESTINATARIO, perche' una firma composta altrove o
 *    domani non valga qui e adesso;
 *  - l'AMBITO, perche' una firma catturata su una rotta leggera non si possa
 *    ripresentare su quella che lega browser e persone;
 *  - l'ISTANTE, perche' una richiesta catturata scada;
 *  - il METODO e il PERCORSO, perche' una firma per `/rest/v1/users` non valga
 *    su `/rest/v1/identify` — senza, l'ambito lo sceglierebbe chi chiama;
 *  - l'IMPRONTA DEL CORPO, perche' il corpo non si possa cambiare tenendo la
 *    firma. E' l'impronta e non il corpo: la firma si verifica senza aver
 *    ancora deciso se il corpo si puo' leggere per intero, e infilarci dentro
 *    megabyte sarebbe il contrario del tetto di poco sopra;
 *  - la CHIAVE DI IDEMPOTENZA, perche' due richieste identiche mandate a un
 *    secondo di distanza siano distinguibili l'una dall'altra. Senza, la
 *    difesa dal replay non avrebbe niente su cui appoggiarsi: due invii uguali
 *    sarebbero indistinguibili da un invio catturato e ripetuto.
 *
 * A righe e non concatenata di fila: un separatore che non puo' comparire nei
 * pezzi impedisce che due composizioni diverse producano la stessa stringa
 * (`ab`+`c` e `a`+`bc`). I pezzi sono tutti privi di a capo per costruzione —
 * un metodo, un percorso, due numeri, due valori esadecimali.
 */
export function canonicalIngestPayload(params: {
  scope: IngestScope;
  timestampMs: number;
  method: string;
  path: string;
  bodyDigest: string;
  idempotencyKey: string;
}): string {
  return [
    `v${INGEST_VERSION}`,
    INGEST_AUDIENCE,
    params.scope,
    String(params.timestampMs),
    params.method.toUpperCase(),
    params.path,
    params.bodyDigest,
    params.idempotencyKey,
  ].join('\n');
}

/**
 * Quanta roba il secchiello di un negozio tiene, e quanto in fretta si ricarica.
 *
 * IL TRAFFICO DA UN CONTAINER SERVER-SIDE ARRIVA A RAFFICHE, e questa e' la
 * ragione della forma. Non e' un flusso costante: e' una campagna che parte, un
 * post che gira, una fascia oraria che concentra meta' delle visite del giorno
 * in venti minuti. Una soglia "N al secondo" tarata sulla media rifiuta proprio
 * il momento per cui il merchant ci paga; tarata sul picco non limita niente.
 *
 * Il secchiello tiene le due cose separate: la CAPIENZA e' quanto puo' arrivare
 * tutto insieme senza che nessuno si lamenti, la RICARICA e' quanto si sostiene
 * a lungo andare. Trecento in un colpo e quaranta al secondo di regime: sono
 * numeri larghi per una vetrina vera e stretti per chi vuole usare la
 * credenziale di un negozio per scrivergli dentro un milione di righe.
 */
export const INGEST_BUCKET_CAPACITY = 300;
export const INGEST_BUCKET_REFILL_PER_SEC = 40;

/**
 * Il secchiello per singola provenienza, dentro quello del negozio.
 *
 * L'INDIRIZZO IP E' UN SEGNALE, NON UN'IDENTITA', e la differenza si vede
 * proprio qui. Non autorizza niente (a dire di chi e' la richiesta e' la
 * credenziale, sempre), non compare in nessun log, e quando non si sa nulla
 * dell'indirizzo — dietro una rete che non lo dichiara, o un valore che non
 * sappiamo leggere — questo secchiello semplicemente non si guarda: chi non ha
 * un indirizzo non viene penalizzato per non averlo.
 *
 * Serve a una cosa sola: impedire che una sola provenienza impazzita consumi
 * per intero la quota del negozio e faccia rifiutare le richieste di tutte le
 * altre. E' una ripartizione, non un controllo d'accesso.
 */
export const INGEST_SOURCE_CAPACITY = 150;
export const INGEST_SOURCE_REFILL_PER_SEC = 20;

/** Lo stato di un secchiello fra una richiesta e l'altra. */
export interface TokenBucket {
  tokens: number;
  updatedAt: number;
}

export interface BucketDecision {
  allowed: boolean;
  /** Quanti secondi aspettare prima di riprovare. 0 quando si passa. */
  retryAfterSeconds: number;
  /** Lo stato aggiornato del secchiello, da riscrivere dove stava. */
  next: TokenBucket;
}

/**
 * Un gettone dal secchiello, o il tempo da aspettare.
 *
 * Funzione pura e con l'istante iniettato: un limite di frequenza che legge
 * l'orologio da se' non si puo' provare ne' al millisecondo prima ne' a quello
 * dopo, che sono le sole due prove che dicano qualcosa. Era la ragione per cui
 * i limiti di frequenza, di solito, non hanno test.
 *
 * `Retry-After` arrotondato per eccesso e mai zero quando si rifiuta: dire
 * "riprova fra zero secondi" a un container che ti ha appena saturato e' un
 * invito a rifarlo subito.
 */
export function takeToken(
  bucket: TokenBucket | undefined,
  now: number,
  capacity: number,
  refillPerSec: number,
): BucketDecision {
  const previous = bucket ?? { tokens: capacity, updatedAt: now };

  // Il tempo passato si converte in gettoni, fino alla capienza. Il `max(0)`
  // copre l'orologio che va indietro — succede, e senza di lui un salto
  // all'indietro toglierebbe gettoni invece di non aggiungerne.
  const elapsed = Math.max(0, now - previous.updatedAt) / 1000;
  const tokens = Math.min(capacity, previous.tokens + elapsed * refillPerSec);

  if (tokens >= 1) {
    return { allowed: true, retryAfterSeconds: 0, next: { tokens: tokens - 1, updatedAt: now } };
  }

  const seconds = Math.ceil((1 - tokens) / refillPerSec);
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, seconds),
    // Lo stato si riscrive comunque: il rifiuto non ricarica e non azzera, il
    // tempo continua a passare. Non riscriverlo vorrebbe dire che una raffica
    // di rifiuti congela `updatedAt` e il secchiello non si ricarica piu'.
    next: { tokens, updatedAt: now },
  };
}

/**
 * Fino a quando le rotte di scrittura accettano ancora il token di lettura.
 *
 * LA FASE DI CONVIVENZA, e perche' ha una data e non un interruttore. Il valore
 * di lettura sta incollato dentro il container o il Worker di ogni negozio gia'
 * installato: spegnerlo il giorno del rilascio vorrebbe dire spegnere il
 * tracciamento a tutti insieme, e il merchant se ne accorgerebbe dai dati che
 * non arrivano piu', non da un messaggio. Tenerlo per sempre vorrebbe dire non
 * aver chiuso niente: la falla resta aperta esattamente quanto la buona volonta'
 * di chi deve aggiornare.
 *
 * Quindi una data, scritta, con l'adozione misurata mentre si avvicina. Chi ha
 * gia' aggiornato non se ne accorgera'; chi non l'ha fatto lo legge in
 * Impostazioni molto prima che smetta di funzionare.
 *
 * Si sposta da qui e da nessun altro posto. `INGEST_LEGACY_SUNSET` in ambiente
 * la anticipa (mai la posticipa: vedi `legacySunsetAt`), ed e' cosi' che si
 * prova la giornata dopo senza aspettarla.
 */
export const INGEST_LEGACY_SUNSET_DEFAULT = '2026-12-01T00:00:00.000Z';

/**
 * La data di spegnimento davvero in vigore.
 *
 * Una variabile d'ambiente puo' solo ANTICIPARLA. Poterla spostare in avanti
 * vorrebbe dire che la scadenza della fase di convivenza si rimanda con una
 * riga di configurazione — ed e' esattamente cosi' che una fase breve diventa
 * permanente. Un valore illeggibile vale come nessun valore.
 */
export function legacySunsetAt(raw?: string | null): Date {
  const standard = new Date(INGEST_LEGACY_SUNSET_DEFAULT);
  if (!raw) return standard;

  const richiesta = new Date(raw);
  if (Number.isNaN(richiesta.getTime())) return standard;

  return richiesta.getTime() < standard.getTime() ? richiesta : standard;
}

/** Il token di lettura vale ancora sulle rotte di scrittura? */
export function legacyWriteStillAllowed(now: Date, sunset: Date): boolean {
  return now.getTime() < sunset.getTime();
}

/**
 * Ogni quanto si riscrive "questo negozio ha scritto con la chiave nuova".
 *
 * La metrica di adozione e' una data, non un contatore, e questa e' la ragione:
 * un contatore vorrebbe dire una scrittura sul database owner a ogni richiesta
 * di ogni negozio — su una rotta pubblica chiamata a ogni visita — per
 * rispondere a una domanda che si fa una volta a settimana. Una data aggiornata
 * al massimo ogni dieci minuti risponde alla stessa domanda ("chi ha ancora
 * bisogno della vecchia?") al costo di una scrittura ogni dieci minuti per
 * negozio.
 */
export const INGEST_ADOPTION_THROTTLE_MS = 10 * 60 * 1000;

/** Se la data di adozione va riscritta, o se quella che c'e' basta ancora. */
export function adoptionNeedsWrite(
  last: Date | null | undefined,
  now: Date,
  throttle: number = INGEST_ADOPTION_THROTTLE_MS,
): boolean {
  if (!last) return true;
  return now.getTime() - last.getTime() >= throttle;
}
