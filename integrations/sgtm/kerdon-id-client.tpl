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
    "name": "ingestKey",
    "displayName": "Chiave di invio (comincia con kin_)",
    "simpleValueType": true,
    "help": "Incolla la CHIAVE DI INVIO, intera e come l'app te l'ha mostrata: comincia con kin_ e ha un punto in mezzo. La trovi in Impostazioni \u2192 Connessione e credenziali di tracking, nel momento in cui la crei \u2014 si vede una volta sola, e se l'hai persa se ne crea un'altra. \u00c8 l'unica chiave che va in questo campo: quella con cui l'app ti restituisce i dati gi\u00e0 raccolti non serve a scrivere e da qui non funziona. Resta dentro il container e non arriva mai al browser.",
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
 * DI QUI PASSA LA CHIAVE DI INVIO, E NON QUELLA CON CUI SI CONSULTANO I DATI.
 * Questa rotta non legge soltanto: conia l'identificativo del visitatore e ne
 * registra la riga, cioe' SCRIVE. Finche' nel campo andava la credenziale con
 * cui l'app RESTITUISCE i dati, chi ne aveva una per guardare un negozio poteva
 * anche riempirgli la tabella dei visitatori — una credenziale di sola
 * consultazione che scriveva con i privilegi massimi. Adesso il campo vuole la
 * credenziale emessa per scrivere: ha i propri ambiti, si revoca per conto suo,
 * e non apre niente di quel che apre l'altra.
 *
 * SI PRESENTA, NON SI FIRMA, E NON SI FINGE IL CONTRARIO. Firmare sarebbe piu'
 * forte — il segreto non viaggerebbe, e una richiesta catturata non si potrebbe
 * rigiocare — ma qui dentro non e' praticabile: `hmacSha256` del sandbox non
 * accetta un segreto come stringa, vuole il nome di una chiave dichiarata in un
 * file JSON che il container deve avere sul disco, e su un container gestito
 * quel file non si puo' mettere. Una difesa che nessuno puo' installare non
 * difende nessuno. Chi puo' firmare lo fa dall'anello che sta DAVANTI a questo
 * container — un endpoint proprio, dove un segreto ha dove stare — e il server
 * accetta quella strada senza che questo template cambi.
 *
 * NIENTE ARRIVA MAI AL BROWSER, ne' prima ne' adesso: la credenziale sta in un
 * campo di questo template, dentro il container, e chi apre gli strumenti di
 * sviluppo su quel negozio non ne trova nessuna — perche' non ce n'e' mai
 * passata una.
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
const logToConsole = require('logToConsole');

// I nomi che questo Client condivide con Kerdon. Cambiarli qui non basta.
const ID_COOKIE = 'kerdon_eid';
const CONSENT_COOKIE = 'kerdon_consent';
const LEGACY_CONSENT_COOKIE = 'corew_consent';
const SHOPIFY_CONSENT_COOKIE = '_tracking_consent';
const ID_HEADER = 'X-Kerdon-External-Id';
const CONSENT_PARAM = 'consent';

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
  // Senza, una pagina del negozio non potrebbe leggere `Retry-After` su una
  // chiamata cross-origin: non e' fra le intestazioni che il browser espone.
  setResponseHeader('access-control-expose-headers', 'Retry-After');

  const origin = allowedOrigin();
  if (origin) {
    setResponseHeader('access-control-allow-origin', origin);
    setResponseHeader('access-control-allow-credentials', 'true');
  }
}

/**
 * La risposta, una volta sola.
 *
 * Un Client che non chiama `returnResponse` lascia la chiamata appesa fino al
 * timeout del container, e chi chiama non sa distinguere quell'attesa da un
 * esito. Ogni ramo passa di qui, e il secondo passaggio non fa niente: un
 * callback che arrivasse due volte non deve poter scrivere una seconda
 * risposta sopra la prima.
 *
 * SE LA RISPOSTA STESSA SI ROMPE, se ne tenta un'altra, una volta. Un errore
 * dentro `setResponseBody` o `returnResponse` lascerebbe `responded` a vero
 * senza che niente sia partito: nessuno risponderebbe piu'. Si prova allora la
 * forma piu' povera possibile — solo lo stato, 500 — e poi basta: un secondo
 * guasto non ha un terzo rimedio.
 */
