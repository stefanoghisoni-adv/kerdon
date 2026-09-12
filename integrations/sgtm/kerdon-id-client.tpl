___INFO___

{
  "type": "CLIENT",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "Kerdon — Identificativo visitatore",
  "description": "Riceve la chiamata della vetrina sul dominio del negozio, chiede l'identificativo a Kerdon da server a server e pianta il cookie first-party. Non conia niente senza il consenso del visitatore.",
  "containerContexts": [
    "SERVER"
  ]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "requestPath",
    "displayName": "Percorso su cui rispondere",
    "simpleValueType": true,
    "defaultValue": "/kerdon/id",
    "help": "Il percorso che la vetrina chiama sul dominio del container. Deve combaciare con quello scritto nel tag della vetrina.",
    "valueValidators": [
      {
        "type": "NON_EMPTY"
      }
    ]
  },
  {
    "type": "TEXT",
    "name": "kerdonUrl",
    "displayName": "Indirizzo dell'API",
    "simpleValueType": true,
    "defaultValue": "https://api.kerdon.io",
    "help": "Sta qui e non nel codice: il giorno in cui l'indirizzo cambia si modifica questo campo, senza rifare il template.",
    "valueValidators": [
      {
        "type": "NON_EMPTY"
      }
    ]
  },
  {
    "type": "TEXT",
    "name": "ingestKeyId",
    "displayName": "Identificativo della chiave di invio",
    "simpleValueType": true,
    "help": "La met\u00e0 prima del punto della chiave di invio, senza il prefisso kin_. Non \u00e8 un segreto: \u00e8 il nome con cui l'app ritrova la credenziale. Il segreto non si incolla qui \u2014 sta nel file di credenziali del container, sotto il nome kerdon_ingest.",
    "valueValidators": [
      {
        "type": "NON_EMPTY"
      }
    ]
  },
  {
    "type": "TEXT",
    "name": "storefrontDomain",
    "displayName": "Dominio del negozio",
    "simpleValueType": true,
    "help": "Il dominio da cui si vede la vetrina, senza https:// (per esempio negozio.it). Serve a due cose: piantare il cookie su quel dominio e accettare la chiamata solo da li'.",
    "valueValidators": [
      {
        "type": "NON_EMPTY"
      }
    ]
  },
  {
    "type": "TEXT",
    "name": "cookieMaxAge",
    "displayName": "Durata del cookie, in secondi",
    "simpleValueType": true,
    "defaultValue": "31536000",
    "help": "Un anno per impostazione. E' una richiesta al browser, non una garanzia: il browser puo' accorciarla, e la persona puo' cancellare i cookie quando vuole."
  }
]


___SANDBOXED_JS_FOR_SERVER___

