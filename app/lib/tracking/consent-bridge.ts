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
    doc.cookie = name + '=' + value + '; Path=/; Max-Age=' + maxAge + '; SameSite=Lax';
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
  function cart(value) {
    if (value === lastCart) return;
    lastCart = value;
    var body = { attributes: {} };
    body.attributes[CART_ATTR] = value;
    try {
      win.fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })['catch'](function () {});
    } catch (e) {}
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

    var url = ENDPOINT + (ENDPOINT.indexOf('?') < 0 ? '?' : '&') +
      CONSENT_PARAM + '=' + encodeURIComponent(compact);
    var existing = readCookie(ID_COOKIE);
    if (existing) url += '&' + EXISTING_PARAM + '=' + encodeURIComponent(existing);

    win.fetch(url, { credentials: 'include', mode: 'cors' })
      .then(function (res) { return keep ? res.json() : null; })
      .then(function (body) {
        var row = body && body.length ? body[0] : body;
        var id = row && row.external_id;
        // Nessun identificativo nella risposta e' una risposta: l'endpoint ha
        // deciso di non coniare. Non e' un errore e non si insiste.
        if (!id) return;
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
      // Si chiama l'endpoint anche qui, e prima di cancellare: e' l'unico modo
      // di fargli sapere che c'e' da disfare, e l'identificativo da disfare sta
      // ancora nel cookie che stiamo per togliere.
      ask(current.compact, false);
      setCookie(ID_COOKIE, '', 0);
      cart('');
      push(WITHDRAWN, { kerdon_consent: current.compact });
      return;
    }

    if (current.allowed) {
      push(GRANTED, { kerdon_consent: current.compact });
      ask(current.compact, true);
    }
  }

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