let responded = false;
function respond(status, body) {
  if (responded) return;
  responded = true;
  try {
    setResponseStatus(status);
    setResponseBody(body);
    returnResponse();
  } catch (e) {
    lastResort();
  }
}

function lastResort() {
  try {
    setResponseStatus(500);
    returnResponse();
  } catch (e) {
    // Niente altro da tentare.
  }
}

/** La risposta "non c'e' niente da darti", nella forma che PostgREST userebbe. */
function empty() {
  respond(200, '[]');
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

  // Il sandbox restituisce `undefined` su un testo malformato: un cookie rotto
  // vale come silenzio, cioe' come no.
  const payload = JSON.parse(raw);
  if (!payload || typeof payload !== 'object') return undefined;

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
 * Prima il parametro: e' quello che la chiamata porta con se', letto nella
 * pagina un istante prima, quindi il piu' recente. Poi il cookie di Shopify.
 * Ultimo `kerdon_consent`, che e' una copia e vale quanto una copia. Il
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
 * per non esserlo. Niente `httpOnly`: i tag del merchant nella pagina
 * possono doverlo rileggere.
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

/**
 * Il permesso, riscritto nella forma compatta che Kerdon legge.
 *
 * Si inoltra QUESTO, e non il parametro grezzo: il no che arriva dal cookie di
 * Shopify non e' nella querystring, e senza riscriverlo Kerdon riceverebbe una
 * chiamata senza nessun segnale — cioe' non saprebbe che c'e' da cancellare.
 * Solo le lettere dette: una finalita' su cui il visitatore non si e' espresso
 * non diventa ne' un si' ne' un no.
 */
function compactOf(value) {
  if (!value) return '';
  const letters = ['a', 'm', 'p', 's'];
  let out = 'v1';
  for (let i = 0; i < letters.length; i++) {
    const v = value[letters[i]];
    if (v === true) out = out + '.' + letters[i] + '1';
    else if (v === false) out = out + '.' + letters[i] + '0';
  }
  return out === 'v1' ? '' : out;
}

/* ---------------------------------------------------------------------------
 * LA REVOCA IN SOSPESO
 *
 * Alla revoca `kerdon_eid` scade subito: il tracciamento cessa nell'istante
 * del no. Ma se Kerdon non conferma — rete giu', timeout, 503 — l'identificativo
 * da cancellare sarebbe sparito insieme al cookie, e nessuno potrebbe piu'
 * chiederne la cancellazione. Resta allora in un SECONDO cookie, `kerdon_rv`,
 * finche' Kerdon non risponde 2xx:
 *
 *  - forma `<permesso compatto>~<identificativo>[~<identificativo>]`, per
 *    esempio `v1.a0.m0~kerdon_…`: il no da ripresentare e cosa cancellare;
 *  - `HttpOnly`: nessuno script della pagina lo legge, nessun tag del browser
 *    lo scambia per un identificativo attivo. Lo legge solo questo Client;
 *  - serve SOLO a cancellare: non viene mai rimandato come identificativo, non
 *    finisce in nessuna risposta, e finche' c'e' non si conia niente — nemmeno
 *    se il visitatore nel frattempo ha concesso di nuovo;
 *  - a ogni chiamata successiva, con qualunque permesso, si riprova la revoca
 *    (cancellare non e' tracciare). Al 2xx scade; se nel frattempo il permesso
 *    c'e', si conia un identificativo NUOVO;
 *  - dura 30 giorni, poi il browser lo butta: se Kerdon aveva gia' registrato
 *    la revoca la completa da se'.
 * ------------------------------------------------------------------------- */

const PENDING_COOKIE = 'kerdon_rv';
const PENDING_MAX_AGE = 2592000;
const PENDING_MAX_IDS = 3;

/** La revoca in sospeso letta dal cookie, o `undefined` se non ce n'e' una valida. */
function readPending() {
  const raw = cookie(PENDING_COOKIE);
  if (!raw) return undefined;
  const parts = raw.split('~');
  const said = parseCompact(parts[0]);
  // Il permesso registrato deve essere un no: un valore che dice altro non e'
  // una revoca, e non si ripresenta a Kerdon come tale.
  if (!said || !(said.a === false || said.m === false)) return undefined;
  const ids = [];
  for (let i = 1; i < parts.length && ids.length < PENDING_MAX_IDS; i++) {
    if (isIdentifier(parts[i]) && ids.indexOf(parts[i]) < 0) ids.push(parts[i]);
  }
  if (!ids.length) return undefined;
  return { compact: compactOf(said), ids: ids };
}

function writePending(compact, ids) {
  setCookie(PENDING_COOKIE, compact + '~' + ids.join('~'), {
    domain: domain,
    path: '/',
    'max-age': PENDING_MAX_AGE,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax'
  }, false);
}

function clearPending() {
  setCookie(PENDING_COOKIE, '', {
    domain: domain,
    path: '/',
    'max-age': 0,
    secure: true,
    httpOnly: true,
    sameSite: 'Lax'
  }, false);
}

/**
 * L'indirizzo di Kerdon, controllato. Vuoto se il campo e' vuoto o non in
 * https: e' un errore di configurazione, e chi chiama risponde comunque — con
 * la revoca messa da parte se ce n'era una in corso.
 */
function endpointUrl() {
  const base = data.kerdonUrl;
  if (typeof base !== 'string' || base.indexOf('https://') !== 0 || base.length <= 8) {
    return '';
  }
  return (base.charAt(base.length - 1) === '/' ? base.substring(0, base.length - 1) : base) +
    '/rest/v1/tracking_id';
}

function upstreamUrl(compact) {
  let url = endpointUrl();
  let separator = '?';
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
 * LA CREDENZIALE CHE PARTE
 *
 * Da INVIO:INIZIO a INVIO:FINE questa parte non viene solo letta: viene
 * ESTRATTA da questo file ed ESEGUITA da `app/lib/ingest/ingest-guard.test.ts`,
 * che consegna le intestazioni che produce al cancello vero del server. Non e'
 * un vezzo. In che campo la credenziale viaggia lo decide questo file; da quale
 * campo il server la raccoglie, e da quale prefisso capisce quale delle due
 * chiavi gli e' arrivata, lo decide un altro file che nessun import tiene legato
 * a questo. Il giorno in cui uno dei due si sposta, il sintomo non e' un errore
 * di compilazione e non e' un test rosso: e' il tracciamento fermo in un negozio
 * solo — quello che ha appena aggiornato il container — senza niente che lo
 * spieghi. I due marcatori servono a questo: non toglierli, e non portare fuori
 * di qui quel che sta qui dentro.
 * ------------------------------------------------------------------------- */

// INVIO:INIZIO

/**
 * Il campo in cui la credenziale viaggia.
 *
 * `apikey`, e non un'intestazione nostra: e' l'unico che i container gestiti
 * lascino compilare, ed e' lo stesso in cui prima andava la credenziale
 * sbagliata. Che siano lo stesso campo non e' una svista — e' quel che rende il
 * passaggio un incollare un valore diverso dove ce n'e' gia' uno. A distinguere
 * le due e' il PREFISSO del valore, che il server guarda: `kin_` dice che questa
 * e' la chiave emessa per scrivere.
 */
const KEY_HEADER = 'apikey';

/** Come comincia una chiave di invio. Serve solo a riconoscere il campo compilato male. */
const INGEST_PREFIX = 'kin_';

/**
 * Le intestazioni della chiamata a Kerdon, con l'identificativo gia' noto se c'e'.
 *
 * SI PARTE ANCHE CON UN VALORE CHE NON SOMIGLIA A UNA CHIAVE DI INVIO, e la
 * scelta va spiegata perche' non e' quella che verrebbe da fare. Incollare la
 * credenziale sbagliata e' l'errore piu' probabile di tutta la configurazione, e
 * il server la rifiuta: da un valore che non comincia con `kin_` non arriva
 * nessun identificativo, oggi e sempre. Fermare la chiamata qui non salverebbe
 * niente — il tracciamento e' fermo comunque — e toglierebbe l'unica prova che
 * chi installa puo' guardare: la risposta del server, con il suo 401, accanto
 * alla riga qui sotto nell'anteprima del container. Le due insieme dicono dove
 * mettere le mani; il silenzio non direbbe niente.
 */
function upstreamHeaders(existing) {
  const key = data.ingestKey || '';
  if (key.indexOf(INGEST_PREFIX) !== 0) {
    logToConsole(
      'Kerdon: il campo "Chiave di invio" non contiene una chiave di invio. ' +
      'Quella giusta comincia con "' + INGEST_PREFIX + '", ha un punto in mezzo, e si ' +
      'copia da Impostazioni nel momento in cui la si crea. Con un altro valore ' +
      'il tracciamento non funziona: il server rifiuta la chiamata.'
    );
  }

  const headers = {};
  headers[KEY_HEADER] = key;
  if (existing) headers[ID_HEADER] = existing;
  return headers;
}

// INVIO:FINE

/** Solo cifre: un `Retry-After` in secondi, l'unica forma che si inoltra. */
function retryAfterFrom(result) {
  const headers = result && result.headers ? result.headers : {};
  const value = headers['retry-after'];
  if (value && isDigits('' + value)) return '' + value;
  return '60';
}

/** Un 2xx, e niente altro. */
function succeeded(result) {
  const status = result ? result.statusCode : 0;
  return status >= 200 && status < 300;
}

/**
 * L'identificativo dentro la risposta di Kerdon: header o corpo.
 *
 * Solo da una risposta 2xx, e con il corpo trattato come ostile: `JSON.parse`
 * del sandbox su un testo malformato restituisce `undefined`, e da li' in giu'
 * ogni livello si controlla prima di scenderci.
 */
function identifierFrom(result) {
  if (!succeeded(result)) return '';

  const headers = result.headers || {};
  const fromHeader = headers['x-kerdon-external-id'] || headers['x-corew-external-id'];
  if (isIdentifier(fromHeader)) return fromHeader;

  if (typeof result.body !== 'string' || !result.body) return '';
  const body = JSON.parse(result.body);
  if (!body || typeof body !== 'object') return '';
  const row = body.length ? body[0] : body;
  if (!row || typeof row !== 'object') return '';
  const value = row.external_id;
  return isIdentifier(value) ? value : '';
}

// Lo stato di questa chiamata. Assegnato da `run()`, letto dai rami.
let consent;
let allowed = false;
let pending;
// La revoca ancora da confermare: `{compact, ids}`. Finche' c'e', ogni uscita
// che non e' un 2xx di Kerdon la mette da parte in `kerdon_rv`.
let keep;

/** Se `keep` e' gia' esattamente cio' che il browser ha in `kerdon_rv`. */
function keepIsPending() {
  return !!pending && pending.compact === keep.compact && pending.ids.join('~') === keep.ids.join('~');
}

/**
 * La revoca non e' stata presa in carico: 503, mai un ok.
 *
 * L'identificativo resta in `kerdon_rv`, e la prossima chiamata riprova. Se il
 * browser aveva gia' quel valore non lo si riscrive: il cookie scade trenta
 * giorni dopo la PRIMA volta, non dopo l'ultima, e un guasto permanente non lo
 * tiene in vita per sempre. `Retry-After` quello di Kerdon se c'e', altrimenti
 * un minuto.
 *
 * Ogni passo e' protetto a parte: un cookie che non si riesce a scrivere non
 * deve impedire la risposta.
 */
function revokeNotConfirmed(result) {
  if (responded) return;
  if (keep && keep.ids.length && !keepIsPending()) {
    try {
      writePending(keep.compact, keep.ids);
    } catch (e) {
      // Si risponde lo stesso.
    }
  }
  try {
    setResponseHeader('retry-after', retryAfterFrom(result));
  } catch (e) {
    // Idem.
  }
  respond(503, '{"error":"revoke_not_confirmed"}');
}

/** Il Client e' configurato male: si risponde, e l'anteprima dice cosa manca. */
function misconfigured() {
  try {
    logToConsole('Kerdon: il campo "Indirizzo dell\'API" e\' vuoto o non comincia con https://.');
  } catch (e) {
    // Si risponde lo stesso.
  }
  respond(500, '{"error":"client_misconfigured"}');
}

/**
 * L'ultima rete: qualunque errore non previsto finisce qui, e qui si risponde.
 * Con una revoca in corso vale come "non confermata" — l'identificativo resta
 * da parte — altrimenti e' un 500.
 */
function settle() {
  if (responded) return;
  if (keep) {
    revokeNotConfirmed(undefined);
    return;
  }
  respond(500, '{"error":"client_error"}');
}

/**
 * Chiede a Kerdon di dimenticare gli identificativi in `keep`, uno alla volta.
 * Al 2xx dell'ultimo, `kerdon_rv` scade (se c'era) e si passa a `done`.
 */
function revokeNext(done) {
  if (!keep.ids.length) {
    keep = undefined;
    if (pending) clearPending();
    done();
    return;
  }
  sendHttpGet(upstreamUrl(keep.compact), {
    headers: upstreamHeaders(keep.ids[0]),
    timeout: 5000
  }).then((result) => {
    if (!succeeded(result)) {
      revokeNotConfirmed(result);
      return;
    }
    keep.ids = keep.ids.slice(1);
    revokeNext(done);
  }, () => {
    // Rete giu' o timeout.
    revokeNotConfirmed(undefined);
  }).catch(() => {
    settle();
  });
}

/** Con il permesso: l'identificativo, e il cookie che lo porta. */
function mint(existingId) {
  sendHttpGet(upstreamUrl(compactOf(consent)), {
    headers: upstreamHeaders(existingId),
    timeout: 5000
  }).then((result) => {
    const identifier = identifierFrom(result);
    // Nessun identificativo nella risposta e' una risposta: Kerdon ha deciso
    // di non coniare, oppure non ha risposto bene. In tutti e due i casi non si
    // pianta niente e chi chiama riceve "nessuna riga".
    if (!identifier) {
      empty();
      return;
    }

    setResponseHeader(ID_HEADER, identifier);
    // Il cookie si riscrive a ogni visita anche quando l'identificativo e' lo
    // stesso: e' cosi' che l'anno riparte da oggi invece di scadere un anno
    // dopo la prima volta, che sarebbe il contrario di riconoscere chi torna.
    plantCookie(identifier, data.cookieMaxAge);

    respond(200, JSON.stringify([{ external_id: identifier }]));
  }, () => {
    // Rete giu' o timeout: nessun identificativo, nessun cookie.
    empty();
  }).catch(() => {
    empty();
  });
}

function run() {
  writeCommonHeaders();

  consent = readConsent();
  const analytics = consent ? consent.a : undefined;
  const marketing = consent ? consent.m : undefined;
  // Servono tutte e due: e' lo stesso identificativo a misurare e ad attribuire.
  allowed = analytics === true && marketing === true;
  // Un no esplicito: non "non ha ancora risposto", ma "ha detto di no".
  const withdrawn = analytics === false || marketing === false;

  pending = readPending();

  // L'identificativo che questo browser ha gia': quello del nostro cookie, e
  // nient'altro. Il parametro `existing_external_id` vale SOLO se e' identico
  // al cookie: un valore che arriva da fuori senza il cookie che lo porta non
  // e' di questo browser — puo' essere un identificativo gia' revocato, rimasto
  // in un dataLayer o in un tag, e riusarlo ricucirebbe la persona di prima
  // della revoca a quella di dopo. In quel caso si ignora: con il permesso si
  // riusa il cookie o se ne conia uno nuovo, alla revoca non si cancella niente
  // che il browser non porti.
  // Detto altrimenti: conta il cookie, e il parametro al massimo lo conferma.
  const existing = isIdentifier(cookie(ID_COOKIE)) ? cookie(ID_COOKIE) : '';

  if (withdrawn) {
    // Revoca. Il cookie scade comunque e per primo — il tracciamento locale
    // deve cessare nell'istante del no. Poi si chiede a Kerdon di cancellare,
    // e la risposta dice com'e' andata davvero: 200 solo se Kerdon ha risposto
    // 2xx; altrimenti 503, e l'identificativo resta in `kerdon_rv`.
    plantCookie('', 0);
    keep = pending
      ? { compact: pending.compact, ids: pending.ids.slice(0) }
      : { compact: compactOf(consent), ids: [] };
    if (existing && keep.ids.indexOf(existing) < 0 && keep.ids.length < PENDING_MAX_IDS) {
      keep.ids.push(existing);
    }
    // Senza un identificativo non c'e' niente da far dimenticare: si esce, e il
    // cookie resta scaduto lo stesso.
    if (!keep.ids.length) {
      keep = undefined;
      empty();
      return;
    }
    if (!endpointUrl()) {
      revokeNotConfirmed(undefined);
      return;
    }
    revokeNext(empty);
    return;
  }

  // Una revoca rimasta in sospeso si riprova a ogni chiamata, qualunque cosa
  // dica il permesso adesso: cancellare non e' tracciare. Finche' non e'
  // confermata non si conia niente e non si riusa niente; confermata, se c'e'
  // il permesso, si conia un identificativo NUOVO.
  if (pending) {
    keep = { compact: pending.compact, ids: pending.ids.slice(0) };
    if (!endpointUrl()) {
      revokeNotConfirmed(undefined);
      return;
    }
    revokeNext(() => {
      if (allowed) mint('');
      else empty();
    });
    return;
  }

  // NESSUN PERMESSO: chi non ha ancora risposto non lascia traccia da nessuna
  // parte. Nessuna chiamata, nessun cookie.
  if (!allowed) {
    empty();
    return;
  }

  if (!endpointUrl()) {
    misconfigured();
    return;
  }
  mint(existing);
}

// Ogni strada finisce in una risposta, anche quella che si rompe prima di
// arrivarci.
try {
  run();
} catch (e) {
  settle();
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
              },
              {
                "type": 1,
                "string": "access-control-expose-headers"
              },
              {
                "type": 1,
                "string": "retry-after"
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
              },
              {
                "type": 1,
                "string": "kerdon_rv"
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
              },
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
                    "string": "kerdon_rv"
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

OGNI RAMO RISPONDE, UNA VOLTA SOLA. Questo e' un Client, non un tag: non ha
`gtmOnSuccess`/`gtmOnFailure`, e il suo "chiudere" e' `returnResponse()`. Passa
tutto da `respond()`, che risponde una volta e ignora le successive; se la
risposta stessa solleva, tenta una sola volta un 500 nudo. Tutto il flusso sta
dentro un `try` che, su qualunque errore, risponde comunque (503 con la revoca
messa da parte, se ce n'era una in corso; altrimenti 500). Un "Indirizzo
dell'API" vuoto o non in https: 500 `client_misconfigured`, nessuna chiamata.

CHI FA PARTIRE LA REVOCA. Il tag di chi cura il tracciamento deve chiamare
questo endpoint A OGNI PAGINA VISTA, ANCHE QUANDO IL CONSENSO E' RIFIUTATO O
RITIRATO: e' quella chiamata, con il no nel cookie `_tracking_consent` o nel
parametro `consent`, a far partire la revoca. Senza consenso qui non si conia e
non si pianta niente; un tag che parte solo con il consenso non porta mai il no.

LA REVOCA E' RITENTABILE DA QUI. Al no, `kerdon_eid` scade
subito e l'identificativo passa in `kerdon_rv` (HttpOnly, 30 giorni, forma
`<no compatto>~<identificativo>`), che serve solo a cancellare. 200 solo se
Kerdon ha risposto 2xx, e allora `kerdon_rv` scade; rete giu', timeout, 429,
5xx e qualunque altro non-2xx diventano 503 con `Retry-After` (quello di Kerdon
se in sole cifre, altrimenti 60). La chiamata successiva — con qualunque
permesso — riprova; finche' `kerdon_rv` c'e' non si conia niente. Il permesso
si inoltra a Kerdon riscritto in forma compatta, anche quando arriva dal cookie
di Shopify e non dal parametro.

L'IDENTIFICATIVO E' SOLO QUELLO DEL COOKIE `kerdon_eid`. Il parametro
`existing_external_id` vale solo se coincide con il cookie, altrimenti si
ignora: un identificativo gia' revocato che torna da un parametro non si riusa
(e il server, comunque, non riusa mai un identificativo revocato).

IL LEGAME CON L'ORDINE non passa di qui. I tag delle pagine copiano il valore
del cookie `kerdon_eid` (non HttpOnly) nell'attributo del carrello
`_kerdon_external_id`, che il webhook degli ordini legge; in alternativa il
container manda `external_id` con email e/o telefono a `POST /rest/v1/identify`
con la chiave di invio.

L'intero codice di questo template viene eseguito da
`app/lib/tracking/sgtm-id-client.test.ts`, con finti delle API del sandbox.
Il harness NON puo' provare il comportamento del sandbox vero su questi punti:
`.then(onOk, onErr)` con due argomenti e `.catch` sul Promise di
`sendHttpGet`; `typeof`; `try`/`catch`; i nomi delle intestazioni di risposta
in minuscolo (`result.headers['retry-after']`, `x-kerdon-external-id`);
`JSON.parse` che restituisce `undefined` sul malformato. Da provare in
anteprima, a mano:
1. consenso `v1.a0.m0` + cookie `kerdon_eid` valido, indirizzo dell'API
   irraggiungibile: risposta 503 con `retry-after` e
   `access-control-expose-headers`, `kerdon_eid` scaduto, `kerdon_rv` scritto
   (HttpOnly) — prova che `onErr` del `.then` a due argomenti viene chiamato;
2. stessa chiamata con l'API raggiungibile: 200 `[]`, `kerdon_rv` scaduto;
3. con `kerdon_rv` nel browser e NESSUN parametro, API raggiungibile: una
   chiamata in uscita con `consent=v1.a0.m0` e l'identificativo, 200 `[]`,
   `kerdon_rv` scaduto;
4. l'API che risponde 503 con `Retry-After: 30`: la risposta porta
   `retry-after: 30` (prova i nomi in minuscolo di `result.headers`);
5. consenso `v1.a1.m1` con l'API irraggiungibile: 200 `[]`, nessun cookie;
6. consenso `v1.a1.m1` con l'API raggiungibile: l'identificativo arriva, e
   il cookie `kerdon_eid` viene piantato (prova `typeof` e `JSON.parse`);
7. nessun consenso: 200 `[]`, nessuna chiamata in uscita;
8. "Indirizzo dell'API" svuotato (a mano, nell'anteprima): 500
   `client_misconfigured`, nessuna chiamata — prova `try`/`catch` e il ramo
   della configurazione.

Le prove di questo template si fanno sul container di anteprima, non qui: cio'
che va verificato — che senza consenso non nasca nessun cookie, che con il
consenso l'identificativo torni, e che la revoca lo tolga — lo controlla la
verifica dentro l'app, che chiama l'endpoint vero da fuori. Un finto passaggio
scritto qui direbbe solo che questo file fa quello che questo file dice.

C'e' un'eccezione, ed e' la credenziale. La parte fra INVIO:INIZIO e INVIO:FINE
viene estratta da questo file ed eseguita dalla suite dell'app
(`app/lib/ingest/ingest-guard.test.ts`), che consegna al cancello vero le
intestazioni che produce. E' l'unico pezzo che non si puo' lasciare
all'anteprima: un campo rinominato da una parte sola non da' un errore
leggibile, da' il tracciamento fermo in un negozio solo — quello che ha appena
aggiornato.

Nel campo "Chiave di invio" va la credenziale che comincia con `kin_`, intera.
Se il valore incollato non comincia cosi', la chiamata parte lo stesso — il
server accetta ancora la credenziale di prima, ma non per sempre — e in
anteprima compare la riga che dice cosa manca. Chi vuole la protezione piena,
quella in cui il segreto non viaggia, firma dall'anello che sta davanti a questo
container: la stringa da firmare e le intestazioni stanno in
`integrations/sgtm/README.md`.