/**
 * L'endpoint first-party del negozio, come Client di Google Tag Manager
 * server-side.
 *
 * COSA FA, E PERCHE' NON PUO' FARLO IL BROWSER. Kerdon non parla con il browser
 * di chi naviga: un cookie emesso dal nostro dominio dentro la pagina di un
 * negozio e' di terze parti, e i browser lo cancellano — Safari dopo sette
 * giorni quando lo accetta, spesso non lo accetta affatto. L'identificativo che
 * deve durare un anno vive nel cookie che il DOMINIO DEL NEGOZIO pianta sul
 * proprio dominio. Questo Client sta su quel dominio: riceve la chiamata dalla
 * vetrina, parla con Kerdon da server a server e scrive il cookie da qui.
 *
 * SI FIRMA, NON SI PRESENTA UNA CHIAVE. Questa rotta non legge soltanto: conia
 * l'identificativo del visitatore e ne registra la riga, cioe' SCRIVE. Finche'
 * di qui passava la chiave di LETTURA, chi ne aveva una per consultare i dati di
 * un negozio poteva anche riempirgli la tabella dei visitatori — una credenziale
 * di sola lettura che scriveva con i privilegi massimi. Adesso viaggia una
 * firma, e il segreto che la calcola non sta in nessun campo di questo template:
 * vive nel file di credenziali del container (`SGTM_CREDENTIALS`), che il
 * sandbox sa usare senza mostrarlo. Sul filo passa il risultato di una HMAC, e
 * da quello il segreto non si ricava.
 *
 * NIENTE ARRIVA MAI AL BROWSER, ne' prima ne' adesso: chi apre gli strumenti di
 * sviluppo su quel negozio non trova nessuna credenziale, perche' non ce n'e'
 * mai passata una.
 *
 * IL CONSENSO VIENE PRIMA, E L'ASSENZA DI SEGNALE E' UN NO. Nessun valore di
 * ripiego, nessuna regola per paese: se non arriva niente che dica cosa ha
 * risposto il visitatore, non si chiama nessuno, non si conia niente e non si
 * pianta nessun cookie. Registrare un consenso al posto di chi non lo ha dato
 * e' l'unico errore che questo file non puo' permettersi.
 *
 * NON PARLA CON META, GOOGLE O CHIUNQUE ALTRO. Restituisce un identificativo e
 * pianta un cookie. A chi mandarlo, e se mandarlo, lo decidono i tag del
 * merchant: quella decisione deve stare dove il merchant la vede.
 */

const claimRequest = require('claimRequest');
const getRequestPath = require('getRequestPath');
const getRequestQueryParameter = require('getRequestQueryParameter');
const getRequestHeader = require('getRequestHeader');
const getCookieValues = require('getCookieValues');
const setCookie = require('setCookie');
const setResponseBody = require('setResponseBody');
const setResponseHeader = require('setResponseHeader');
const setResponseStatus = require('setResponseStatus');
const returnResponse = require('returnResponse');
const sendHttpGet = require('sendHttpGet');
const encodeUriComponent = require('encodeUriComponent');
const JSON = require('JSON');
const hmacSha256 = require('hmacSha256');
const queryPermission = require('queryPermission');
const getTimestampMillis = require('getTimestampMillis');
const generateRandom = require('generateRandom');
const logToConsole = require('logToConsole');

// I nomi che questo Client condivide con Kerdon. Cambiarli qui non basta.
const ID_COOKIE = 'kerdon_eid';
const CONSENT_COOKIE = 'kerdon_consent';
const LEGACY_CONSENT_COOKIE = 'corew_consent';
const SHOPIFY_CONSENT_COOKIE = '_tracking_consent';
const ID_HEADER = 'X-Kerdon-External-Id';
const CONSENT_PARAM = 'consent';
const EXISTING_PARAM = 'existing_external_id';

// Solo le chiamate al percorso configurato: tutto il resto e' di qualcun altro,
// e un Client che rivendica quel che non e' suo spegne gli altri del container.
if (getRequestPath() !== data.requestPath) {
  return;
}
claimRequest();

const domain = data.storefrontDomain;

/**
 * L'origine da riflettere, se e' una che ci riguarda.
 *
 * Serve perche' la chiamata dalla vetrina porta i cookie, e con i cookie il
 * browser pretende un'origine dichiarata per nome — l'asterisco non basta.
 * Solo il dominio del negozio e i suoi sottodomini: riflettere qualunque
 * origine vorrebbe dire lasciare che una pagina qualsiasi, su un sito
 * qualsiasi, si faccia dire l'identificativo di chi la sta guardando.
 */
function allowedOrigin() {
  const origin = getRequestHeader('origin');
  if (!origin || !domain) return '';

  const withoutScheme = origin.indexOf('https://') === 0 ? origin.substring(8) : '';
  if (!withoutScheme) return '';

  const host = withoutScheme.split('/')[0].split(':')[0];
  if (host === domain) return origin;
  if (host.length > domain.length && host.indexOf('.' + domain) === host.length - domain.length - 1) {
    return origin;
  }
  return '';
}

