// app/lib/ingest/ingest-guard.server.ts
//
// Il cancello unico delle rotte che SCRIVONO.
//
// PERCHE' UNO SOLO. Le tre rotte di scrittura facevano ognuna il proprio
// controllo, con le stesse righe copiate tre volte: estrai il token, risolvi il
// negozio, guarda se puo'. Copiate tre volte vuol dire che il giorno in cui la
// regola cambia si aggiornano due punti su tre, e il terzo resta com'era — che
// e' esattamente come `/rest/v1/tracking_id` era rimasta l'unica senza il
// controllo sullo stato del negozio. Qui la domanda si fa in un posto, e chi
// chiama non ricompone niente: chiede un ambito per nome e riceve o il permesso
// o la risposta gia' pronta da restituire.
//
// DUE MODI DI PRESENTARSI, E NON VALGONO LA STESSA COSA. Il cancello li tiene
// distinti fino in fondo — nella decisione, nel log, in quel che chi chiama
// riceve — perche' appiattirli vorrebbe dire raccontarsi che la protezione piu'
// debole sia quella che abbiamo:
//
//   1. `signed` — quattro intestazioni e una firma HMAC. Il segreto non viaggia
//      e il replay e' chiuso dalla finestra piu' la chiave di idempotenza. E' la
//      strada per chi PUO' firmare: un Worker, un container che si gestisce.
//   2. `ingest_bearer` — la chiave di invio presentata intera, su TLS, nello
//      stesso campo dove prima andava quella di lettura. CHIUDE IL PRIVILEGIO:
//      chi legge non scrive, gli ambiti sono quelli della chiave, la revoca la
//      spegne subito. NON CHIUDE IL REPLAY: il valore viaggia a ogni richiesta,
//      e una richiesta catturata si puo' rigiocare finche' la chiave vive.
//      Esiste perche' sul container server-side di un provider gestito la firma
//      non e' praticabile — `hmacSha256` vuole una chiave in un file puntato da
//      una variabile d'ambiente del server, che li' non c'e' — e una difesa che
//      nessuno puo' installare non difende nessuno.
//
// E UNO SOLO CHE NON C'E' PIU': la chiave di LETTURA su una rotta che scrive.
// C'e' stata una fase in cui veniva ancora accettata, per non spegnere il
// tracciamento ai negozi gia' installati mentre aggiornavano il container. Non
// c'erano negozi da proteggere, e una fase che protegge nessuno tenuta in vita
// e' solo la promessa che quella strada si riapre cambiando una variabile
// d'ambiente. Adesso chi presenta la chiave di lettura qui riceve un rifiuto, e
// il log lo chiama per nome — `read_key_on_write_route` — perche' incollare
// l'una al posto dell'altra resta l'errore piu' probabile di tutta la
// configurazione, e chi guarda il log deve riconoscerlo senza indovinare.
//
// L'ORDINE DEI CONTROLLI E' LA PARTE CHE CONTA, e non e' arbitrario: ogni passo
// costa piu' del precedente, e nessun passo caro si paga per una richiesta che
// un passo a buon mercato avrebbe gia' rifiutato.
//
//   1. LE INTESTAZIONI. Solo lettura di stringhe. Chi non porta una credenziale
//      riconoscibile si ferma qui, senza aver toccato il database.
//   2. IL NEGOZIO E LA CREDENZIALE. Una interrogazione indicizzata. Da qui si sa
//      di chi si parla, ed e' la prima cosa che serve per tutto il resto.
//   3. IL PERMESSO. La policy delle capacita', `ingest_tracking`, che e'
//      DIVERSA da quella di lettura (vedi `authz/capabilities`).
//   4. LA QUOTA. In memoria, per negozio e credenziale. Viene prima del corpo
//      perche' rifiutare senza leggere costa meno che leggere per rifiutare.
//   5. IL CORPO, con i suoi due tetti, e sempre prima del parse completo.
//   6. LA FIRMA e la finestra, sull'impronta del corpo appena letto.
//   7. LA RIPETIZIONE, dentro la finestra.
//
// Gli ultimi due valgono per la sola strada firmata, e non perche' siano
// facoltativi: non c'e' niente da verificare dove non c'e' nessuna firma. E'
// esattamente la differenza fra i due livelli, e sta scritta dove si decide.
//
// LA CHIAVE DI SERVIZIO NON ESCE DA QUI. Non entra in nessuna risposta, in
// nessun log e in nessun messaggio d'errore: arriva decifrata dentro il
// contesto, viene usata per costruire il client verso il progetto del merchant
// e muore con la richiesta. E' la ragione per cui queste rotte esistono — il
// merchant non deve avere quella chiave nel proprio container — e sarebbe uno
// spreco perderla in un log.

