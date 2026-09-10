/**
 * L'endpoint first-party del negozio, come Worker di Cloudflare.
 *
 * COS'E' E PERCHE' ESISTE. Kerdon non parla con il browser di chi naviga, e non
 * ci prova: un cookie emesso dal nostro dominio dentro la pagina di un negozio
 * e' di terze parti, e i browser lo cancellano — Safari dopo sette giorni
 * quando lo accetta, spesso non lo accetta affatto. L'identificativo che deve
 * durare un anno vive nel cookie che il DOMINIO DEL NEGOZIO pianta sul proprio
 * dominio. Questo Worker e' quel dominio: sta su una rotta del negozio, riceve
 * la chiamata dalla vetrina, parla con Kerdon da server a server e scrive il
 * cookie da qui.
 *
 * IL TOKEN STA QUI E NON NEL BROWSER. Arriva da un segreto del Worker
 * (`KERDON_TOKEN`) e non compare mai in una risposta: chi apre gli strumenti di
 * sviluppo su quel negozio non lo trova, perche' non e' mai passato di li'.
 * Se un giorno qualcuno lo mette in una pagina, il rimedio non e' nasconderlo
 * meglio: e' che questo Worker esiste apposta perche' non serva.
 *
 * IL CONSENSO VIENE PRIMA, E L'ASSENZA DI SEGNALE E' UN NO. Non c'e' nessun
 * valore di ripiego e nessuna regola per paese qui dentro: se non arriva niente
 * che dica cosa ha risposto il visitatore, non si chiama Kerdon, non si conia
 * niente e non si pianta nessun cookie. Registrare un consenso al posto di chi
 * non lo ha dato e' l'unico errore che questo file non puo' permettersi.
 *
 * NON PARLA CON META, GOOGLE O CHIUNQUE ALTRO. Restituisce un identificativo e
 * pianta un cookie. Cosa farne — a quali piattaforme mandarlo, e se mandarlo —
 * lo decide il merchant nel proprio tag manager, che e' dove quella decisione
 * deve stare.
 *
 * Non ha bisogno di build: si pubblica com'e' con `wrangler deploy`.
 */

/** I nomi che questo Worker condivide con Kerdon. Cambiarli qui non basta. */
const ID_COOKIE = 'corew_eid';
const CONSENT_COOKIE = 'corew_consent';
const SHOPIFY_CONSENT_COOKIE = '_tracking_consent';
const ID_HEADER = 'X-CoreW-External-Id';
const CONSENT_PARAM = 'consent';
const EXISTING_PARAM = 'existing_external_id';

/** Un anno di vita richiesta al browser. Richiesta, non garanzia. */
const COOKIE_MAX_AGE = 31536000;

/** La forma di un identificativo di Kerdon, vecchia e nuova. */
const ID_PATTERN = /^corew_(?:\d+_)?[A-Za-z0-9]{32}$/;

/** Un cookie qualsiasi dentro l'intestazione `Cookie`. */
function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Il permesso, dalla forma compatta `v1.a1.m1.p0.s0`.
 *
 * `null` quando non dice niente: un segmento che manca e' una finalita' non
 * dichiarata, e una stringa senza nessun segmento leggibile e' silenzio — che
 * qui vale come no, non come "vedremo".
 */
function parseCompact(raw) {
  if (!raw) return null;
  const segments = String(raw).toLowerCase().split('.');
  if (segments.shift() !== 'v1') return null;

  const out = {};
  let seen = false;
  for (const segment of segments) {
    if (segment.length !== 2) continue;
    if (segment[1] !== '0' && segment[1] !== '1') continue;
    out[segment[0]] = segment[1] === '1';
    seen = true;
  }
  return seen ? out : null;
}

/**
 * Il permesso dal cookie `_tracking_consent` di Shopify.
 *
 * E' la fonte migliore quando c'e' — l'ha scritto Shopify, non noi — e serve a
 * chi installa questo Worker senza il ponte in vetrina: il cookie arriva da
 * solo, perche' e' first-party su questo stesso dominio. Del documento si
 * leggono i due posti dove il permesso e' comparso finora; la regione e il
 * regolamento NON si guardano, perche' una regola geografica interpretata da
 * noi sarebbe una regola nostra.
 */