function writeCommonHeaders() {
  setResponseHeader('content-type', 'application/json');
  // Un identificativo messo in cache e' lo stesso identificativo dato a due
  // persone diverse.
  setResponseHeader('cache-control', 'no-store');
  // L'intestazione dell'origine dipende da chi ha chiamato: senza questo un
  // intermediario servirebbe a tutti la copia del primo.
  setResponseHeader('vary', 'Origin');

  const origin = allowedOrigin();
  if (origin) {
    setResponseHeader('access-control-allow-origin', origin);
    setResponseHeader('access-control-allow-credentials', 'true');
  }
}

/** La risposta "non c'e' niente da darti", nella forma che PostgREST userebbe. */
function empty() {
  setResponseStatus(200);
  setResponseBody('[]');
  returnResponse();
}

function isDigits(text) {
  if (!text.length) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function isAlphanumeric(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    const upper = c >= 65 && c <= 90;
    const lower = c >= 97 && c <= 122;
    if (!digit && !upper && !lower) return false;
  }
  return true;
}

/**
 * Un identificativo di Kerdon, ben formato.
 *
 * Scritto a mano e non con un'espressione regolare perche' qui dentro non ce ne
 * sono. Due forme: quella corrente e quella con i millisecondi in mezzo, che i
 * browser delle persone hanno ancora — rifiutarla vorrebbe dire coniare un
 * identificativo nuovo a chiunque torni.
 *
 * Un valore malformato vale come assente: e' anche la difesa contro chi
 * provasse a farsi assegnare un identificativo scelto da lui.
 */
function isIdentifier(value) {
  if (!value) return false;

  // Due prefissi: quello di adesso e quello di prima del cambio di nome. Gli
  // identificativi coniati allora sono nei browser delle persone, e rifiutarli
  // vorrebbe dire coniarne uno nuovo a chiunque torni — cioe' perdere proprio
  // cio' per cui esistono.
  let rest;
  if (value.indexOf('kerdon_') === 0) {
    rest = value.substring(7);
  } else if (value.indexOf('corew_') === 0) {
    rest = value.substring(6);
  } else {
    return false;
  }

  const cut = rest.indexOf('_');
  if (cut < 0) return rest.length === 32 && isAlphanumeric(rest);

  const stamp = rest.substring(0, cut);
  const tail = rest.substring(cut + 1);
  return isDigits(stamp) && tail.length === 32 && isAlphanumeric(tail);
}

/** Un cookie di questo dominio, se c'e'. */
function cookie(name) {
  const values = getCookieValues(name);
  return values && values.length ? values[0] : '';
}

/**
 * Il permesso, dalla forma compatta `v1.a1.m1.p0.s0`.
 *
 * `undefined` quando non dice niente: una stringa senza nessun segmento
 * leggibile e' silenzio, e il silenzio qui vale come no.
 */
function parseCompact(raw) {
  if (!raw) return undefined;

  const segments = raw.toLowerCase().split('.');
  if (segments[0] !== 'v1') return undefined;

  const out = {};
  let seen = false;
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.length !== 2) continue;
    if (segment[1] !== '0' && segment[1] !== '1') continue;
    out[segment[0]] = segment[1] === '1';
    seen = true;
  }
  return seen ? out : undefined;
}

/**
 * Il permesso dal cookie `_tracking_consent` di Shopify.
 *
 * E' la fonte migliore quando c'e' — l'ha scritto Shopify, non noi. Del
 * documento si leggono i due posti dove il permesso e' comparso finora; la
 * regione e il regolamento NON si guardano, perche' una regola geografica
 * interpretata da noi sarebbe una regola nostra.
 */
