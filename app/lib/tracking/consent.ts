import { postgrestFilterValue } from './users';

/**
 * Il permesso del visitatore, prima di qualunque identificativo.
 *
 * QUESTO FILE ESISTE PERCHE' L'IDENTIFICATIVO NON E' UN DETTAGLIO TECNICO.
 * `kerdon_eid` segue lo stesso browser per un anno, viene scritto nel database
 * del negozio e serve ad attribuire un acquisto alla campagna che lo ha
 * portato: e' un trattamento, e un trattamento si fa se e' permesso. Prima qui
 * non c'era niente — si guardava il token del negozio e si coniava — e il
 * consenso al marketing del CLIENTE, che il proxy controlla sulle letture di
 * `customers`, non c'entra: quello dice se una persona gia' registrata vuole
 * essere contattata, non se il browser di chi sta navigando adesso puo' essere
 * riconosciuto.
 *
 * LE FINALITA', dichiarate come le dichiara Shopify (Customer Privacy API):
 *
 *  - `analytics` — capire come le persone usano il negozio. L'identificativo
 *    e' cio' che tiene insieme le visite della stessa persona: senza, ogni
 *    pagina e' un visitatore nuovo e non esiste nessuna misura.
 *  - `marketing` — l'attribuzione. E' la ragione per cui l'identificativo dura
 *    un anno invece di una sessione: legare l'acquisto di oggi all'annuncio di
 *    tre settimane fa.
 *  - `sale_of_data` — la condivisione con terzi. Kerdon non vende e non
 *    condivide niente: scrive nel database del merchant e basta. Ma
 *    l'identificativo che restituiamo il merchant lo inoltra alle piattaforme
 *    pubblicitarie dal suo container, e quella e' condivisione. Non possiamo
 *    farla noi al posto suo e non possiamo impedirgliela, quindi facciamo
 *    l'unica cosa utile: gli diciamo cosa ha detto il visitatore, in un header
 *    sulla risposta, e la decisione resta dove avviene il fatto.
 *  - `preferences` — non ci riguarda: non ricordiamo nessuna preferenza.
 *
 * SERVONO ENTRAMBE `analytics` E `marketing`, e non e' rigore per il gusto di
 * esserlo: e' lo stesso identificativo a fare tutte e due le cose, e non si
 * puo' coniare "solo per la misura" un valore che poi finira' comunque
 * nell'attribuzione. Chi acconsente a una sola delle due non riceve niente.
 *
 * IL PERMESSO NON SI PRESUME MAI. Assenza di segnale vale come no: e' l'unico
 * modo di non registrare un consenso al posto di chi non lo ha dato. Non c'e'
 * nessuna regola geografica scritta qui dentro, e non deve essercene — se il
 * negozio non e' in una configurazione che richiede il consenso, e' Shopify a
 * dire che le finalita' sono permesse, e noi leggiamo quel "permesso" come
 * qualunque altro.
 */

/** Cosa si sa di una finalita': il "non dichiarato" e' un valore, non un buco. */
export type ConsentState = 'granted' | 'denied' | 'unknown';

/** Le quattro finalita' della Customer Privacy API, nei nostri nomi. */
export interface VisitorConsent {
  analytics: ConsentState;
  marketing: ConsentState;
  preferences: ConsentState;
  saleOfData: ConsentState;
}

/** Nessun segnale: tutto da dichiarare, quindi niente permesso. */
export const UNKNOWN_CONSENT: VisitorConsent = {
  analytics: 'unknown',
  marketing: 'unknown',
  preferences: 'unknown',
  saleOfData: 'unknown',
};

/**
 * Il parametro in querystring, che e' la strada principale.
 *
 * Il template "Supabase Lookup" del container compone l'indirizzo da se' e
 * lascia al merchant UNA sola coppia chiave/valore. Quella coppia adesso serve
 * a questo: le due etichette facoltative (`browser`, `device_type`) hanno gia'
 * la loro strada sul tag Writer, il permesso no.
 */
export const CONSENT_QUERY_PARAM = 'consent';

/** Per chi ha un container che sa aggiungere header. Stessa grammatica. */
export const CONSENT_HEADER = 'X-CoreW-Consent';

