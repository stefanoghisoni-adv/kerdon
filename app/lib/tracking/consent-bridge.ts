import { CONSENT_COOKIE, COMPACT_CONSENT_VERSION } from './consent';
import { EXTERNAL_ID_COOKIE } from './external-id';

/**
 * Il ponte fra il consenso di Shopify e il tracciamento del merchant.
 *
 * PERCHE' SERVE UN PONTE. Il permesso lo raccoglie Shopify, in vetrina, dove
 * c'e' il banner e dove vive la Customer Privacy API. Le chiamate che poi
 * arrivano a noi le fa un container server-side, che quella pagina non l'ha mai
 * vista: fra i due non passa niente se non lo si fa passare. Questo pezzo di
 * codice sta dalla parte del browser e fa una cosa sola — prendere la risposta
 * di Shopify e lasciarla dove il container la trova.
 *
 * COSA NON FA, ed e' la parte che conta: non decide. Non ha regole per paese,
 * non ha valori di ripiego, non presume niente. Se la Customer Privacy API non
 * c'e' o non risponde, il ponte tace e il container non trova niente da
 * mandare: a valle non nasce nessun identificativo. Un consenso che non e'
 * stato dato non lo scrive nessuno al posto di chi non lo ha dato.
 *
 * COME LO LASCIA. Due strade, tutte e due first-party sul dominio del negozio:
 *
 *  - un cookie `corew_consent` con la forma compatta (`v1.a1.m1.p0.s0`), che un
 *    container mappa in una variabile e attacca alla chiamata;
 *  - un evento sul `dataLayer`, per chi fa partire i tag da li'.
 *
 * L'evento del permesso concesso viene spinto SOLO dopo che il permesso c'e'.
 * E' la differenza fra "chiedi e poi comincia" e "comincia e poi chiedi", ed e'
 * tutta la ragione per cui questo file esiste.
 *
 * ALLA REVOCA il ponte cancella dal browser il cookie del permesso e quello
 * dell'identificativo — sul dominio del negozio, dove il nostro `Set-Cookie`
 * non arriva perche' se lo mangia il container — e spinge l'evento della
 * revoca. Le due meta' della revoca sono questa e `forgetVisitor` dal lato
 * server: una toglie il nome dal browser, l'altra la riga dal database.
 */

/** Gli eventi che il ponte spinge sul dataLayer. Nomi stabili: ci si aggancia. */
export const CONSENT_GRANTED_EVENT = 'corew_consent_granted';
export const CONSENT_WITHDRAWN_EVENT = 'corew_consent_withdrawn';

/**
 * Lo script, come stringa.
 *
 * E' costruito qui e non scritto a mano in un file statico per una ragione
 * sola: i nomi dei cookie e la versione della grammatica sono definiti altrove,
 * e due copie di un nome sono due copie che prima o poi divergono. Tutto il
 * resto e' ES5 a mano, senza dipendenze: gira nella pagina di un negozio
 * qualsiasi, dove non possiamo dare per scontato niente.
 */
export function consentBridgeScript(): string {
  return `(function (win, doc) {
  var VERSION = ${JSON.stringify(COMPACT_CONSENT_VERSION)};
  var CONSENT_COOKIE = ${JSON.stringify(CONSENT_COOKIE)};
  var ID_COOKIE = ${JSON.stringify(EXTERNAL_ID_COOKIE)};
  var GRANTED = ${JSON.stringify(CONSENT_GRANTED_EVENT)};
  var WITHDRAWN = ${JSON.stringify(CONSENT_WITHDRAWN_EVENT)};
  var YEAR = 31536000;
  var announced = '';

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

  function push(event, compact) {
    win.dataLayer = win.dataLayer || [];
    win.dataLayer.push({ event: event, corew_consent: compact });
  }

  function apply() {
    var current = read();
    if (!current) return;
    // Lo stesso permesso non si riannuncia: l'evento e' "e' cambiato", e un tag
    // che parte due volte conta due volte.
    if (current.compact === announced) return;
    announced = current.compact;

    setCookie(CONSENT_COOKIE, current.compact, YEAR);

    if (current.withdrawn) {
      setCookie(CONSENT_COOKIE, current.compact, YEAR);
      setCookie(ID_COOKIE, '', 0);
      push(WITHDRAWN, current.compact);
      return;
    }

    if (current.allowed) push(GRANTED, current.compact);
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