function parseShopifyConsent(raw) {
  if (!raw) return undefined;

  const payload = JSON.parse(raw);
  if (!payload) return undefined;

  const purposes = payload.purposes;
  const cmp = payload.con ? payload.con.CMP : undefined;
  const letters = ['a', 'm', 'p', 's'];
  const out = {};
  let seen = false;

  for (let i = 0; i < letters.length; i++) {
    const letter = letters[i];
    const fromPurposes = purposes ? purposes[letter] : undefined;
    if (fromPurposes === true || fromPurposes === false) {
      out[letter] = fromPurposes;
      seen = true;
      continue;
    }
    const fromCmp = cmp ? cmp[letter] : undefined;
    if (fromCmp === '1' || fromCmp === true) {
      out[letter] = true;
      seen = true;
    } else if (fromCmp === '0' || fromCmp === false) {
      out[letter] = false;
      seen = true;
    }
  }

  return seen ? out : undefined;
}

/**
 * Da dove viene il permesso, e in che ordine si guarda.
 *
 * Prima il parametro: e' quello che il ponte in vetrina ha appena letto dalla
 * Customer Privacy API, quindi il piu' recente. Poi il cookie di Shopify. Ultimo
 * il cookie che il ponte scrive, che e' una copia e vale quanto una copia. Il
 * primo che dice qualcosa vince, intero: mettere insieme i pezzi piu'
 * permissivi di fonti diverse e' il modo esatto di costruire un consenso che
 * nessuno ha dato.
 */
function readConsent() {
  const fromParam = parseCompact(getRequestQueryParameter(CONSENT_PARAM));
  if (fromParam) return fromParam;

  const fromShopify = parseShopifyConsent(cookie(SHOPIFY_CONSENT_COOKIE));
  if (fromShopify) return fromShopify;

  // Anche il nome di prima del cambio: in un browser che aveva gia' risposto
  // il permesso e' scritto li', e non vederlo vorrebbe dire trattare come
  // silenzio un si' gia' dato — cioe' smettere di tracciare chi aveva detto di
  // si', senza un errore che lo spieghi.
  return parseCompact(cookie(CONSENT_COOKIE) || cookie(LEGACY_CONSENT_COOKIE));
}

/**
 * Il cookie first-party.
 *
 * `secure` perche' un identificativo che segue una persona per un anno non
 * viaggia in chiaro. `sameSite: 'Lax'` e non `None`: qui siamo sul dominio del
 * negozio, e `None` dichiarerebbe di terze parti proprio il cookie che esiste
 * per non esserlo. Niente `httpOnly`: il ponte in vetrina deve poterlo
 * rileggere per attaccare lo stesso identificativo al carrello.
 */
function plantCookie(value, maxAge) {
  setCookie(ID_COOKIE, value, {
    domain: domain,
    path: '/',
    'max-age': maxAge,
    secure: true,
    httpOnly: false,
    sameSite: 'Lax'
  }, false);
}

const consent = readConsent();
const analytics = consent ? consent.a : undefined;
const marketing = consent ? consent.m : undefined;
// Servono tutte e due: e' lo stesso identificativo a misurare e ad attribuire.
const allowed = analytics === true && marketing === true;
// Un no esplicito: non "non ha ancora risposto", ma "ha detto di no".
const withdrawn = analytics === false || marketing === false;

writeCommonHeaders();

// L'identificativo che questo browser ha gia': prima quello che il ponte ci
// rimanda, poi il nostro cookie. Il ponte lo passa perche' alla revoca il
// cookie potrebbe essere gia' sparito, e senza un riferimento non c'e' niente
// da far dimenticare a Kerdon.
const fromParam = getRequestQueryParameter(EXISTING_PARAM);
const existing = isIdentifier(fromParam) ? fromParam : (isIdentifier(cookie(ID_COOKIE)) ? cookie(ID_COOKIE) : '');

const base = data.kerdonUrl;
const endpoint = (base.charAt(base.length - 1) === '/' ? base.substring(0, base.length - 1) : base) +
  '/rest/v1/tracking_id';