function parseShopifyConsent(raw) {
  if (!raw) return null;
  let payload;
  try {
    payload = JSON.parse(decodeURIComponent(raw));
  } catch {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object') return null;

  const purposes = payload.purposes;
  const cmp = payload.con && payload.con.CMP;
  const out = {};
  let seen = false;

  for (const letter of ['a', 'm', 'p', 's']) {
    const fromPurposes = purposes && purposes[letter];
    if (typeof fromPurposes === 'boolean') {
      out[letter] = fromPurposes;
      seen = true;
      continue;
    }
    const fromCmp = cmp && cmp[letter];
    if (fromCmp === '1' || fromCmp === true) {
      out[letter] = true;
      seen = true;
    } else if (fromCmp === '0' || fromCmp === false) {
      out[letter] = false;
      seen = true;
    }
  }

  return seen ? out : null;
}

/**
 * Da dove viene il permesso, e in che ordine si guarda.
 *
 * Prima il parametro: e' quello che il ponte in vetrina ha appena letto dalla
 * Customer Privacy API, quindi il piu' recente. Poi il cookie di Shopify, che
 * e' la fonte migliore ma non e' sempre leggibile da qui. Ultimo il cookie che
 * il ponte scrive, che e' una copia e vale quanto una copia.
 *
 * Il primo che dice qualcosa vince, intero: mettere insieme i pezzi piu'
 * permissivi di fonti diverse e' il modo esatto di costruire un consenso che
 * nessuno ha dato.
 */
function readConsent(url, cookieHeader) {
  const fromParam = parseCompact(url.searchParams.get(CONSENT_PARAM));
  if (fromParam) return fromParam;

  const fromShopify = parseShopifyConsent(readCookie(cookieHeader, SHOPIFY_CONSENT_COOKIE));
  if (fromShopify) return fromShopify;

  return parseCompact(readCookie(cookieHeader, CONSENT_COOKIE));
}

/** Servono tutte e due: e' lo stesso identificativo a misurare e ad attribuire. */
function isAllowed(consent) {
  return consent !== null && consent.a === true && consent.m === true;
}

/** Un no esplicito: non "non ha ancora risposto", ma "ha detto di no". */
function isWithdrawn(consent) {
  return consent !== null && (consent.a === false || consent.m === false);
}

/**
 * Il cookie first-party.
 *
 * `Domain` sul dominio del negozio quando e' dichiarato, cosi' il cookie vale
 * anche sul sottodominio da cui questo Worker risponde. `Secure` perche' un
 * identificativo che segue una persona per un anno non viaggia in chiaro.
 * `SameSite=Lax` e non `None`: qui siamo sul dominio del negozio, e `None`
 * dichiarerebbe di terze parti proprio il cookie che esiste per non esserlo.
 * Niente `HttpOnly`: il ponte in vetrina deve poterlo rileggere per attaccare
 * lo stesso identificativo al carrello.
 */
function idCookie(value, domain, maxAge) {
  const parts = [`${ID_COOKIE}=${value}`, 'Path=/', `Max-Age=${maxAge}`, 'SameSite=Lax', 'Secure'];
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

/**
 * Le intestazioni della risposta.
 *
 * `Access-Control-Allow-Origin` con l'origine vera e non `*`: la chiamata dalla
 * vetrina porta i cookie (`credentials: 'include'`), e con l'asterisco il
 * browser scarta la risposta. `Vary: Origin` perche' quella intestazione dipende
 * da chi ha chiamato, e senza un intermediario servirebbe a tutti la copia del
 * primo.
 *
 * `no-store` sempre: un identificativo messo in cache e' lo stesso
 * identificativo dato a due persone diverse.
 */
function baseHeaders(origin) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  });
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  }
  return headers;
}

/**
 * L'origine da riflettere, se e' una che ci riguarda.
 *
 * Solo il dominio del negozio e i suoi sottodomini: riflettere qualunque
 * origine vorrebbe dire lasciare che una pagina qualsiasi, su un sito
 * qualsiasi, si faccia dire l'identificativo di chi la sta guardando.
 */
function allowedOrigin(request, cookieDomain) {
  const origin = request.headers.get('Origin');
  if (!origin || !cookieDomain) return null;

  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }

  const domain = cookieDomain.replace(/^\./, '').toLowerCase();
  return host === domain || host.endsWith(`.${domain}`) ? origin : null;
}

/** La risposta "non c'e' niente da darti", nella forma che PostgREST userebbe. */
function empty(headers) {
  return new Response('[]', { status: 200, headers });
}

