import {
  CONSENT_COOKIE,
  COMPACT_CONSENT_VERSION,
  CONSENT_QUERY_PARAM,
  LEGACY_CONSENT_COOKIE,
} from './consent';
import { EXISTING_EXTERNAL_ID_PARAM, EXTERNAL_ID_COOKIE } from './external-id';

/**
 * Il ponte fra il consenso di Shopify e l'endpoint first-party del merchant.
 *
 * PERCHE' SERVE UN PONTE. Il permesso lo raccoglie Shopify, in vetrina, dove
 * c'e' il banner e dove vive la Customer Privacy API. Chi conia
 * l'identificativo e' l'endpoint first-party del negozio, che quella pagina non
 * l'ha mai vista: fra i due non passa niente se non lo si fa passare. Questo
 * pezzo di codice sta dalla parte del browser e fa tre cose, in quest'ordine —
 * legge cosa ha detto il visitatore, lo dice all'endpoint, e attacca al
 * carrello l'identificativo che riceve.
 *
 * QUESTO FILE E' STATO CODICE MORTO, e va detto perche' e' la ragione per cui
 * adesso e' fatto cosi'. Descriveva un protocollo che nessuno eseguiva: non era
 * importato da nessuna parte, e chi lo leggeva credeva di guardare
 * un'implementazione. Ora e' servito da `/tracking/bridge.js` ed e' il pezzo in
 * vetrina di tutte e due le strade di installazione — Google Tag Manager
 * server-side e Workers Cloudflare. Se smette di essere usato va tolto, non
 * lasciato li'.
 *
 * COSA NON FA, ed e' la parte che conta: non decide. Non ha regole per paese,
 * non ha valori di ripiego, non presume niente. Se la Customer Privacy API non
 * c'e' o non risponde, il ponte tace e non chiama nessuno: a valle non nasce
 * nessun identificativo. Un consenso che non e' stato dato non lo scrive
 * nessuno al posto di chi non lo ha dato.
 *
 * E NON PORTA NESSUNA CREDENZIALE. In questo script non c'e' il token di
 * lettura del negozio e non ci sara' mai: parla solo con l'endpoint del
 * merchant, sul dominio del merchant. Il token sta fra quell'endpoint e noi,
 * dove nessun browser lo vede. Se un giorno qualcuno prova ad aggiungerlo qui,
 * la risposta e' che l'endpoint esiste apposta per non doverlo fare.
 *
 * IL COOKIE DELL'IDENTIFICATIVO NON LO SCRIVE QUESTO SCRIPT. Lo scrive
 * l'endpoint, con `Set-Cookie`, dal dominio del negozio: e' li' che si ottengono
 * `Secure` e una durata che il browser rispetti. Qui si scrive solo la copia
 * leggibile del permesso, e alla revoca si cancella cio' che era rimasto.
 */

/** Gli eventi che il ponte spinge sul dataLayer. Nomi stabili: ci si aggancia. */
export const CONSENT_GRANTED_EVENT = 'kerdon_consent_granted';
export const CONSENT_WITHDRAWN_EVENT = 'kerdon_consent_withdrawn';
/** L'identificativo e' arrivato: da qui in poi i tag possono attaccarlo. */
export const IDENTITY_EVENT = 'kerdon_identity';

/**
 * L'attributo del tag `<script>` da cui si legge l'indirizzo dell'endpoint.
 *
 * Sta li' e non in una querystring perche' cosi' il file e' identico per tutti
 * i negozi: una sola copia in cache, e nessun indirizzo di merchant scritto
 * dentro il corpo di uno script che serviamo noi.
 */
export const ENDPOINT_ATTRIBUTE = 'data-kerdon-endpoint';

/** L'attributo del carrello Shopify su cui finisce l'identificativo. */
export const CART_ATTRIBUTE = 'kerdon_eid';