function upstreamUrl() {
  let url = endpoint;
  let separator = '?';
  const compact = getRequestQueryParameter(CONSENT_PARAM);
  if (compact) {
    url = url + separator + CONSENT_PARAM + '=' + encodeUriComponent(compact);
    separator = '&';
  }
  // Le due etichette facoltative si inoltrano com'e': le riempie il merchant
  // dal proprio tag, e qui non c'e' niente da interpretare.
  const labels = ['browser', 'device_type'];
  for (let i = 0; i < labels.length; i++) {
    const value = getRequestQueryParameter(labels[i]);
    if (value) {
      url = url + separator + labels[i] + '=' + encodeUriComponent(value);
      separator = '&';
    }
  }
  return url;
}

/* ---------------------------------------------------------------------------
 * LA FIRMA
 *
 * Da FIRMA:INIZIO a FIRMA:FINE questa parte non viene solo letta: viene
 * ESTRATTA da questo file ed ESEGUITA da `app/lib/ingest/ingest-guard.test.ts`
 * contro il cancello vero del server. Non e' un vezzo. La stringa da firmare e'
 * composta in due posti — qui e in `app/lib/ingest/ingest-model.ts` — che
 * nessun import tiene legati, e basta un separatore diverso o un pezzo in piu'
 * perche' la firma non torni MAI. Il sintomo, senza quella prova, non sarebbe
 * un errore: sarebbe il tracciamento fermo in un negozio solo, quello che ha
 * appena aggiornato, senza niente che lo spieghi. I due marcatori servono a
 * questo — non toglierli, e non portare niente di quel che sta qui dentro
 * fuori di qui.
 *
 * IL SEGRETO NON PASSA DA QUESTO FILE, E NON CI PUO' PASSARE. `hmacSha256` non
 * accetta un segreto come stringa: accetta il NOME di una chiave dichiarata nel
 * file JSON indicato dalla variabile d'ambiente `SGTM_CREDENTIALS` del
 * container. E' un vincolo del sandbox, ed e' anche cio' che rende questa
 * strada migliore di quella di prima: il valore che firma non e' scritto in
 * nessun campo del client, non compare in nessuna esportazione del container e
 * non lo vede nemmeno chi ha accesso al tag manager.
 * ------------------------------------------------------------------------- */

// FIRMA:INIZIO

/**
 * Il nome della chiave dentro `SGTM_CREDENTIALS`. Fisso, non configurabile.
 *
 * Fisso perche' e' anche l'unica voce dichiarata nel permesso
 * `use_custom_private_keys` in fondo a questo file: un campo libero
 * costringerebbe chi installa a tenere d'accordo due posti — il campo e
 * l'elenco del permesso — e il giorno in cui non lo sono il sandbox si rifiuta
 * di firmare senza dire perche'. Un nome solo, scritto in un posto solo, che
 * nel file di credenziali si copia tale e quale.
 */
const SIGNING_KEY_ID = 'kerdon_ingest';

// I pezzi della stringa canonica, gli stessi di `ingest-model.ts`. Il perche' di
// ognuno sta scritto li', dove va letto una volta sola: qui non si improvvisa.
const SIGNATURE_VERSION = 'v1';
const SIGNATURE_AUDIENCE = 'ingest';
const SIGNATURE_SCOPE = 'ingest:identity';
const INGEST_PATH = '/rest/v1/tracking_id';

/**
 * L'impronta del corpo vuoto.
 *
 * Questa rotta si chiama in GET e non porta nessun corpo, ma la firma copre
 * l'impronta di un corpo lo stesso — quella della stringa vuota. Un ramo "qui
 * la firma si fa diversamente" sarebbe un ramo in cui, prima o poi, la firma
 * non c'e' piu'.
 *
 * Costante e non calcolata: `sha256Sync` del sandbox restituisce base64 con il
 * riempimento, mentre il server si aspetta base64url, e convertire a mano un
 * valore che non cambia mai vorrebbe dire tre righe in piu' e un modo in piu'
 * di sbagliare. Che sia il valore giusto lo dice il test, confrontandolo con la
 * funzione del server.
 */