import { prisma } from '~/db.server';
import { decrypt } from '~/utils/crypto.server';
import { can } from '~/lib/authz/capabilities';
import { CAPABILITY_SHOP_SELECT, shopCapabilitiesWithPlan } from '~/lib/authz/shop-capabilities.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { extractReadProxyToken } from '~/lib/read-proxy/token.server';
import type { Prisma } from '@prisma/client';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  adoptionNeedsWrite,
  canonicalIngestPayload,
  ingestKeyRefusal,
  timestampWithinWindow,
  type IngestScope,
} from './ingest-model';
import {
  findIngestKey,
  ingestValueMatches,
  openIngestSecret,
  parseIngestCredential,
  signIngestPayload,
  signaturesMatch,
  touchIngestKey,
} from './ingest-key.server';
import { bodyDigest, readBoundedJsonBody } from './ingest-body.server';
import { requestSource, takeIngestSlot } from './ingest-rate-limit.server';
import { claimIdempotencyKey } from './ingest-replay.server';

/**
 * Le intestazioni della strada FIRMATA.
 *
 * Nomi nostri e non `Authorization`, e adesso che anche la chiave di invio puo'
 * viaggiare li' dentro il motivo e' ancora piu' netto: `Authorization` porta un
 * VALORE, queste portano una FIRMA e il suo contorno. Sovrapporle vorrebbe dire
 * non poter piu' dire quale delle tre forme il chiamante intendesse presentare.
 *
 * Chi manda l'identificativo di chiave qui dentro sta chiedendo la strada
 * firmata, e da quel momento le altre tre intestazioni sono obbligatorie: non si
 * ricade sulle altre due forme, mai. Chi non lo manda si distingue dal valore
 * che presenta — `kin_…` e' la chiave di invio, tutto il resto e' la vecchia.
 */
export const INGEST_KEY_HEADER = 'X-Kerdon-Key-Id';
export const INGEST_TIMESTAMP_HEADER = 'X-Kerdon-Timestamp';
export const INGEST_SIGNATURE_HEADER = 'X-Kerdon-Signature';
export const INGEST_IDEMPOTENCY_HEADER = 'X-Kerdon-Idempotency-Key';

/** Quel che serve per parlare con il progetto del merchant, e nient'altro. */
export interface ShopIngestContext {
  shopId: string;
  projectRef: string;
  serviceRoleKey: string;
  customersEnabled: boolean;
}

/**
 * COME la credenziale e' arrivata. E' il campo che non va appiattito.
 *
 * QUALE credenziale abbia aperto non e' piu' una domanda — ce n'e' una sola che
 * apra queste rotte — ma COME sia arrivata lo e' ancora: `signed` e
 * `ingest_bearer` usano la stessa chiave e chiudono lo stesso privilegio, e
 * solo la prima chiude il replay. Tenerle separate qui e nel log e' l'unico
 * modo di sapere, guardando il traffico vero, quanta parte di esso abbia la
 * protezione piena e quanta no.
 */
export type IngestPresentationKind = 'signed' | 'ingest_bearer';

export interface IngestAllowed {
  ok: true;
  ctx: ShopIngestContext;
  /** Il corpo gia' parsato, dentro i due tetti. */
  body: Record<string, unknown>;
  /** In quale delle due forme si e' presentata. */
  presentation: IngestPresentationKind;
  /**
   * Chiude la riga di log con l'esito e la latenza.
   *
   * Sta qui e non nella rotta perche' i campi del log devono essere gli stessi
   * su tutte e tre le rotte: il momento in cui ognuna se li sceglie e' il
   * momento in cui una di loro ci mette dentro un'email.
   */
  finish: (outcome: string, status?: number) => void;
}

export interface IngestRefused {
  ok: false;
  /** Gia' pronta: chi chiama la restituisce e basta. */
  response: Response;
}

export type IngestDecision = IngestAllowed | IngestRefused;

/**
 * Il permesso di scrivere, per questa richiesta e per questo ambito.
 *
 * `route` e' l'etichetta che finisce nel log — il percorso e non il contenuto —
 * e serve a distinguere le tre rotte quando si guarda cosa sta succedendo.
 */