/**
 * La chiave di localStorage della revoca in sospeso (la "lapide").
 *
 * Nome corto e diverso da quello del cookie dell'identificativo apposta: non e'
 * un identificativo e nessun tag deve poterlo scambiare per uno. Sta in
 * localStorage e non in un cookie perche' cosi' non viaggia con nessuna
 * richiesta al dominio del negozio, container compreso.
 */
export const REVOCATION_STORAGE_KEY = 'kerdon_rv';

/** Dopo trenta giorni una revoca mai confermata si abbandona. */
export const REVOCATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Tentativi nella stessa pagina; gli altri al caricamento successivo. */
export const REVOCATION_MAX_TRIES_PER_PAGE = 5;
/** L'attesa piu' lunga che si fa dentro una pagina. */
export const REVOCATION_MAX_WAIT_MS = 5 * 60 * 1000;
/** Il primo passo dell'attesa crescente: 2s, 4s, 8s, 16s. */
export const REVOCATION_BASE_DELAY_MS = 2000;

/**
 * Lo script, come stringa.
 *
 * E' costruito qui e non scritto a mano in un file statico per una ragione
 * sola: i nomi dei cookie, dei parametri e la versione della grammatica sono
 * definiti altrove, e due copie di un nome sono due copie che prima o poi
 * divergono. Tutto il resto e' ES5 a mano, senza dipendenze: gira nella pagina
 * di un negozio qualsiasi, dove non possiamo dare per scontato niente.
 */