const EMPTY_BODY_DIGEST = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';

/** La stringa su cui si calcola la firma, nell'ordine esatto che il server ricompone. */
function canonicalPayload(timestampMs, idempotencyKey) {
  return [
    SIGNATURE_VERSION,
    SIGNATURE_AUDIENCE,
    SIGNATURE_SCOPE,
    timestampMs,
    'GET',
    INGEST_PATH,
    EMPTY_BODY_DIGEST,
    idempotencyKey
  ].join('\n');
}

/**
 * L'etichetta che distingue questa chiamata da una sua copia.
 *
 * NON DEVE ESSERE IMPREVEDIBILE, e vale la pena dirlo: non e' un segreto, e chi
 * la indovinasse non ne ricaverebbe niente — senza la firma non passa comunque.
 * Deve essere DIVERSA a ogni chiamata, perche' e' l'unico pezzo che distingue
 * due visite identiche nello stesso millisecondo da una sola visita catturata e
 * rigiocata. Il millisecondo piu' due numeri a caso non si ripetono dentro i
 * cinque minuti in cui il server ricorda.
 */
function newIdempotencyKey(timestampMs) {
  return 'sgtm.' + timestampMs + '.' + generateRandom(0, 2147483647) + '.' +
    generateRandom(0, 2147483647);
}

/**
 * Le quattro intestazioni della firma, o niente se il container non sa firmare.
 *
 * IL PERMESSO SI CHIEDE PRIMA, e non e' una formalita': senza
 * `use_custom_private_keys` concesso per questo nome di chiave il sandbox
 * interrompe il template a meta', e chi guarda vede una richiesta che non parte
 * e nessuna spiegazione. Chiesto prima, un container non configurato risponde
 * "niente da darti" — la stessa risposta del visitatore senza consenso, cioe'
 * una che il ponte in vetrina sa gia' gestire — e lascia in anteprima una riga
 * che dice cosa manca.
 *
 * `undefined` e non un oggetto a meta': chi chiama deve essere costretto a
 * decidere. Un oggetto di intestazioni senza firma dentro sarebbe una chiamata
 * che parte e si prende un 401 a ogni visita.
 */
function signedHeaders() {
  if (!queryPermission('use_custom_private_keys', SIGNING_KEY_ID)) {
    logToConsole(
      'Kerdon: il container non puo\' firmare. Serve una chiave chiamata "' +
      SIGNING_KEY_ID +
      '" nel file JSON indicato da SGTM_CREDENTIALS, e il permesso "Uses custom ' +
      'private keys" del modello deve elencare quello stesso nome.'
    );
    return undefined;
  }

  const timestampMs = getTimestampMillis();
  const idempotencyKey = newIdempotencyKey(timestampMs);
  const signature = hmacSha256(
    canonicalPayload(timestampMs, idempotencyKey),
    SIGNING_KEY_ID,
    { outputEncoding: 'base64url' }
  );

  const headers = {};
  // L'identificativo PUBBLICO della credenziale: dice al server quale segreto
  // rifare, e non e' il segreto. Viaggia in chiaro apposta.
  headers['X-Kerdon-Key-Id'] = data.ingestKeyId;
  headers['X-Kerdon-Timestamp'] = '' + timestampMs;
  // Il prefisso viaggia con la firma: il giorno in cui la composizione cambia,
  // il server puo' accettare le due forme insieme per una finestra invece di
  // spegnere ogni installazione nello stesso istante.
  headers['X-Kerdon-Signature'] = SIGNATURE_VERSION + '=' + signature;
  headers['X-Kerdon-Idempotency-Key'] = idempotencyKey;
  return headers;
}

// FIRMA:FINE

/** Le intestazioni della chiamata a Kerdon, con l'identificativo gia' noto se c'e'. */
function upstreamHeaders(existing) {
  const headers = signedHeaders();
  if (!headers) return undefined;
  if (existing) headers[ID_HEADER] = existing;
  return headers;
}