export async function authorizeIngest(
  request: Request,
  params: {
    scope: IngestScope;
    route: string;
    /**
     * `'none'` per la rotta che non porta nessun corpo.
     *
     * Non e' un caso limite da tollerare: e' la rotta che conia
     * l'identificativo, che il container chiama in GET con la sola
     * querystring. La firma copre lo stesso l'impronta di un corpo — quella
     * della stringa vuota — perche' un ramo "qui la firma e' fatta diversamente"
     * e' un ramo in cui, prima o poi, la firma non c'e' piu'.
     */
    body?: 'json' | 'none';
    now?: Date;
  },
): Promise<IngestDecision> {
  const now = params.now ?? new Date();
  const iniziato = Date.now();

  // 1. Le intestazioni. Nessun database ancora toccato.
  //
  // Si legge PRIMA di aprire la riga di log, e la forma entra in ogni riga che
  // questa richiesta scrivera': una riga di rifiuto che non dice in che forma il
  // chiamante si era presentato costringe a indovinarlo, ed e' proprio la
  // domanda per cui il log esiste.
  const presentata = readPresentation(request);
  // Il nome della forma nel log e' quello del tipo, senza traduzioni in mezzo:
  // una tabella che mappasse gli uni negli altri sarebbe un posto in piu' da
  // aggiornare il giorno in cui una forma si aggiunge, e il modo tipico di
  // dimenticarselo e' che i log continuino a passare senza dire niente.
  const via: string = presentata.kind;
  const log = (
    outcome: string,
    status: number,
    extra: { shop?: string | null; key?: string | null; limit?: string } = {},
  ) => logIngest({ route: params.route, outcome, status, ms: Date.now() - iniziato, via, ...extra });

  if (presentata.kind === 'malformed') {
    return refuse(log, 'bad_presentation', 401, { error: 'unauthorized' });
  }
  if (presentata.kind === 'no_credential') {
    return refuse(log, 'no_credential', 401, { error: 'unauthorized' });
  }
  if (presentata.kind === 'read_key') {
    // Un valore c'e', ma non e' una chiave di invio: quasi sempre e' quella di
    // lettura, incollata nel campo sbagliato. L'esito ha un nome suo apposta —
    // confuso con `no_credential` costringerebbe a indovinare se il container
    // non manda niente o manda la chiave sbagliata, che sono due guasti con due
    // rimedi diversi. Al chiamante esce lo stesso 401 di sempre.
    return refuse(log, 'read_key_on_write_route', 401, { error: 'unauthorized' });
  }

  // 2/3. Il negozio, la credenziale e il permesso.
  const identificato =
    presentata.kind === 'signed'
      ? await resolveSigned(presentata, params.scope, now)
      : await resolveIngestBearer(presentata, params.scope, now);

  if (!identificato.ok) {
    return refuse(log, identificato.outcome, identificato.status, { error: identificato.error }, {
      shop: identificato.shopId ?? null,
      // L'identificativo di chiave finisce nel log anche quando il rifiuto
      // viene prima della verifica: e' pubblico, e senza di lui non si
      // distingue "una chiave revocata che continua ad arrivare" da "qualcuno
      // prova valori a caso".
      key: presentata.keyId,
    });
  }

  const { shop, ctx } = identificato;

  // 4. La quota. Prima del corpo: rifiutare senza leggere costa meno.
  const quota = takeIngestSlot({
    shopId: shop.shopId,
    keyId: identificato.keyId,
    source: requestSource(request),
    // Lo stesso istante di tutto il resto della decisione, e non `Date.now()`
    // preso qui dentro: un limite di frequenza che legge l'orologio per conto
    // suo non si puo' provare ne' al millisecondo prima ne' a quello dopo, che
    // sono le sole due prove che dicano qualcosa.
    now: now.getTime(),
  });
  if (!quota.allowed) {
    return refuse(
      log,
      'rate_limited',
      429,
      { error: 'too_many_requests' },
      { shop: shop.shopId, key: identificato.keyId, limit: quota.bucket },
      { 'Retry-After': String(quota.retryAfterSeconds) },
    );
  }

  // 5. Il corpo, con i due tetti, e sempre prima del parse completo.
  const corpo =
    params.body === 'none'
      ? ({ ok: true, raw: '', digest: bodyDigest(''), json: {} } as const)
      : await readBoundedJsonBody(request);
  if (!corpo.ok) {
    const status = corpo.refusal === 'too_large' ? 413 : 400;
    return refuse(log, `body_${corpo.refusal}`, status, { error: corpo.refusal }, {
      shop: shop.shopId,
      key: identificato.keyId,
    });
  }

  // 6/7. La firma sull'impronta del corpo, e la ripetizione dentro la finestra.
  //
  // SOLO PER LA STRADA FIRMATA, e va detto chiaro invece che lasciarlo dedurre
  // dalla condizione: su `ingest_bearer` non c'e' nessuna firma da verificare e
  // nessuna finestra che scada, quindi UNA RICHIESTA CATTURATA SI PUO'
  // RIGIOCARE finche' quella chiave vive. Non si finge il contrario con una
  // chiave di idempotenza presa dalle intestazioni: chi rigioca la cambierebbe,
  // e resterebbe solo l'apparenza di una difesa. Chi ha bisogno di chiudere
  // anche il replay firma — e chi non puo' firmare deve saperlo, non crederlo
  // chiuso.
  if (presentata.kind === 'signed') {
    const verdetto = verifySignature(
      presentata,
      identificato.secret,
      { scope: params.scope, route: params.route, method: request.method },
      corpo.digest,
      now,
    );
    if (verdetto) {
      return refuse(log, verdetto, 401, { error: 'unauthorized' }, {
        shop: shop.shopId,
        key: presentata.keyId,
      });
    }

    if (!claimIdempotencyKey(presentata.keyId, presentata.idempotencyKey, now.getTime())) {
      // 409 e non 401: la firma era buona e la credenziale pure. Quel che non va
      // e' che questo messaggio l'avevamo gia' preso in carico, ed e' una
      // notizia diversa — un container che riceve 401 smette di chiamare, uno
      // che riceve 409 ha gia' ottenuto quel che voleva.
      return refuse(log, 'replayed', 409, { error: 'already_processed' }, {
        shop: shop.shopId,
        key: presentata.keyId,
      });
    }
  }

  // Le due note di servizio: quando questa credenziale e' stata usata l'ultima
  // volta, e quando questo negozio ha scritto l'ultima volta. Nessuna delle due
  // e' attesa — sono scritture che non cambiano la risposta, e far aspettare la
  // vetrina per aggiornare una data sarebbe sbagliare il prezzo delle due cose.
  void touchIngestKey(identificato.keyRowId, now);
  void recordAdoption(shop, now);

  return {
    ok: true,
    ctx,
    body: corpo.json,
    // Lo stesso valore che sta in `via`, dove il tipo e' gia' ristretto alle due
    // forme che possono passare: le altre tre — malformata, senza credenziale e
    // chiave di lettura — sono uscite molto prima.
    presentation: presentata.kind,
    finish: (outcome: string, status = 200) =>
      log(outcome, status, { shop: shop.shopId, key: identificato.keyId }),
  };
}