/**
 * Il cookie di Shopify, se arriva fino a qui.
 *
 * E' first-party sul dominio del negozio: lo vediamo solo quando la chiamata la
 * fa il browser verso di noi con i cookie del negozio inoltrati da un container
 * first-party. Quando c'e' e' la fonte migliore — l'ha scritto Shopify, non
 * noi — quindi si guarda, ma non si puo' pretendere.
 */
export const SHOPIFY_CONSENT_COOKIE = '_tracking_consent';

/**
 * Il cookie che il ponte in vetrina scrive sul dominio del negozio.
 *
 * Contiene la forma compatta qui sotto, e nient'altro: e' la copia leggibile
 * del permesso, quella che un container puo' mappare in una variabile e
 * attaccare alla chiamata. Non e' una prova di consenso e non sostituisce
 * quella di Shopify — e' il modo in cui il "si" gia' dato arriva fin qui.
 */
export const CONSENT_COOKIE = 'corew_consent';

/**
 * L'header con cui rispondiamo sulla condivisione con terzi.
 *
 * Non serve a noi: serve a chi, a valle, decide se mandare l'identificativo a
 * una piattaforma pubblicitaria. Vale `granted`, `denied` o `unknown`, e
 * `unknown` non e' un permesso.
 */
export const SALE_OF_DATA_HEADER = 'X-CoreW-Sale-Of-Data';

/**
 * La forma compatta: `v1.a1.m1.p0.s0`.
 *
 * Sta in un cookie, in un header e in un valore di querystring senza doverla
 * codificare — nessun carattere che un intermediario riscriva — ed e' una
 * stringa sola perche' il template ne lascia passare una sola. Le lettere sono
 * le iniziali delle finalita' di Shopify, `1` e' si, `0` e' no, un segmento che
 * manca e' una finalita' non dichiarata.
 *
 * La versione in testa non e' cerimonia: questo valore lo scrivera' del codice
 * in vetrina che resta li' per mesi, e il giorno in cui la grammatica cambia
 * dobbiamo poter riconoscere il vecchio invece di leggerlo a rovescio.
 */
export const COMPACT_CONSENT_VERSION = 'v1';

const PURPOSE_LETTERS: Record<string, keyof VisitorConsent> = {
  a: 'analytics',
  m: 'marketing',
  p: 'preferences',
  s: 'saleOfData',
};

/** Legge la forma compatta. Se non e' della nostra versione, non e' nostra. */
export function parseCompactConsent(raw: string | null | undefined): VisitorConsent | null {
  const value = postgrestFilterValue(raw);
  if (!value) return null;

  const segments = value.toLowerCase().split('.');
  if (segments.shift() !== COMPACT_CONSENT_VERSION) return null;

  const consent = { ...UNKNOWN_CONSENT };
  let seen = false;

  for (const segment of segments) {
    const purpose = PURPOSE_LETTERS[segment[0]];
    if (!purpose) continue;
    if (segment.length !== 2) continue;
    if (segment[1] === '1') {
      consent[purpose] = 'granted';
      seen = true;
    } else if (segment[1] === '0') {
      consent[purpose] = 'denied';
      seen = true;
    }
  }

  return seen ? consent : null;
}

/** Scrive la forma compatta. La usa il ponte in vetrina, e i test. */
export function compactConsent(consent: VisitorConsent): string {
  const letters = Object.entries(PURPOSE_LETTERS)
    .filter(([, purpose]) => consent[purpose] !== 'unknown')
    .map(([letter, purpose]) => `${letter}${consent[purpose] === 'granted' ? '1' : '0'}`);

  return [COMPACT_CONSENT_VERSION, ...letters].join('.');
}

/**
 * I quattro parametri per esteso, con i nomi delle finalita' di Shopify.
 *
 * Sono la seconda strada, per chi puo' attaccare piu' di una coppia. I valori
 * accettati sono quelli che Shopify stessa usa (`yes`/`no`, dal risultato di
 * `currentVisitorConsent()`) piu' i modi in cui la stessa cosa si scrive
 * altrove: chi configura una variabile in un container non sta leggendo la
 * nostra documentazione mentre lo fa.
 */
const NAMED_PARAMS: Array<[string, keyof VisitorConsent]> = [
  ['analytics', 'analytics'],
  ['marketing', 'marketing'],
  ['preferences', 'preferences'],
  ['sale_of_data', 'saleOfData'],
];

