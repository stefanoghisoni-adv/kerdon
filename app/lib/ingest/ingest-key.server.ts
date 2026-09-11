// app/lib/ingest/ingest-key.server.ts
//
// La credenziale con cui si SCRIVE, e come sta sul database owner.
//
// NON E' IL TOKEN DI LETTURA, E NON SI DERIVA DA LUI. Sembra la cosa comoda —
// una chiave sola, due permessi — e sarebbe la stessa falla con un nome nuovo:
// chi ha il valore di lettura otterrebbe quello di scrittura facendoci sopra lo
// stesso conto che facciamo noi. Sono due segreti indipendenti, generati
// separatamente, che si ruotano e si revocano l'uno senza toccare l'altro. Il
// merchant che passa la chiave di lettura a un'agenzia le sta dando la lettura
// e nient'altro: e' tutto quello che questo file esiste per garantire.
//
// COM'E' FATTA. Due pezzi con due mestieri diversi, ed e' la forma che regge
// insieme "si mostra una volta sola" e "si verifica una firma":
//
//   kin_<identificativo>.<segreto>
//
//  - L'IDENTIFICATIVO non e' segreto. Viaggia in chiaro nell'intestazione, sta
//    in chiaro nella colonna, ed e' su di lui che si cerca la riga: senza, per
//    trovare la credenziale bisognerebbe provarle tutte, oppure indicizzare il
//    segreto — che e' il contrario di quel che si vuole.
//  - Il SEGRETO non viaggia mai. Non sta nell'intestazione, non sta nella
//    richiesta, non esce da nessuna risposta dopo il momento in cui e' stato
//    emesso. Serve a calcolare una firma, e la firma e' l'unica cosa che passa
//    sul filo.
//
// PERCHE' IL SEGRETO E' CIFRATO E NON SOLO IMPRONTATO, che e' la domanda giusta
// da fare a un file come questo. Un'impronta basta per una credenziale
// PRESENTATA — la si impronta e si confronta. Ma qui la credenziale non viene
// presentata: viene usata per firmare, e per verificare una firma HMAC bisogna
// rifarla, cioe' bisogna avere il segreto. Quindi cifrato, con una chiave
// derivata sua — non `ENCRYPTION_SECRET` tale e quale — cosi' chi arrivasse ai
// token dei negozi non arriva a queste e viceversa.
//
// E ALLORA IN CHE SENSO "MOSTRATO UNA VOLTA SOLA". Nel senso che conta: non
// esiste nessuna strada di lettura che lo riporti al merchant. Il valore intero
// esiste per l'istante in cui viene emesso, dentro la risposta a chi lo ha
// chiesto, e poi non e' piu' recuperabile da nessuna schermata — al contrario
// del token di lettura, che si rilegge da Impostazioni ogni volta che serve. Chi
// lo perde ne fa uno nuovo: e' un gesto di dieci secondi, e ha una finestra di
// sovrapposizione apposta perche' non costi un'interruzione.
//
// L'IMPRONTA C'E' LO STESSO, e non e' un doppione inutile: e' quella che
// permette di dire "questa riga e' proprio la credenziale che mi hai dato"
// senza decifrare niente, ed e' cio' che rende riconoscibile un valore incollato
// per intero dove non doveva — il caso del merchant che mette la chiave di
// scrittura al posto di quella di lettura.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { prisma } from '~/db.server';
import {
  DEFAULT_INGEST_SCOPES,
  INGEST_AUDIENCE,
  INGEST_PREFIX,
  INGEST_ROTATION_OVERLAP_MS,
  INGEST_VERSION,
  type IngestScope,
} from './ingest-model';

const ALGORITMO = 'aes-256-gcm';
const IV_BYTES = 12;

/** L'etichetta con cui si deriva la chiave di cifratura. Non si tocca. */
const CIPHER_KEY_LABEL = 'kerdon:tracking-ingest-cipher:v1';