export function consentBridgeScript(): string {
  return `(function (win, doc) {
  var VERSION = ${JSON.stringify(COMPACT_CONSENT_VERSION)};
  var CONSENT_COOKIE = ${JSON.stringify(CONSENT_COOKIE)};
  var LEGACY_CONSENT_COOKIE = ${JSON.stringify(LEGACY_CONSENT_COOKIE)};
  var ID_COOKIE = ${JSON.stringify(EXTERNAL_ID_COOKIE)};
  var CONSENT_PARAM = ${JSON.stringify(CONSENT_QUERY_PARAM)};
  var EXISTING_PARAM = ${JSON.stringify(EXISTING_EXTERNAL_ID_PARAM)};
  var ENDPOINT_ATTR = ${JSON.stringify(ENDPOINT_ATTRIBUTE)};
  var CART_ATTR = ${JSON.stringify(CART_ATTRIBUTE)};
  var GRANTED = ${JSON.stringify(CONSENT_GRANTED_EVENT)};
  var WITHDRAWN = ${JSON.stringify(CONSENT_WITHDRAWN_EVENT)};
  var IDENTITY = ${JSON.stringify(IDENTITY_EVENT)};
  var YEAR = 31536000;
  var announced = '';
  // Quale valore ha gia' l'attributo del carrello, per non riscriverlo uguale a
  // ogni pagina. Parte da null e non da stringa vuota, ed e' una differenza che
  // si vede solo nel caso peggiore: chi aveva dato il permesso in una visita
  // precedente ha gia' l'identificativo nel carrello, e se il vuoto contasse
  // come "gia' vuoto" la revoca non lo toglierebbe — resterebbe li', attaccato
  // all'ordine, di una persona che ha detto di no.
  var lastCart = null;

  // L'indirizzo dell'endpoint del negozio. Dal tag che ha caricato questo file,
  // o da un tag qualsiasi che porti l'attributo: chi inserisce lo script da un
  // tag manager non controlla quale sia currentScript nel momento giusto.
  function endpoint() {
    var el = doc.currentScript;
    var found = el && el.getAttribute(ENDPOINT_ATTR);
    if (!found) {
      var tagged = doc.querySelector('[' + ENDPOINT_ATTR + ']');
      found = tagged && tagged.getAttribute(ENDPOINT_ATTR);
    }
    if (!found && typeof win.KERDON_ENDPOINT === 'string') found = win.KERDON_ENDPOINT;
    // Solo https: su http l'endpoint non puo' emettere un cookie Secure, e un
    // identificativo che viaggia in chiaro non lo si va a cercare.
    return found && found.indexOf('https://') === 0 ? found : '';
  }

  var ENDPOINT = endpoint();

  function privacy() {
    return win.Shopify && win.Shopify.customerPrivacy;
  }

  // Il permesso lo dicono i metodi *Allowed(): sono gia' la risposta a "questo
  // trattamento si puo' fare qui", banner o non banner. currentVisitorConsent()
  // serve solo a distinguere il no detto da chi non ha ancora detto niente.
  function state(allowed, declared) {
    if (allowed === true) return '1';
    if (declared === 'no') return '0';
    return '';
  }

  function read() {
    var api = privacy();
    if (!api || typeof api.currentVisitorConsent !== 'function') return null;

    var said = api.currentVisitorConsent() || {};
    var purposes = [
      ['a', state(api.analyticsProcessingAllowed(), said.analytics)],
      ['m', state(api.marketingAllowed(), said.marketing)],
      ['p', state(api.preferencesProcessingAllowed(), said.preferences)],
      ['s', state(api.saleOfDataAllowed(), said.sale_of_data)]
    ];

    var parts = [VERSION];
    var known = 0;
    for (var i = 0; i < purposes.length; i++) {
      if (purposes[i][1] === '') continue;
      parts.push(purposes[i][0] + purposes[i][1]);
      known++;
    }

    // Niente di dichiarato: non c'e' niente da dire, e dire "no" al posto di
    // chi non ha ancora risposto sarebbe dire una cosa non vera.
    if (known === 0) return null;

    return {
      compact: parts.join('.'),
      allowed: purposes[0][1] === '1' && purposes[1][1] === '1',
      withdrawn: purposes[0][1] === '0' || purposes[1][1] === '0'
    };
  }

  function setCookie(name, value, maxAge) {
    // Secure quando la pagina e' in https, che in una vetrina vera e' sempre.
    // Senza, il cookie viaggia in chiaro sul primo collegamento non cifrato che
    // capita — e quello che c'e' dentro e' la risposta che la persona ha dato
    // al banner. Non e' un identificativo, ma e' comunque una cosa sua.
    //
    // Si guarda il protocollo invece di scriverlo sempre perche' un cookie
    // Secure su http il browser lo scarta in silenzio: in locale, dove si prova
    // senza certificato, sparirebbe senza dire niente.
    var secure = doc.location && doc.location.protocol === 'https:' ? '; Secure' : '';
    doc.cookie =
      name + '=' + value + '; Path=/; Max-Age=' + maxAge + '; SameSite=Lax' + secure;
  }

  function readCookie(name) {
    var all = doc.cookie ? doc.cookie.split(';') : [];
    for (var i = 0; i < all.length; i++) {
      var part = all[i];
      var eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).replace(/^\\s+/, '') !== name) continue;
      return part.slice(eq + 1);
    }
    return '';
  }

  function push(event, payload) {
    win.dataLayer = win.dataLayer || [];
    win.dataLayer.push(payload ? merge({ event: event }, payload) : { event: event });
  }

  function merge(a, b) {
    for (var key in b) if (Object.prototype.hasOwnProperty.call(b, key)) a[key] = b[key];
    return a;
  }

  // L'identificativo attaccato al carrello: e' cosi' che risale nell'ordine, e
  // quindi che l'acquisto di oggi si lega alla visita di tre settimane fa.
  // Same-origin e senza credenziali esplicite: e' il carrello di questo negozio,
  // in questa scheda.
  function cart(value, done) {
    if (value === lastCart && !done) return;
    lastCart = value;
    var body = { attributes: {} };
    body.attributes[CART_ATTR] = value;
    try {
      win.fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (res) {
        if (done) done(!!res && res.status >= 200 && res.status < 300);
      }, function () {
        if (done) done(false);
      });
    } catch (e) {
      if (done) done(false);
    }
  }

  /* -------------------------------------------------------------------------
   * LA REVOCA IN SOSPESO (la "lapide").
   *
   * Alla revoca l'identificativo smette SUBITO di essere usato: il cookie si
   * cancella, niente va sul dataLayer, niente sul carrello. Ma per far
   * cancellare la riga sul server serve proprio quell'identificativo, e una
   * rete che cade o un 503 non devono farlo perdere. Allora lo si mette da
   * parte, altrove e sotto un altro nome: una chiave di localStorage che
   * nessun tag legge e che il browser non manda con nessuna richiesta.
   *
   * La lapide serve SOLO a cancellare. Non si rilegge mai come identificativo
   * attivo, non si rimanda all'endpoint per coniare, non va in analisi ne' nel
   * carrello. Finche' c'e', non si conia e non si riusa niente: la persona che
   * ha detto di no non viene riconosciuta nemmeno se nel frattempo dice di si',
   * finche' la cancellazione non e' confermata.
   *
   * Si toglie solo quando l'endpoint risponde 2xx e il carrello e' svuotato.
   * Dopo REVOCATION_MAX_AGE si rinuncia: e' scritto nel documento di
   * integrazione, e il server ha comunque la revoca registrata se l'aveva
   * presa in carico.
   * ----------------------------------------------------------------------- */
  var TOMB_KEY = ${JSON.stringify(REVOCATION_STORAGE_KEY)};
  var TOMB_MAX_AGE = ${REVOCATION_MAX_AGE_MS};
  // Quante volte si riprova nella stessa pagina, e fino a quanto si aspetta
  // dentro la pagina: oltre, si riprova al prossimo caricamento.
  var MAX_TRIES = ${REVOCATION_MAX_TRIES_PER_PAGE};
  var MAX_WAIT = ${REVOCATION_MAX_WAIT_MS};
  var BASE_DELAY = ${REVOCATION_BASE_DELAY_MS};
  // Gli esiti per cui insistere nella pagina. Gli altri non-2xx non si
  // insistono qui, ma la lapide resta per il prossimo caricamento.
  var RETRYABLE = { 0: 1, 408: 1, 429: 1, 500: 1, 502: 1, 503: 1, 504: 1 };
  // Senza localStorage (navigazione privata, archiviazione bloccata) la
  // lapide vive in memoria: si ritenta nella pagina, non oltre.
  var memTomb = null;
  var revoking = false;

  function now() {
    return win.Date && typeof win.Date.now === 'function' ? win.Date.now() : new Date().getTime();
  }

  function storage() {
    try {
      return win.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function loadTomb() {
    var s = storage();
    if (!s) return memTomb;
    try {
      var raw = s.getItem(TOMB_KEY);
      if (!raw) return null;
      var t = JSON.parse(raw);
      if (!t || typeof t !== 'object' || typeof t.t !== 'number') return null;
      if (!(t.i instanceof Array)) t.i = [];
      return t;
    } catch (e) {
      return null;
    }
  }

  function saveTomb(t) {
    var empty = !t || (!t.i.length && !t.k);
    var s = storage();
    if (!s) {
      memTomb = empty ? null : t;
      return;
    }
    try {
      if (empty) s.removeItem(TOMB_KEY);
      else s.setItem(TOMB_KEY, JSON.stringify(t));
    } catch (e) {
      memTomb = empty ? null : t;
    }
  }

  // Una revoca ancora aperta: qualunque cosa ci sia ancora da disfare.
  function pending() {
    var t = loadTomb();
    return !!t && (t.i.length > 0 || !!t.k);
  }

  function retryAfter(header) {
    if (!header) return -1;
    var text = String(header);
    if (/^[0-9]+$/.test(text)) return parseInt(text, 10) * 1000;
    var when = Date.parse(text);
    return isNaN(when) ? -1 : Math.max(0, when - now());
  }

  function schedule(wait, attempt) {
    if (typeof win.setTimeout !== 'function') return;
    win.setTimeout(function () { revoke(attempt); }, wait);
  }

  function retry(attempt, status, header) {
    var t = loadTomb();
    if (!t || !t.i.length) return;
    var wait = retryAfter(header);
    if (wait < 0) wait = BASE_DELAY * Math.pow(2, attempt);
    t.n = now() + wait;
    saveTomb(t);
    if (!RETRYABLE[status]) return;
    if (wait > MAX_WAIT || attempt + 1 >= MAX_TRIES) return;
    schedule(wait, attempt + 1);
  }

  // La cancellazione della lapide in testa. Porta con se' il permesso detto al
  // momento della revoca, cioe' il no: e' quello che l'endpoint deve vedere per
  // cancellare, e non un permesso letto adesso.
  function revoke(attempt) {
    if (!ENDPOINT || !win.fetch || revoking) return;
    var t = loadTomb();
    if (!t || !t.i.length) return;
    var id = t.i[0];
    revoking = true;
    var url = ENDPOINT + (ENDPOINT.indexOf('?') < 0 ? '?' : '&') +
      CONSENT_PARAM + '=' + encodeURIComponent(t.c) +
      '&' + EXISTING_PARAM + '=' + encodeURIComponent(id);
    try {
      win.fetch(url, { credentials: 'include', mode: 'cors', cache: 'no-store' }).then(function (res) {
        revoking = false;
        var status = res && typeof res.status === 'number' ? res.status : 0;
        if (status >= 200 && status < 300) {
          acknowledged(id);
          return;
        }
        var header = res && res.headers && typeof res.headers.get === 'function'
          ? res.headers.get('Retry-After') : null;
        retry(attempt, status, header);
      }, function () {
        revoking = false;
        retry(attempt, 0, null);
      });
    } catch (e) {
      revoking = false;
      retry(attempt, 0, null);
    }
  }

  function acknowledged(id) {
    var t = loadTomb();
    if (!t) return;
    var rest = [];
    for (var i = 0; i < t.i.length; i++) if (t.i[i] !== id) rest.push(t.i[i]);
    t.i = rest;
    t.n = 0;
    saveTomb(t);
    if (rest.length) revoke(0);
    else resumeGrant();
  }

  function clearCart() {
    cart('', function (ok) {
      if (!ok) return;
      var t = loadTomb();
      if (!t) return;
      t.k = 0;
      saveTomb(t);
      resumeGrant();
    });
  }

  // Chiusa la revoca, se nel frattempo il permesso e' stato dato si chiede un
  // identificativo — nuovo: il vecchio e' gia' stato cancellato dal browser.
  function resumeGrant() {
    if (pending()) return;
    var current = read();
    if (current && current.allowed) ask(current.compact, true);
  }

  // All'apertura della pagina: quello che una visita precedente non e' riuscita
  // a chiudere. Non dipende dal permesso di adesso — cancellare non e'
  // tracciare, ed e' la risposta a un no gia' detto.
  function resume() {
    var t = loadTomb();
    if (!t) return;
    if (now() - t.t > TOMB_MAX_AGE) {
      saveTomb(null);
      return;
    }
    if (t.k) clearCart();
    if (!t.i.length) return;
    var wait = (t.n || 0) - now();
    if (wait <= 0) revoke(0);
    else if (wait <= MAX_WAIT) schedule(wait, 0);
  }

  // Il cookie dell'identificativo lo pianta l'endpoint, spesso sul dominio
  // padre (negozio.it per www.negozio.it): toglierlo solo dall'host non basta.
  function expireId() {
    setCookie(ID_COOKIE, '', 0);
    var host = doc.location && doc.location.hostname;
    if (!host) return;
    var parts = String(host).split('.');
    var secure = doc.location.protocol === 'https:' ? '; Secure' : '';
    for (var i = 0; i < parts.length - 1; i++) {
      doc.cookie = ID_COOKIE + '=; Path=/; Max-Age=0; Domain=' + parts.slice(i).join('.') +
        '; SameSite=Lax' + secure;
    }
  }

  // La chiamata all'endpoint del negozio: mai a noi, e mai con una credenziale.
  // \`credentials: 'include'\` perche' l'endpoint deve poter rileggere il cookie
  // che ha piantato lui — senza, ogni visita sarebbe una persona nuova.
  //
  // \`keep\` dice se la risposta va guardata. Alla revoca non va: la chiamata
  // serve solo a far disfare, e un endpoint che rispondesse comunque con un
  // identificativo ce lo farebbe riattaccare al carrello un istante dopo averlo
  // tolto. Chi ha appena detto di no si ritroverebbe riconosciuto lo stesso.
  function ask(compact, keep) {
    if (!ENDPOINT || !win.fetch) return;
    // Con una revoca aperta non si conia e non si riusa niente.
    if (keep && pending()) return;

    var url = ENDPOINT + (ENDPOINT.indexOf('?') < 0 ? '?' : '&') +
      CONSENT_PARAM + '=' + encodeURIComponent(compact);
    var existing = readCookie(ID_COOKIE);
    if (existing) url += '&' + EXISTING_PARAM + '=' + encodeURIComponent(existing);

    win.fetch(url, { credentials: 'include', mode: 'cors' })
      .then(function (res) {
        if (!keep || !res) return null;
        if (typeof res.status === 'number' && (res.status < 200 || res.status >= 300)) return null;
        return res.json();
      })
      .then(function (body) {
        var row = body && body.length ? body[0] : body;
        var id = row && row.external_id;
        // Nessun identificativo nella risposta e' una risposta: l'endpoint ha
        // deciso di non coniare. Non e' un errore e non si insiste.
        if (!id || typeof id !== 'string') return;
        // Una revoca aperta nel frattempo vince sulla risposta arrivata dopo.
        if (pending()) return;
        push(IDENTITY, { kerdon_external_id: id });
        cart(id);
      })['catch'](function () {});
  }

  function apply() {
    if (!ENDPOINT) return;

    var current = read();
    if (!current) return;
    // Lo stesso permesso non si riannuncia: l'evento e' "e' cambiato", e un tag
    // che parte due volte conta due volte.
    if (current.compact === announced) return;
    announced = current.compact;

    setCookie(CONSENT_COOKIE, current.compact, YEAR);
    // Il cookie col nome di prima del cambio si cancella, non si aggiorna: due
    // copie dello stesso permesso sono due cose che possono divergere, e la
    // divergenza su un consenso e' la piu' brutta da spiegare.
    if (readCookie(LEGACY_CONSENT_COOKIE)) setCookie(LEGACY_CONSENT_COOKIE, '', 0);

    if (current.withdrawn) {
      // L'identificativo si legge un'ultima volta, e poi smette subito di
      // esistere come identificativo: fuori dal cookie, fuori dal carrello.
      // Resta solo nella lapide, che serve a farlo cancellare e a nient'altro.
      var old = readCookie(ID_COOKIE);
      expireId();
      push(WITHDRAWN, { kerdon_consent: current.compact });

      var t = loadTomb() || { i: [], c: current.compact, k: 0, t: now(), n: 0 };
      t.k = 1;
      t.c = current.compact;
      if (old) {
        var known = false;
        for (var i = 0; i < t.i.length; i++) if (t.i[i] === old) known = true;
        if (!known) t.i.push(old);
        t.n = 0;
      }
      saveTomb(t);
      clearCart();

      if (old) revoke(0);
      // Senza identificativo non c'e' niente da cancellare, ma l'endpoint va
      // avvisato lo stesso: e' lui che fa scadere il cookie che ha piantato.
      else ask(current.compact, false);
      return;
    }

    if (current.allowed) {
      push(GRANTED, { kerdon_consent: current.compact });
      ask(current.compact, true);
    }
  }

  // Prima di tutto, quello che una visita precedente ha lasciato aperto.
  resume();

  // Si guarda subito, per chi il permesso lo aveva gia' dato in una visita
  // precedente, e si resta in ascolto: il banner risponde dopo, e "dopo" e'
  // l'unico momento in cui la raccolta puo' cominciare.
  doc.addEventListener('visitorConsentCollected', apply);

  if (privacy()) {
    apply();
  } else if (win.Shopify && typeof win.Shopify.loadFeatures === 'function') {
    win.Shopify.loadFeatures([{ name: 'consent-tracking-api', version: '0.1' }], apply);
  }
})(window, document);
`;
}