const YES = new Set(['yes', 'true', '1', 'granted', 'allowed']);
const NO = new Set(['no', 'false', '0', 'denied', 'refused']);

function namedState(raw: string | null | undefined): ConsentState {
  const value = postgrestFilterValue(raw)?.toLowerCase();
  if (!value) return 'unknown';
  if (YES.has(value)) return 'granted';
  if (NO.has(value)) return 'denied';
  return 'unknown';
}

function parseNamedConsent(params: URLSearchParams): VisitorConsent | null {
  const consent = { ...UNKNOWN_CONSENT };
  let seen = false;

  for (const [param, purpose] of NAMED_PARAMS) {
    const state = namedState(params.get(param));
    if (state === 'unknown') continue;
    consent[purpose] = state;
    seen = true;
  }

  return seen ? consent : null;
}

/**
 * Il cookie `_tracking_consent` di Shopify.
 *
 * Il corpo e' JSON e cambia forma fra le versioni: si guardano i due posti dove
 * il permesso e' comparso finora — `purposes`, con booleani, e `con.CMP`, con
 * `"1"`/`"0"`/`""` — e si prende il primo che dice qualcosa. Tutto il resto del
 * documento (regione, regolamento, se mostrare il banner) NON si legge: non e'
 * timidezza, e' che una regola geografica interpretata da noi sarebbe una
 * regola nostra, e la Customer Privacy API ha gia' deciso — se il consenso non
 * serve, le finalita' arrivano permesse.
 */
export function parseShopifyConsentCookie(raw: string | null | undefined): VisitorConsent | null {
  if (!raw) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>;
  } catch {
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object') return null;

  const consent = { ...UNKNOWN_CONSENT };
  let seen = false;

  const purposes = payload.purposes as Record<string, unknown> | undefined;
  const cmp = (payload.con as Record<string, unknown> | undefined)?.CMP as
    | Record<string, unknown>
    | undefined;

  for (const [letter, purpose] of Object.entries(PURPOSE_LETTERS)) {
    const fromPurposes = purposes?.[letter];
    if (typeof fromPurposes === 'boolean') {
      consent[purpose] = fromPurposes ? 'granted' : 'denied';
      seen = true;
      continue;
    }

    const fromCmp = cmp?.[letter];
    if (fromCmp === '1' || fromCmp === true) {
      consent[purpose] = 'granted';
      seen = true;
    } else if (fromCmp === '0' || fromCmp === false) {
      consent[purpose] = 'denied';
      seen = true;
    }
  }

  return seen ? consent : null;
}

/** Un cookie qualsiasi dentro l'intestazione `Cookie`. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }

  return null;
}

/**
 * Le stesse chiavi dentro il corpo di una POST.
 *
 * Il template "Supabase Writer" manda un oggetto JSON piatto costruito da
 * coppie nome/valore, e non ha una querystring da riempire: per chi scrive —
 * `/rest/v1/users` e `/rest/v1/identify` — la strada naturale e' una coppia in
 * piu' nel corpo, con lo stesso nome e la stessa grammatica del parametro.
 *
 * Vale come le altre fonti e non piu' delle altre: e' cio' che il container
 * dichiara di aver letto in vetrina, non una dichiarazione del container.
 */
export function consentFromFields(
  fields: Record<string, unknown> | null | undefined,
): VisitorConsent | null {
  if (!fields || typeof fields !== 'object') return null;

  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

  const compact = parseCompactConsent(text(fields[CONSENT_QUERY_PARAM]));
  if (compact) return compact;

  const params = new URLSearchParams();
  for (const [param] of NAMED_PARAMS) {
    const value = text(fields[param]);
    if (value !== null) params.set(param, value);
  }

  return parseNamedConsent(params);
}

/** Da dove viene il permesso che abbiamo letto. Serve nei log e nei test. */
export type ConsentSource =
  | 'query'
  | 'header'
  | 'body'
  | 'shopify_cookie'
  | 'bridge_cookie'
  | 'none';