/**
 * Il segreto di base.
 *
 * `TRACKING_INGEST_SECRET`, se c'e', vince: serve a poter ruotare queste due
 * chiavi da sole, senza toccare quella con cui sono cifrati i token dei negozi.
 * Altrimenti si deriva da `ENCRYPTION_SECRET`, che c'e' sempre. E' la stessa
 * scelta gia' fatta in `gdpr/audit.server`, in `gdpr/erasure-proof.server` e in
 * `consent/revocation-subject.server`, e per la stessa ragione: aggiungere una
 * variabile obbligatoria vorrebbe dire che il giorno in cui manca non si
 * scrive piu' niente per nessuno.
 */
function segretoBase(): string {
  const dedicato = process.env.TRACKING_INGEST_SECRET;
  if (dedicato) return dedicato;

  const base = process.env.ENCRYPTION_SECRET;
  if (!base) {
    throw new Error(
      'ne TRACKING_INGEST_SECRET ne ENCRYPTION_SECRET sono configurati: impossibile emettere o verificare una credenziale di ingest',
    );
  }
  return base;
}

function chiave(etichetta: string): Buffer {
  return createHmac('sha256', segretoBase()).update(etichetta).digest();
}

/** Il valore intero, nelle due meta' che lo compongono. */
export interface IngestCredential {
  /** Quello che si mostra al merchant, una volta sola. */
  value: string;
  keyId: string;
  secret: string;
}

/**
 * Conia una credenziale nuova.
 *
 * Sedici byte per l'identificativo e trentadue per il segreto. Il primo non
 * deve essere imprevedibile — e' pubblico — ma deve essere unico senza dover
 * chiedere al database, e sedici byte casuali lo sono con un margine che non
 * vale la pena discutere. Il secondo e' la chiave di una HMAC-SHA256: sotto i
 * trentadue byte si indebolirebbe la firma, sopra non si guadagna niente.
 */
export function generateIngestCredential(): IngestCredential {
  const keyId = randomBytes(16).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  return { value: `${INGEST_PREFIX}${keyId}.${secret}`, keyId, secret };
}

/**
 * Le due meta' di un valore presentato, o niente.
 *
 * Serve a riconoscere un valore intero incollato dove non doveva — tipicamente
 * la chiave di scrittura messa al posto di quella di lettura, che nella card
 * stanno a due righe di distanza. Qui non si autorizza niente: si legge una
 * forma.
 */
export function parseIngestCredential(raw: string | null | undefined): IngestCredential | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed.startsWith(INGEST_PREFIX)) return null;

  const [keyId, secret, ...resto] = trimmed.slice(INGEST_PREFIX.length).split('.');
  // Piu' di un punto vuol dire che non e' un valore nostro: meglio rifiutarlo
  // qui che ricomporlo indovinando dove finisce una meta' e comincia l'altra.
  if (resto.length > 0) return null;
  if (!keyId || !secret) return null;

  return { value: trimmed, keyId, secret };
}

/**
 * L'impronta del valore intero.
 *
 * SHA-256 e non HMAC, al contrario dell'impronta di una revoca: li' il soggetto
 * era un identificativo breve e indovinabile, e senza una chiave chiunque
 * avesse la tabella avrebbe potuto provare gli identificativi uno per uno. Qui
 * il valore ha quarantotto byte casuali dentro: non c'e' nessun elenco da
 * provare, e una chiave in piu' non aggiungerebbe niente se non un'altra cosa
 * da ruotare.
 */