/* -------------------------------------------------------------------------- */
/* Le intestazioni                                                             */
/* -------------------------------------------------------------------------- */

type Presentation =
  | { kind: 'signed'; keyId: string; timestampMs: number; signature: string; idempotencyKey: string }
  | { kind: 'ingest_bearer'; keyId: string; value: string }
  | { kind: 'read_key' }
  | { kind: 'no_credential' }
  | { kind: 'malformed' };

/**
 * Cosa il chiamante sta presentando.
 *
 * SOLO LETTURA DI STRINGHE, nessun database: e' il passo che deve costare
 * niente, perche' lo paga anche chi arriva qui per sbaglio.
 *
 * L'ORDINE DELLE DUE DOMANDE. Prima l'identificativo di chiave: basta lui a
 * dichiarare che il chiamante vuole la strada firmata, e da li' in poi le altre
 * tre intestazioni sono obbligatorie — se ne manca una la richiesta e'
 * MALFORMATA, non "allora proviamo con una piu' debole". Ricadere su una forma
 * inferiore quando la superiore e' incompleta vorrebbe dire declassarsi da
 * soli, ed e' esattamente come si costruisce un downgrade: basta far sparire
 * un'intestazione per strada.
 *
 * Poi il valore presentato: `kin_…` e' la chiave di invio, qualunque altra cosa
 * non e' una credenziale per queste rotte. Le due chiavi si leggono dallo stesso
 * campo — `Authorization: Bearer` o `apikey` — perche' e' l'unico che i
 * container gestiti lascino compilare, ed e' il campo in cui il merchant
 * incollera' l'una al posto dell'altra: il prefisso e' quel che permette di non
 * confonderle mai, e di dire nel log QUALE delle due e' arrivata invece di
 * scrivere "credenziale non valida" su due guasti diversi.
 */