/** L'identificativo dentro la risposta di Kerdon: header o corpo. */
async function identifierFrom(response) {
  const fromHeader = response.headers.get(ID_HEADER);
  if (fromHeader && ID_PATTERN.test(fromHeader)) return fromHeader;

  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const row = Array.isArray(body) ? body[0] : body;
  const value = row && row.external_id;
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cookieDomain = env.COOKIE_DOMAIN || '';
    const origin = allowedOrigin(request, cookieDomain);
    const headers = baseHeaders(origin);

    // Il controllo preliminare del browser. Va risposto qui: la chiamata dalla
    // vetrina porta i cookie, e senza questa risposta non parte mai.
    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
      headers.set('Access-Control-Max-Age', '86400');
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'GET') {
      return new Response('[]', { status: 405, headers });
    }

    const cookieHeader = request.headers.get('Cookie');
    const consent = readConsent(url, cookieHeader);

    // L'identificativo che questo browser ha gia': prima quello che il ponte ci
    // rimanda, poi il nostro cookie. Il ponte lo passa perche' alla revoca il
    // cookie potrebbe essere gia' sparito, e senza un riferimento non c'e'
    // niente da far dimenticare a Kerdon.
    const fromParam = url.searchParams.get(EXISTING_PARAM);
    const existing =
      fromParam && ID_PATTERN.test(fromParam)
        ? fromParam
        : (() => {
            const fromCookie = readCookie(cookieHeader, ID_COOKIE);
            return fromCookie && ID_PATTERN.test(fromCookie) ? fromCookie : null;
          })();

    // L'indirizzo dell'API e' un parametro e non una costante scritta qui.
    // Non e' pignoleria: e' un asset che finisce sull'infrastruttura del
    // merchant e ci resta per anni, e il giorno in cui l'API cambia nome
    // nessuno puo' andare a riscrivere il Worker di ogni negozio. Si cambia la
    // variabile in `wrangler.toml` e si ripubblica, senza toccare una riga.
    const kerdon = (env.KERDON_URL || '').replace(/\/+$/, '');
    const token = env.KERDON_TOKEN || '';

    // Senza indirizzo e senza token non c'e' nessuno da chiamare: la
    // configurazione e' incompleta, e lo si dice non tracciando invece di
    // tracciare a meta'. Chi ha installato lo scopre dalla verifica dentro
    // l'app, che e' il posto dove si sta guardando.
    if (!kerdon || !token) return empty(headers);

    const upstream = new URL(`${kerdon}/rest/v1/tracking_id`);
    const compact = url.searchParams.get(CONSENT_PARAM);
    if (compact) upstream.searchParams.set(CONSENT_PARAM, compact);
    // Le due etichette facoltative si inoltrano com'e': le riempie il merchant
    // dal proprio tag, e qui non c'e' niente da interpretare.
    for (const label of ['browser', 'device_type']) {
      const value = url.searchParams.get(label);
      if (value) upstream.searchParams.set(label, value);
    }

    // NESSUN PERMESSO: si esce di qui, e nel modo giusto per ciascuno dei due
    // casi. Chi non ha ancora risposto non lascia traccia da nessuna parte.
    if (!isAllowed(consent)) {
      if (!isWithdrawn(consent)) return empty(headers);

      // Revoca. Il cookie scade comunque e per primo — il tracciamento locale
      // deve cessare nell'istante del no — e a Kerdon si dice di dimenticare,
      // cosi' sparisce anche la riga. Se quella chiamata non riesce, il cookie
      // resta comunque scaduto: si perde una cancellazione, non si continua a
      // raccogliere.
      headers.append('Set-Cookie', idCookie('', cookieDomain, 0));
      if (existing) {
        try {
          await fetch(upstream.toString(), {
            headers: { apikey: token, [ID_HEADER]: existing },
          });
        } catch {
          // Niente da fare da qui: il visitatore ha gia' smesso di essere
          // riconosciuto su questo browser, che e' la meta' che ci compete.
        }
      }
      return empty(headers);
    }

    const upstreamHeaders = { apikey: token };
    if (existing) upstreamHeaders[ID_HEADER] = existing;

    let response;
    try {
      response = await fetch(upstream.toString(), { headers: upstreamHeaders });
    } catch {
      // Kerdon non risponde: la vetrina non deve accorgersene. Nessun
      // identificativo per questa visita, e nessun cookie che dica il contrario.
      return empty(headers);
    }

    const identifier = await identifierFrom(response);
    if (!identifier) return empty(headers);

    headers.set(ID_HEADER, identifier);
    // Il cookie si riscrive a ogni visita anche quando l'identificativo e' lo
    // stesso: e' cosi' che l'anno riparte da oggi invece di scadere un anno
    // dopo la prima volta, che sarebbe il contrario di riconoscere chi torna.
    headers.append('Set-Cookie', idCookie(identifier, cookieDomain, COOKIE_MAX_AGE));

    return new Response(JSON.stringify([{ external_id: identifier }]), { status: 200, headers });
  },
};