export function hashIngestValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Chiude il segreto. Stessa forma `iv:tag:testo` di tutto il resto del progetto. */
export function sealIngestSecret(secret: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITMO, chiave(CIPHER_KEY_LABEL), iv);
  const chiuso = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${chiuso.toString('hex')}`;
}

/**
 * Riapre il segreto, o dice di no.
 *
 * `null` invece di sollevare: un testo cifrato illeggibile — chiave ruotata,
 * colonna scritta male — non e' un guasto passeggero da propagare fino a un
 * 500. E' una credenziale che non si puo' verificare, cioe' una richiesta non
 * autorizzata, e va risposta come tale.
 */
export function openIngestSecret(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null;

  const parti = ciphertext.split(':');
  if (parti.length !== 3) return null;

  try {
    const [ivHex, tagHex, testoHex] = parti;
    const decipher = createDecipheriv(ALGORITMO, chiave(CIPHER_KEY_LABEL), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(testoHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * La firma di una stringa canonica con un segreto.
 *
 * Il prefisso `v1=` viaggia insieme alla firma, come per le impronte di
 * cancellazione: il giorno in cui la composizione cambia si possono accettare
 * le due forme insieme per una finestra, invece di rompere ogni installazione
 * nello stesso istante.
 */
export function signIngestPayload(secret: string, payload: string): string {
  return `v${INGEST_VERSION}=${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

/**
 * Le due firme coincidono?
 *
 * `timingSafeEqual` e non `===`, e qui conta davvero: il confronto ingenuo esce
 * al primo carattere diverso, e il tempo che ci mette racconta quanti caratteri
 * erano giusti. Su un endpoint pubblico che accetta tentativi a volonta' quella
 * e' una firma che si ricostruisce un byte alla volta.
 *
 * Lunghezze diverse sono semplicemente firme diverse, non un errore da
 * propagare: `timingSafeEqual` su buffer di lunghezza diversa solleva.
 */
export function signaturesMatch(a: string, b: string): boolean {
  const primo = Buffer.from(a);
  const secondo = Buffer.from(b);
  if (primo.length !== secondo.length) return false;
  return timingSafeEqual(primo, secondo);
}

/** Quel che di una credenziale serve a chi verifica una richiesta. */
export interface StoredIngestKey {
  id: string;
  shopId: string;
  keyId: string;
  audience: string;
  scopes: string[];
  secretCipher: string;
  valueHash: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
}

const CHIAVE_SELECT = {
  id: true,
  shopId: true,
  keyId: true,
  audience: true,
  scopes: true,
  secretCipher: true,
  valueHash: true,
  revokedAt: true,
  expiresAt: true,
  lastUsedAt: true,
} as const;

/**
 * La credenziale con questo identificativo pubblico.
 *
 * Non filtra ne' la revoca ne' la scadenza, ed e' voluto: chi chiama deve
 * poterle distinguere per scriverle nel log — una chiave revocata che continua
 * ad arrivare e' una notizia, una scaduta e' un'installazione da aggiornare —
 * anche se al chiamante esce lo stesso identico 401 in tutti e due i casi.
 */
export async function findIngestKey(keyId: string): Promise<StoredIngestKey | null> {
  return prisma.trackingIngestKey.findUnique({ where: { keyId }, select: CHIAVE_SELECT });
}

/**
 * La credenziale che corrisponde a un VALORE intero presentato.
 *
 * Serve a un caso solo, e non e' un caso di autorizzazione: riconoscere una
 * chiave di invio incollata dove andava quella di lettura. Nella card di
 * Impostazioni le due stanno a due righe di distanza, e chi le scambia deve
 * ottenere un rifiuto comprensibile invece di un "non autorizzato" che non
 * spiega niente. E' l'unica cosa per cui esiste `valueHash`.
 *
 * QUESTA FUNZIONE NON AUTORIZZA NIENTE, e non deve diventare una scorciatoia
 * per farlo: una credenziale di invio presentata tale e quale e' esattamente
 * cio' che non deve funzionare — se bastasse mandarla, la firma non servirebbe
 * a nulla e il segreto tornerebbe a viaggiare sul filo a ogni richiesta.
 */
export async function findIngestKeyByValue(value: string): Promise<{ shopId: string } | null> {
  return prisma.trackingIngestKey.findFirst({
    where: { valueHash: hashIngestValue(value) },
    select: { shopId: true },
  });
}

/** Le credenziali di un negozio, dalla piu' recente. Il valore non c'e' dentro. */
export async function listIngestKeys(shopId: string) {
  return prisma.trackingIngestKey.findMany({
    where: { shopId },
    orderBy: { issuedAt: 'desc' },
    select: {
      id: true,
      keyId: true,
      scopes: true,
      issuedAt: true,
      supersededAt: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
    },
  });
}

/**
 * Emette una credenziale per un negozio, e mette in uscita quelle di prima.
 *
 * E' anche la rotazione: emettere e ruotare sono lo stesso gesto, perche' la
 * differenza fra i due e' solo se prima c'era qualcosa. Tenerli separati
 * vorrebbe dire due funzioni che devono restare d'accordo su cosa succede alle
 * vecchie, ed e' proprio li' che si dimentica di farle scadere.
 *
 * LA FINESTRA DI SOVRAPPOSIZIONE E' IL PUNTO. Le credenziali che c'erano non
 * vengono revocate: vengono datate. Continuano a valere per due giorni, il
 * tempo che il merchant pubblichi il valore nuovo nel container o nel Worker —
 * un gesto che non si fa dal telefono e che, se costasse un'interruzione del
 * tracciamento, non farebbe nessuno. Chi invece sa di avere una chiave in mano a
 * qualcun altro non ruota: revoca, e quella e' immediata.
 *
 * Tutto in una transazione: una rotazione che emettesse la nuova senza datare
 * le vecchie lascerebbe due credenziali piene in giro per sempre, e una che
 * datasse le vecchie senza emettere la nuova spegnerebbe il negozio fra due
 * giorni senza che nessuno se ne accorga oggi.
 */
export async function issueIngestKey(
  shopId: string,
  options: { scopes?: readonly IngestScope[]; now?: Date } = {},
): Promise<IngestCredential> {
  const now = options.now ?? new Date();
  const credential = generateIngestCredential();
  const scopes = [...(options.scopes ?? DEFAULT_INGEST_SCOPES)];

  await prisma.$transaction([
    prisma.trackingIngestKey.updateMany({
      where: { shopId, revokedAt: null, supersededAt: null },
      data: {
        supersededAt: now,
        expiresAt: new Date(now.getTime() + INGEST_ROTATION_OVERLAP_MS),
      },
    }),
    prisma.trackingIngestKey.create({
      data: {
        shopId,
        keyId: credential.keyId,
        secretCipher: sealIngestSecret(credential.secret),
        valueHash: hashIngestValue(credential.value),
        audience: INGEST_AUDIENCE,
        version: INGEST_VERSION,
        scopes,
        issuedAt: now,
      },
    }),
  ]);

  return credential;
}

/**
 * Chiude una credenziale, adesso.
 *
 * Nessuna finestra, ed e' il contrario della rotazione per costruzione: si
 * revoca quando si sa che una chiave e' finita dove non doveva, e "vale ancora
 * per due giorni" sarebbe la risposta sbagliata alla sola domanda che conta.
 *
 * `expiresAt` si porta a adesso insieme a `revokedAt`: due colonne che dicono
 * cose diverse sullo stesso fatto sono due colonne che prima o poi si
 * contraddicono, e chi legge non sa quale credere.
 */
export async function revokeIngestKey(
  shopId: string,
  keyId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const esito = await prisma.trackingIngestKey.updateMany({
    // Il negozio nella `WHERE` e non solo l'identificativo: senza, chi
    // indovinasse l'identificativo pubblico di un altro negozio potrebbe
    // spegnergli il tracciamento da una rotta autenticata come se stesso.
    where: { shopId, keyId, revokedAt: null },
    data: { revokedAt: now, expiresAt: now },
  });
  return esito.count > 0;
}

/** Chiude tutte le credenziali di un negozio. Il gesto del "l'ho persa". */
export async function revokeAllIngestKeys(shopId: string, now: Date = new Date()): Promise<number> {
  const esito = await prisma.trackingIngestKey.updateMany({
    where: { shopId, revokedAt: null },
    data: { revokedAt: now, expiresAt: now },
  });
  return esito.count;
}

/**
 * Segna che questa credenziale e' stata usata.
 *
 * Non aspetta e non solleva, di proposito: e' una nota di servizio in coda a una
 * richiesta gia' autorizzata, e far fallire una scrittura legittima perche' non
 * si e' riusciti ad aggiornare una data sarebbe sbagliare il prezzo delle due
 * cose. Serve a una domanda sola, e non urgente: "questa chiave la usa ancora
 * qualcuno, o si puo' revocare?".
 */
export async function touchIngestKey(id: string, now: Date = new Date()): Promise<void> {
  try {
    await prisma.trackingIngestKey.update({ where: { id }, data: { lastUsedAt: now } });
  } catch {
    // Nessun log: succederebbe una volta per richiesta su una rotta pubblica.
  }
}