function readPresentation(request: Request): Presentation {
  const keyId = request.headers.get(INGEST_KEY_HEADER)?.trim();
  if (keyId) {
    const timestamp = request.headers.get(INGEST_TIMESTAMP_HEADER)?.trim();
    const signature = request.headers.get(INGEST_SIGNATURE_HEADER)?.trim();
    const idempotencyKey = request.headers.get(INGEST_IDEMPOTENCY_HEADER)?.trim();

    if (!timestamp || !signature || !idempotencyKey) return { kind: 'malformed' };
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) return { kind: 'malformed' };

    // Millisecondi interi. `Number` su una stringa strana da' NaN, e NaN non e'
    // dentro nessuna finestra: il controllo piu' in la' lo rifiuta comunque, ma
    // fermarlo qui evita di portarsi dietro un valore che non significa niente.
    const timestampMs = Number(timestamp);
    if (!Number.isFinite(timestampMs)) return { kind: 'malformed' };

    return { kind: 'signed', keyId, timestampMs, signature, idempotencyKey };
  }

  const token = extractReadProxyToken(request);
  if (!token) return { kind: 'no_credential' };

  // Qui non si autorizza niente: si legge una forma. Che il valore sia davvero
  // di una chiave viva lo dice il passo dopo, contro la riga.
  const credenziale = parseIngestCredential(token);
  if (credenziale) {
    return { kind: 'ingest_bearer', keyId: credenziale.keyId, value: credenziale.value };
  }

  // Un valore c'e' ma non ha il prefisso della chiave di invio. Non si guarda
  // se sia una chiave di lettura viva — non servirebbe a niente, perche' qui
  // non aprirebbe comunque — e soprattutto non si va a cercarla nel database:
  // interrogarlo per poi rifiutare lo stesso vorrebbe dire pagare una lettura
  // per ogni valore a caso che arriva su una rotta pubblica.
  return { kind: 'read_key' };
}

/* -------------------------------------------------------------------------- */
/* Il negozio                                                                  */
/* -------------------------------------------------------------------------- */

interface Identified {
  ok: true;
  shop: ShopRow;
  ctx: ShopIngestContext;
  /** L'identificativo pubblico della credenziale. */
  keyId: string;
  keyRowId: string;
  /**
   * Il segreto in chiaro, per verificare la firma.
   *
   * Vuoto dove non c'e' nessuna firma da verificare — la chiave presentata
   * intera — e non e' un ripiego: decifrare un segreto che nessuno usera'
   * vorrebbe dire tirarlo in chiaro nella memoria di ogni richiesta per niente.
   */
  secret: string;
}

interface NotIdentified {
  ok: false;
  outcome: string;
  status: number;
  error: string;
  shopId?: string | null;
}

async function resolveSigned(
  presentata: Extract<Presentation, { kind: 'signed' }>,
  scope: IngestScope,
  now: Date,
): Promise<Identified | NotIdentified> {
  const key = await findIngestKey(presentata.keyId);
  // Una credenziale che non esiste e una scaduta escono di qui con lo stesso
  // 401. Nel log restano distinte — una chiave revocata che continua ad
  // arrivare e' una notizia, una sconosciuta e' rumore — ma al chiamante non si
  // dice quale delle due: raccontarlo vorrebbe dire dire a chi prova chiavi a
  // caso quanto si e' avvicinato.
  if (!key) return { ok: false, outcome: 'key_unknown', status: 401, error: 'unauthorized' };

  const rifiuto = ingestKeyRefusal(key, scope, now);
  if (rifiuto) {
    return {
      ok: false,
      outcome: `key_${rifiuto}`,
      // Fuori ambito e' l'unico che non e' un 401: la credenziale c'e' ed e'
      // valida, semplicemente non e' stata emessa per questo. Dirlo non aiuta
      // nessun attacco — l'elenco degli ambiti e' pubblico — e aiuta molto chi
      // sta configurando.
      status: rifiuto === 'out_of_scope' ? 403 : 401,
      error: rifiuto === 'out_of_scope' ? 'forbidden' : 'unauthorized',
      shopId: key.shopId,
    };
  }

  const secret = openIngestSecret(key.secretCipher);
  if (!secret) {
    // Il testo cifrato non si riapre: chiave di cifratura ruotata, colonna
    // scritta male. Non e' un guasto da 500 — e' una credenziale che non si
    // puo' verificare, cioe' una richiesta non autorizzata.
    return { ok: false, outcome: 'key_unreadable', status: 401, error: 'unauthorized', shopId: key.shopId };
  }

  const caricato = await loadIngestContext({ id: key.shopId }, now);
  if (!caricato.ok) return caricato;

  return { ...caricato, keyId: key.keyId, keyRowId: key.id, secret };
}