/** L'identificativo dentro la risposta di Kerdon: header o corpo. */
function identifierFrom(result) {
  const headers = result.headers || {};
  const fromHeader = headers['x-kerdon-external-id'] || headers['x-corew-external-id'];
  if (isIdentifier(fromHeader)) return fromHeader;

  const body = JSON.parse(result.body);
  if (!body) return '';
  const row = body.length ? body[0] : body;
  const value = row ? row.external_id : '';
  return isIdentifier(value) ? value : '';
}

// NESSUN PERMESSO: si esce di qui, e nel modo giusto per ciascuno dei due casi.
// Chi non ha ancora risposto non lascia traccia da nessuna parte.
if (!allowed) {
  if (!withdrawn) {
    empty();
  } else {
    // Revoca. Il cookie scade comunque e per primo — il tracciamento locale deve
    // cessare nell'istante del no — e a Kerdon si dice di dimenticare, cosi'
    // sparisce anche la riga. Se quella chiamata non riesce, il cookie resta
    // comunque scaduto: si perde una cancellazione, non si continua a raccogliere.
    plantCookie('', 0);
    // Senza firma la dimenticanza non si puo' nemmeno chiedere, ma il cookie e'
    // gia' scaduto qui sopra: si perde una cancellazione, non si continua a
    // raccogliere. E' l'ordine giusto anche quando qualcosa non va.
    const revokeHeaders = existing ? upstreamHeaders(existing) : undefined;
    if (revokeHeaders) {
      sendHttpGet(upstreamUrl(), {
        headers: revokeHeaders,
        timeout: 5000
      }).then(() => {
        empty();
      });
    } else {
      empty();
    }
  }
} else {
  const headers = upstreamHeaders(existing);
  // Un container che non sa firmare non conia niente e non pianta niente. Un
  // identificativo ottenuto senza firma e' esattamente cio' che questa versione
  // esiste per impedire: meglio nessun riconoscimento che uno preso con una
  // credenziale di sola lettura.
  if (!headers) {
    empty();
  } else {
    sendHttpGet(upstreamUrl(), {
      headers: headers,
      timeout: 5000
    }).then((result) => {
      const identifier = identifierFrom(result);
      // Nessun identificativo nella risposta e' una risposta: Kerdon ha deciso
      // di non coniare. Non e' un errore e non si insiste.
      if (!identifier) {
        empty();
        return;
      }

      setResponseHeader(ID_HEADER, identifier);
      // Il cookie si riscrive a ogni visita anche quando l'identificativo e' lo
      // stesso: e' cosi' che l'anno riparte da oggi invece di scadere un anno
      // dopo la prima volta, che sarebbe il contrario di riconoscere chi torna.
      plantCookie(identifier, data.cookieMaxAge);

      setResponseStatus(200);
      setResponseBody(JSON.stringify([{ external_id: identifier }]));
      returnResponse();
    });
  }
}


___SERVER_PERMISSIONS___