export interface ConsentDecision {
  consent: VisitorConsent;
  source: ConsentSource;
  /** Si puo' coniare, scrivere il cookie e scrivere la riga. */
  allowed: boolean;
  /**
   * Il visitatore ha detto no a una delle due finalita' che servono.
   *
   * Non e' il contrario di `allowed`: "non ha ancora detto niente" e "ha detto
   * no" portano tutti e due a non raccogliere, ma solo il secondo fa scattare
   * la cancellazione di cio' che era stato raccolto prima.
   */
  withdrawn: boolean;
}

/**
 * L'ordine in cui si guarda, e perche' e' questo.
 *
 * Prima la querystring e l'header: sono il permesso che il container ha appena
 * letto in vetrina, quindi il piu' recente. Poi il cookie di Shopify, che e' la
 * fonte migliore ma arriva solo in alcune configurazioni. Ultimo il nostro
 * cookie-ponte, che e' una copia e vale quanto una copia.
 *
 * Il primo segnale che dice qualcosa vince, intero: non si mescolano fonti
 * diverse: due fonti in disaccordo vorrebbero dire che una delle due e'
 * vecchia, e mettere insieme i pezzi piu' permissivi di ciascuna sarebbe il
 * modo esatto di costruire un consenso che nessuno ha dato.
 */
export function consentFromRequest(
  request: Request,
  fields?: Record<string, unknown> | null,
): {
  consent: VisitorConsent;
  source: ConsentSource;
} {
  const params = new URL(request.url).searchParams;
  const cookieHeader = request.headers.get('Cookie');

  const fromQuery =
    parseCompactConsent(params.get(CONSENT_QUERY_PARAM)) ?? parseNamedConsent(params);
  if (fromQuery) return { consent: fromQuery, source: 'query' };

  const fromHeader = parseCompactConsent(request.headers.get(CONSENT_HEADER));
  if (fromHeader) return { consent: fromHeader, source: 'header' };

  const fromBody = consentFromFields(fields);
  if (fromBody) return { consent: fromBody, source: 'body' };

  const fromShopify = parseShopifyConsentCookie(readCookie(cookieHeader, SHOPIFY_CONSENT_COOKIE));
  if (fromShopify) return { consent: fromShopify, source: 'shopify_cookie' };

  const fromBridge = parseCompactConsent(readCookie(cookieHeader, CONSENT_COOKIE));
  if (fromBridge) return { consent: fromBridge, source: 'bridge_cookie' };

  return { consent: UNKNOWN_CONSENT, source: 'none' };
}

/** Le due finalita' senza le quali l'identificativo non ha ragione di nascere. */
export function isTrackingAllowed(consent: VisitorConsent): boolean {
  return consent.analytics === 'granted' && consent.marketing === 'granted';
}

/** Un no esplicito su una delle due: c'e' anche da disfare, non solo da non fare. */
export function isTrackingWithdrawn(consent: VisitorConsent): boolean {
  return consent.analytics === 'denied' || consent.marketing === 'denied';
}

/**
 * Il segnale globale del browser contro la condivisione con terzi.
 *
 * `Sec-GPC: 1` e' una dichiarazione dell'utente che il browser porta da se', e
 * in alcune giurisdizioni vale come opt-out formale. Riguarda la vendita e la
 * condivisione, non la misura: quindi tocca `saleOfData` e nient'altro, e non
 * puo' essere annullato da un permesso arrivato da altrove — un "no" esplicito
 * non si sovrascrive con un "si" di seconda mano.
 */
function applyGlobalPrivacyControl(request: Request, consent: VisitorConsent): VisitorConsent {
  return request.headers.get('Sec-GPC') === '1'
    ? { ...consent, saleOfData: 'denied' }
    : consent;
}

/** Tutto insieme: cosa ha detto il visitatore, e cosa possiamo farne. */
export function evaluateVisitorConsent(
  request: Request,
  fields?: Record<string, unknown> | null,
): ConsentDecision {
  const { consent: raw, source } = consentFromRequest(request, fields);
  const consent = applyGlobalPrivacyControl(request, raw);

  return {
    consent,
    source,
    allowed: isTrackingAllowed(consent),
    withdrawn: isTrackingWithdrawn(consent),
  };
}

/** Il valore dell'header sulla condivisione: si dice com'e', anche "non so". */
export function saleOfDataHeaderValue(consent: VisitorConsent): ConsentState {
  return consent.saleOfData;
}