/**
 * La chiave di invio PRESENTATA INTERA, senza firma.
 *
 * PERCHE' ESISTE, e non e' un ammorbidimento. Firmare vuol dire avere dove
 * tenere una chiave: nel sandbox di un container server-side gestito
 * `hmacSha256` vuole una chiave nominata in un file puntato da una variabile
 * d'ambiente del server, e su un provider gestito quella variabile non c'e'. Una
 * difesa che nessuno puo' installare non difende nessuno: chi non poteva firmare
 * restava sulla chiave di LETTURA, cioe' sul difetto da chiudere.
 *
 * COSA CHIUDE. Il privilegio, che e' il difetto da cui si parte: chi ha la
 * chiave per farsi servire i dati non ne scrive piu', gli ambiti restano quelli
 * emessi sulla credenziale, la revoca la spegne nell'istante in cui avviene e la
 * rotazione ha la sua finestra. Sono le stesse regole della strada firmata,
 * verificate dalla stessa funzione.
 *
 * COSA NON CHIUDE, e va scritto senza ammorbidirlo: il valore viaggia a ogni
 * richiesta. Chi riesca a leggerlo sul filo — e su TLS non e' cosa da poco — lo
 * ha intero, e una richiesta catturata si puo' rigiocare finche' quella chiave
 * vive. Non c'e' finestra che scada e non c'e' niente da confrontare. E' la
 * ragione per cui la strada firmata resta, ed e' la sola differenza fra le due.
 *
 * LA RIGA SI TROVA DALL'IDENTIFICATIVO, CHE E' PUBBLICO, e poi si confronta
 * l'impronta del valore intero: chiedere al database con il segreto dentro la
 * `WHERE` funzionerebbe, ma legherebbe la verifica di un segreto al modo in cui
 * un indice confronta le stringhe. Cosi' invece il confronto e' uno, esplicito e
 * a tempo costante.
 */
async function resolveIngestBearer(
  presentata: Extract<Presentation, { kind: 'ingest_bearer' }>,
  scope: IngestScope,
  now: Date,
): Promise<Identified | NotIdentified> {
  const key = await findIngestKey(presentata.keyId);
  if (!key) {
    return { ok: false, outcome: 'bearer_key_unknown', status: 401, error: 'unauthorized' };
  }

  if (!ingestValueMatches(key, presentata.value)) {
    // La riga c'e' ma il segreto non e' quello. Nel log si distingue
    // dall'identificativo sconosciuto perche' dice una cosa diversa: qualcuno
    // sta presentando valori per una chiave che ESISTE — o, molto piu' spesso,
    // un container e' rimasto su una credenziale gia' ruotata. Al chiamante
    // esce lo stesso identico 401 delle altre volte.
    return {
      ok: false,
      outcome: 'bearer_bad_secret',
      status: 401,
      error: 'unauthorized',
      shopId: key.shopId,
    };
  }

  const rifiuto = ingestKeyRefusal(key, scope, now);
  if (rifiuto) {
    return {
      ok: false,
      outcome: `key_${rifiuto}`,
      // Le stesse due risposte della strada firmata: gli ambiti e la revoca non
      // cambiano di peso a seconda di come la chiave e' arrivata.
      status: rifiuto === 'out_of_scope' ? 403 : 401,
      error: rifiuto === 'out_of_scope' ? 'forbidden' : 'unauthorized',
      shopId: key.shopId,
    };
  }

  const caricato = await loadIngestContext({ id: key.shopId }, now);
  if (!caricato.ok) return caricato;

  // Nessun segreto in chiaro: qui non c'e' nessuna firma da rifare.
  return { ...caricato, keyId: key.keyId, keyRowId: key.id, secret: '' };
}

/** Il negozio caricato, con i due fatti che servono alla nota di adozione. */
interface LoadedShop {
  ok: true;
  shop: ShopRow;
  ctx: ShopIngestContext;
}

interface ShopRow {
  shopId: string;
  ingestLastSignedAt: Date | null;
  hasTrackingSetup: boolean;
}

/**
 * Il negozio, il suo permesso di ingest e le sue credenziali di progetto.
 *
 * NON PASSA DALLA CACHE del proxy di lettura, ed e' voluto. Quella tiene per
 * trenta secondi una decisione gia' presa, e trenta secondi vanno benissimo per
 * servire dati gia' sincronizzati: se un negozio viene sospeso, nel peggiore dei
 * casi legge per mezzo minuto in piu' cio' che stava gia' leggendo. Qui invece
 * si SCRIVE nel database del merchant con la chiave di servizio, e mezzo minuto
 * di scritture dopo una sospensione non si disfa da solo. Una interrogazione in
 * piu' su un percorso che gia' fa un viaggio verso Supabase non si nota; una
 * scrittura che non doveva avvenire si nota eccome.
 */