[
  {
    "instance": {
      "key": {
        "publicId": "read_request",
        "versionId": "1"
      },
      "param": [
        {
          "key": "headerWhitelist",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 1,
                "string": "origin"
              }
            ]
          }
        },
        {
          "key": "requestAccess",
          "value": {
            "type": 1,
            "string": "specific"
          }
        },
        {
          "key": "headersAllowed",
          "value": {
            "type": 8,
            "boolean": true
          }
        },
        {
          "key": "queryParametersAllowed",
          "value": {
            "type": 8,
            "boolean": true
          }
        },
        {
          "key": "pathAllowed",
          "value": {
            "type": 8,
            "boolean": true
          }
        },
        {
          "key": "queryParametersAccess",
          "value": {
            "type": 1,
            "string": "any"
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "access_response",
        "versionId": "1"
      },
      "param": [
        {
          "key": "writeResponseAccess",
          "value": {
            "type": 1,
            "string": "specific"
          }
        },
        {
          "key": "writeHeaderAccess",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 1,
                "string": "content-type"
              },
              {
                "type": 1,
                "string": "cache-control"
              },
              {
                "type": 1,
                "string": "vary"
              },
              {
                "type": 1,
                "string": "access-control-allow-origin"
              },
              {
                "type": 1,
                "string": "access-control-allow-credentials"
              },
              {
                "type": 1,
                "string": "X-Kerdon-External-Id"
              }
            ]
          }
        },
        {
          "key": "writeBodyAccess",
          "value": {
            "type": 8,
            "boolean": true
          }
        },
        {
          "key": "writeStatusAccess",
          "value": {
            "type": 8,
            "boolean": true
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "get_cookies",
        "versionId": "1"
      },
      "param": [
        {
          "key": "cookieAccess",
          "value": {
            "type": 1,
            "string": "specific"
          }
        },
        {
          "key": "cookieNames",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 1,
                "string": "kerdon_eid"
              },
              {
                "type": 1,
                "string": "corew_eid"
              },
              {
                "type": 1,
                "string": "kerdon_consent"
              },
              {
                "type": 1,
                "string": "corew_consent"
              },
              {
                "type": 1,
                "string": "_tracking_consent"
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "set_cookies",
        "versionId": "1"
      },
      "param": [
        {
          "key": "allowedCookies",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "name"
                  },
                  {
                    "type": 1,
                    "string": "domain"
                  },
                  {
                    "type": 1,
                    "string": "path"
                  },
                  {
                    "type": 1,
                    "string": "secure"
                  },
                  {
                    "type": 1,
                    "string": "session"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "kerdon_eid"
                  },
                  {
                    "type": 1,
                    "string": "*"
                  },
                  {
                    "type": 1,
                    "string": "*"
                  },
                  {
                    "type": 1,
                    "string": "require_secure"
                  },
                  {
                    "type": 1,
                    "string": "any"
                  }
                ]
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "use_custom_private_keys",
        "versionId": "1"
      },
      "param": [
        {
          "key": "keys",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 1,
                "string": "kerdon_ingest"
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "logging",
        "versionId": "1"
      },
      "param": [
        {
          "key": "environments",
          "value": {
            "type": 1,
            "string": "debug"
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "send_http",
        "versionId": "1"
      },
      "param": [
        {
          "key": "allowedUrls",
          "value": {
            "type": 1,
            "string": "specific"
          }
        },
        {
          "key": "urls",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 1,
                "string": "https://api.kerdon.io/"
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  }
]


___TESTS___

scenarios: []


___NOTES___

Le prove di questo template si fanno sul container di anteprima, non qui: cio'
che va verificato — che senza consenso non nasca nessun cookie, che con il
consenso l'identificativo torni, e che la revoca lo tolga — lo controlla la
verifica dentro l'app, che chiama l'endpoint vero da fuori. Un finto passaggio
scritto qui direbbe solo che questo file fa quello che questo file dice.

C'e' un'eccezione, ed e' la firma. La parte fra FIRMA:INIZIO e FIRMA:FINE viene
estratta da questo file ed eseguita dalla suite dell'app
(`app/lib/ingest/ingest-guard.test.ts`), che le passa le funzioni del sandbox e
consegna al cancello vero le intestazioni che produce. E' l'unico pezzo che non
si puo' lasciare al container di anteprima: una stringa canonica che diverge di
un carattere da quella del server non da' un errore leggibile, da' il
tracciamento fermo in un negozio solo — quello che ha appena aggiornato.

Il permesso "Uses custom private keys" dichiara `kerdon_ingest` come unico nome
di chiave ammesso. Chi apre questo modello nel proprio container lo ritrova
nella scheda Permessi: se quel nome non compare, `hmacSha256` non viene mai
chiamata e il client risponde con un array vuoto, lasciando in anteprima la riga
che spiega cosa manca.