async function loadIngestContext(
  where: Prisma.ShopWhereUniqueInput,
  now: Date,
): Promise<LoadedShop | NotIdentified> {
  const shop = await prisma.shop.findUnique({
    where,
    select: {
      ...CAPABILITY_SHOP_SELECT,
      id: true,
      supabaseConfig: {
        select: {
          connectionVerifiedAt: true,
          supabaseProjectRef: true,
          supabaseServiceRoleKey: true,
        },
      },
      trackingSetup: { select: { ingestLastSignedAt: true } },
    },
  });

  if (!shop) return { ok: false, outcome: 'shop_unknown', status: 401, error: 'unauthorized' };

  const plan = await findPlanByName(shop.currentPlan);
  if (!can(shopCapabilitiesWithPlan(shop, plan, now), 'ingest_tracking')) {
    // 403 e non 401: la credenziale e' valida, il negozio non puo'. Per un
    // container server-side e' "nessun dato", e la vetrina prosegue senza che
    // nessuno veda un errore.
    return { ok: false, outcome: 'not_allowed', status: 403, error: 'forbidden', shopId: shop.id };
  }

  const config = shop.supabaseConfig;
  if (!config?.supabaseProjectRef || !config.supabaseServiceRoleKey) {
    return { ok: false, outcome: 'not_configured', status: 403, error: 'forbidden', shopId: shop.id };
  }

  let serviceRoleKey: string;
  try {
    serviceRoleKey = decrypt(config.supabaseServiceRoleKey);
  } catch {
    // La chiave di servizio non si decifra: non c'e' niente da scrivere e non
    // c'e' niente da dire al chiamante oltre "non adesso". Il motivo vero sta
    // nel log, senza la chiave dentro.
    return { ok: false, outcome: 'key_undecryptable', status: 403, error: 'forbidden', shopId: shop.id };
  }

  return {
    ok: true,
    shop: {
      shopId: shop.id,
      ingestLastSignedAt: shop.trackingSetup?.ingestLastSignedAt ?? null,
      hasTrackingSetup: shop.trackingSetup != null,
    },
    ctx: {
      shopId: shop.id,
      projectRef: config.supabaseProjectRef,
      serviceRoleKey,
      customersEnabled: plan?.customersSyncEnabled ?? false,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* La firma                                                                    */
/* -------------------------------------------------------------------------- */

/** `null` quando la firma va bene; altrimenti il motivo, per il log. */
function verifySignature(
  presentata: Extract<Presentation, { kind: 'signed' }>,
  secret: string,
  params: { scope: IngestScope; route: string; method: string },
  bodyDigest: string,
  now: Date,
): string | null {
  // La finestra PRIMA della firma, e non dopo: e' il controllo che costa meno,
  // e una richiesta fuori tempo e' rifiutata comunque, che la firma torni o no.
  // Ed e' proprio il caso da fermare — una richiesta catturata, con la sua
  // firma perfettamente valida, rigiocata piu' tardi.
  if (!timestampWithinWindow(presentata.timestampMs, now)) return 'stale_timestamp';

  const atteso = signIngestPayload(
    secret,
    canonicalIngestPayload({
      scope: params.scope,
      timestampMs: presentata.timestampMs,
      // Il metodo vero della richiesta: una firma composta per una GET non deve
      // valere su una POST. E' la stessa ragione per cui c'e' il percorso.
      method: params.method,
      // Il percorso della rotta e non `request.url`: il chiamante puo'
      // attaccare una querystring, e un percorso che cambia con essa e' una
      // firma che non torna mai per una differenza che non riguarda nessuno.
      path: params.route,
      bodyDigest,
      idempotencyKey: presentata.idempotencyKey,
    }),
  );

  return signaturesMatch(presentata.signature, atteso) ? null : 'bad_signature';
}

/* -------------------------------------------------------------------------- */
/* La nota di adozione                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Quando questo negozio ha scritto l'ultima volta.
 *
 * NASCE PER MISURARE UN PASSAGGIO, E IL PASSAGGIO E' FINITO. Erano due date, e
 * la domanda era "chi scrive ancora con la chiave di lettura?": la sorella
 * `ingestLastLegacyAt` la teneva. Adesso quella strada non esiste piu' e quella
 * data non puo' piu' essere scritta da nessuno — la colonna resta dov'e', ma il
 * guardiano non la nomina, perche' un ramo che aggiorna una colonna morta e' un
 * ramo che racconta una distinzione che non c'e'.
 *
 * Quel che resta ha ancora un mestiere: e' l'unica riga che dica "da questo
 * negozio sta arrivando qualcosa", senza guardare quale delle sue chiavi.
 *
 * E' UNA DATA E NON UN CONTATORE. Un contatore vorrebbe dire una scrittura sul
 * database owner a ogni visita di ogni vetrina per rispondere a una domanda che
 * si fa una volta a settimana.
 *
 * `updateMany` e non `upsert`: un negozio che non e' mai passato dal
 * tracciamento non ha quella riga, e inventargliene una — con una risposta che
 * non ha mai dato — vorrebbe dire scriverne una falsa per tenere una statistica.
 * Quella riga esiste per ogni negozio che ha installato il ponte, che sono tutti
 * e soli quelli che arrivano qui.
 */
async function recordAdoption(shop: ShopRow, now: Date): Promise<void> {
  if (!shop.hasTrackingSetup) return;
  if (!adoptionNeedsWrite(shop.ingestLastSignedAt, now)) return;

  try {
    await prisma.trackingSetup.updateMany({
      where: { shopId: shop.shopId },
      data: { ingestLastSignedAt: now },
    });
  } catch {
    // Una statistica non fa fallire una scrittura legittima.
  }
}

/* -------------------------------------------------------------------------- */
/* Le risposte e il log                                                        */
/* -------------------------------------------------------------------------- */

function refuse(
  log: (outcome: string, status: number, extra?: { shop?: string | null; key?: string | null; limit?: string }) => void,
  outcome: string,
  status: number,
  payload: Record<string, string>,
  extra: { shop?: string | null; key?: string | null; limit?: string } = {},
  headers: Record<string, string> = {},
): IngestRefused {
  log(outcome, status, extra);
  return {
    ok: false,
    response: new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
    }),
  };
}

/**
 * La riga di log di una scrittura.
 *
 * COSA C'E' DENTRO: la rotta, il riferimento del negozio, l'identificativo
 * PUBBLICO della credenziale, l'esito, lo stato, i millisecondi e — solo quando
 * c'e' stato — quale secchiello ha detto di no.
 *
 * COSA NON CI FINISCE MAI, ed e' la meta' importante di questo commento: nessuna
 * email, nessun telefono, nessun identificativo di visitatore, nessun pezzo del
 * corpo, nessun indirizzo IP, nessuna chiave. Un dato personale finito in una
 * riga di log e' un dato uscito dal database del merchant e arrivato in un posto
 * che nessuno ha dichiarato, che nessuno pota, e dove chi cerca dati personali
 * non pensera' mai di guardare — a cominciare dal merchant stesso il giorno in
 * cui deve rispondere a una richiesta di cancellazione.
 *
 * L'identificativo del negozio c'e' perche' non e' un dato personale: e' un
 * uuid interno, non dice il dominio e non dice chi sia il titolare, e senza di
 * lui il log non risponderebbe alla sola domanda per cui esiste — "di chi e'
 * questo traffico".
 */
function logIngest(riga: {
  route: string;
  outcome: string;
  status: number;
  ms: number;
  shop?: string | null;
  key?: string | null;
  limit?: string;
  /**
   * In che forma il chiamante si e' presentato, comprese quelle che non passano.
   *
   * Risponde a due domande che nessun altro campo risponde: quanta parte del
   * traffico e' FIRMATA — cioe' quanta ha anche la difesa dal replay e non solo
   * la separazione dei privilegi — e chi sta ancora arrivando con la chiave di
   * LETTURA nel campo della chiave di invio, che non apre piu' niente ma e'
   * l'errore di configurazione piu' probabile. Senza questo campo le forme
   * finiscono indistinguibili nella stessa riga, e un merchant fermo per un
   * valore incollato male sembra identico a uno che non chiama affatto.
   */
  via?: string;
}): void {
  console.log(
    `[ingest] ${JSON.stringify({
      route: riga.route,
      shop: riga.shop ?? null,
      key: riga.key ?? null,
      outcome: riga.outcome,
      status: riga.status,
      ms: riga.ms,
      limit: riga.limit ?? null,
      via: riga.via ?? null,
      at: new Date().toISOString(),
    })}`,
  );
}
