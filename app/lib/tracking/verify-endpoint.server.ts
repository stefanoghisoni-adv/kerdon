import {
  EXISTING_EXTERNAL_ID_PARAM,
  EXTERNAL_ID_COOKIE,
  EXTERNAL_ID_HEADER,
  isExternalId,
} from './external-id';
import { CONSENT_QUERY_PARAM } from './consent';
import {
  CHECK_ORDER,
  cookieAttributeProblem,
  isExpiredCookie,
  parseSetCookie,
  type CheckId,
  type CheckResult,
  type VerifyResult,
} from './verify-checks';
import { isPublicName, registrableDomain } from './endpoint-host.server';
import {
  SafeFetchError,
  safeFetch,
  systemResolver,
  urlProblem,
  type Resolver,
  type Transport,
} from '~/lib/net/safe-fetch.server';

/**
 * La prova che il giro si chiude davvero.
 *
 * PERCHE' ESISTE. Fino a ieri un merchant poteva arrivare in fondo alla
 * configurazione, leggere "collegato" ovunque, e non tracciare niente: nessuno
 * aveva mai chiamato il suo endpoint. Le due schermate che diceva "a posto"
 * guardavano cose nostre — il progetto collegato, la chiave emessa — e il pezzo
 * che manca non e' mai stato nostro: e' l'endpoint first-party sul dominio del
 * negozio, che scrive il cookie. Nessuna quantita' di stato interno puo'
 * rispondere alla domanda "quel pezzo c'e' ed e' fatto bene": bisogna
 * chiamarlo.
 *
 * QUINDI QUI SI CHIAMA. Tre volte, con tre situazioni diverse, e si guarda cosa
 * risponde:
 *
 *  1. con il permesso: deve restituire un identificativo della nostra forma e
 *     piantare il cookie;
 *  2. senza nessun segnale di permesso: non deve restituire niente e non deve
 *     piantare niente — l'assenza di segnale e' un no, e un endpoint che
 *     traccia lo stesso e' peggio di uno che non traccia affatto;
 *  3. con la revoca: non deve restituire niente e deve far scadere il cookie.
 *
 * IL RISULTATO NON E' UN BOOLEANO SOLO. Ogni controllo torna con il suo esito e
 * il suo codice: "non funziona" non aiuta nessuno a farlo funzionare, mentre
 * "il cookie non ha Secure" si corregge in trenta secondi. Le frasi non stanno
 * qui — qui stanno i codici, e la lingua la sceglie chi mostra.
 *
 * NON MANDA MAI IL TOKEN DI LETTURA. Questa funzione non ce l'ha e non deve
 * averlo: parla con l'endpoint del merchant esattamente come ci parla il
 * browser di un visitatore, cioe' senza nessuna credenziale. Il token vive fra
 * l'endpoint del merchant e noi, dove nessun browser lo vede.
 */

/** Il permesso pieno, nella forma compatta che l'endpoint deve saper leggere. */
const CONSENT_GRANTED = 'v1.a1.m1.p0.s0';
/** Il no esplicito: non l'assenza di segnale, ma una revoca dichiarata. */
const CONSENT_WITHDRAWN = 'v1.a0.m0.p0.s0';

/** Oltre questo, l'endpoint non e' lento: e' fermo. La vetrina non aspetta. */
const TIMEOUT_MS = 8000;
/**
 * Il tempo per tutta la verifica, le tre chiamate insieme: tre endpoint lenti
 * di fila non devono diventare una richiesta che resta appesa mezzo minuto.
 */
const TOTAL_TIMEOUT_MS = 20000;
/**
 * Quanto si legge di una risposta. L'endpoint restituisce un identificativo e
 * poco altro: qualche centinaio di byte. Il tetto e' largo cento volte tanto, e
 * serve a non scaricare in memoria quello che un indirizzo sbagliato — o
 * scelto apposta — puo' mandare.
 */
const MAX_BYTES = 32 * 1024;

function ok(id: CheckId): CheckResult {
  return { id, ok: true, reason: null };
}

function fail(id: CheckId, reason: string): CheckResult {
  return { id, ok: false, reason };
}

/**
 * I `Set-Cookie` di una risposta, tutti.
 *
 * `getSetCookie()` e non `get('set-cookie')`: il secondo unisce le
 * intestazioni ripetute in una stringa sola separata da virgole, e le virgole
 * ci sono anche dentro le date di `Expires`. Tagliare li' spezza il cookie a
 * meta' e fa fallire un controllo che sarebbe passato.
 */
function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
}

/** L'identificativo dentro una risposta, header o corpo che sia. */
async function identifierIn(response: Response): Promise<string | null> {
  const fromHeader = response.headers.get(EXTERNAL_ID_HEADER);
  if (isExternalId(fromHeader)) return fromHeader;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  // L'array e' la forma che restituisce l'app, e che l'endpoint del merchant
  // dovrebbe rimandare com'e'. L'oggetto singolo si accetta lo stesso: chi
  // scrive il proprio endpoint puo' averlo semplificato, e non e' un errore.
  const first = Array.isArray(body) ? body[0] : body;
  const value = (first as { external_id?: unknown } | null)?.external_id;
  return isExternalId(typeof value === 'string' ? value : null)
    ? (value as string)
    : null;
}

/** Come si chiama l'endpoint del merchant: senza credenziali, come un visitatore. */
function callUrl(endpoint: string, params: Record<string, string>): string {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export interface VerifyOptions {
  endpoint: string;
  /** Il nostro host. L'endpoint non puo' essere questo: sarebbe di terze parti. */
  appHost: string;
  /**
   * Il dominio da cui il negozio si vede in vetrina, quando lo conosciamo.
   *
   * Quando c'e' si controlla che l'endpoint stia sullo stesso sito: e' cio' che
   * rende first-party il cookie. Quando non c'e' — i negozi collegati prima che
   * lo registrassimo — il controllo non si fa, invece di farlo su un valore
   * inventato.
   */
  storefrontDomain?: string | null;
  /**
   * Iniettabili per i test: chi risolve i nomi e chi si collega. In esercizio
   * sono il DNS e https di Node, sempre dietro `safeFetch`.
   */
  resolve?: Resolver;
  transport?: Transport;
  /** Il tempo massimo di ogni chiamata; i test lo accorciano. */
  timeoutMs?: number;
}

/**
 * Perche' una chiamata non e' andata, detto come lo deve leggere il merchant.
 *
 * Un nome che porta a un indirizzo privato non e' "irraggiungibile" nel senso
 * di spento: e' un indirizzo che da internet non si vede, e la frase giusta e'
 * quella. Tutto il resto — DNS che non risponde, tempo scaduto, connessione
 * rifiutata — per chi guarda e' la stessa cosa: non risponde.
 */
function callFailure(err: unknown): string {
  if (err instanceof SafeFetchError) {
    if (err.code === 'blocked_address') return 'endpoint_not_public';
    if (err.code === 'too_large') return 'response_too_large';
  }
  return 'unreachable';
}

/**
 * Il DNS, interrogato una volta per verifica.
 *
 * Le tre chiamate vanno allo stesso indirizzo: se il nome cambiasse risposta
 * fra la prima e la seconda — ed e' il trucco di chi vuole far passare il
 * controllo a un indirizzo pubblico e la chiamata a uno privato — la seconda
 * userebbe comunque quello gia' verificato.
 */
function resolveOnce(resolve: Resolver): Resolver {
  const seen = new Map<string, ReturnType<Resolver>>();
  return (host) => {
    let found = seen.get(host);
    if (!found) {
      found = resolve(host);
      seen.set(host, found);
    }
    return found;
  };
}

export async function verifyTrackingEndpoint({
  endpoint,
  appHost,
  storefrontDomain,
  resolve = systemResolver,
  transport,
  timeoutMs = TIMEOUT_MS,
}: VerifyOptions): Promise<VerifyResult> {
  const checks: CheckResult[] = [];
  const rest = (reason: string): VerifyResult => {
    for (const id of CHECK_ORDER) {
      if (!checks.some((c) => c.id === id)) checks.push(fail(id, reason));
    }
    return { passed: false, checks };
  };

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    checks.push(fail('endpoint_url', 'endpoint_malformed'));
    return rest('not_run');
  }

  // Nome e password nell'indirizzo: nessuna pagina del negozio li manda, e
  // un endpoint che li vuole non e' quello che le pagine chiamano.
  if (urlProblem(url) === 'userinfo') {
    checks.push(fail('endpoint_url', 'endpoint_credentials'));
    return rest('not_run');
  }

  // Senza il punto finale: `negozio.myshopify.com.` e' lo stesso nome, e non
  // deve passare i controlli che il nome senza punto non passa.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!isPublicName(host)) {
    checks.push(fail('endpoint_url', 'endpoint_not_public'));
    return rest('not_run');
  }
  // Il nostro dominio non e' first-party per nessun negozio: un endpoint che
  // punta qui rimette il cookie esattamente dove i browser lo cancellano, che e'
  // il problema da cui tutto questo giro nasce.
  if (host === appHost.toLowerCase().replace(/\.$/, '')) {
    checks.push(fail('endpoint_url', 'endpoint_is_app'));
    return rest('not_run');
  }
  // `*.myshopify.com` e' di Shopify: nessuno puo' mettere del proprio codice
  // sotto quel nome, quindi un endpoint li' non risponde a nessuno.
  if (host === 'myshopify.com' || host.endsWith('.myshopify.com')) {
    checks.push(fail('endpoint_url', 'endpoint_is_shopify'));
    return rest('not_run');
  }
  if (
    storefrontDomain &&
    registrableDomain(storefrontDomain) !== registrableDomain(host)
  ) {
    checks.push(fail('endpoint_url', 'endpoint_not_first_party'));
    return rest('not_run');
  }
  // La porta di https e nessun'altra: le pagine del negozio chiamano
  // l'indirizzo come lo chiamerebbe un browser, e un endpoint su una porta
  // diversa e' un servizio che non e' fatto per loro.
  if (urlProblem(url) === 'bad_port') {
    checks.push(fail('endpoint_url', 'endpoint_port'));
    return rest('not_run');
  }
  checks.push(ok('endpoint_url'));

  if (url.protocol !== 'https:') {
    checks.push(fail('https', 'not_https'));
    return rest('not_run');
  }
  checks.push(ok('https'));

  // Una scadenza per tutta la verifica, oltre a quella di ogni chiamata.
  const total = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
  const lookup = resolveOnce(resolve);

  const call = (params: Record<string, string>, cookie?: string) =>
    safeFetch(callUrl(endpoint, params), {
      // Nessun rimando seguito: un 301 verso lo stesso indirizzo in https
      // sembra innocuo, ma fa perdere per strada gli header e i `Set-Cookie` a
      // chi lo segue, e in vetrina si traduce in un identificativo che non
      // arriva mai. Il 3xx torna qui com'e', e diventa un controllo fallito.
      maxRedirects: 0,
      maxBytes: MAX_BYTES,
      timeoutMs,
      signal: total,
      headers: cookie ? { Accept: 'application/json', Cookie: cookie } : { Accept: 'application/json' },
      resolve: lookup,
      transport,
    });

  let granted: Response;
  try {
    granted = await call({ [CONSENT_QUERY_PARAM]: CONSENT_GRANTED });
  } catch (err) {
    checks.push(fail('reachable', callFailure(err)));
    return rest('not_run');
  }
  checks.push(ok('reachable'));

  if (granted.status >= 300 && granted.status < 400) {
    checks.push(fail('no_redirect', 'redirected'));
    return rest('not_run');
  }
  checks.push(ok('no_redirect'));

  const grantedCookie = parseSetCookie(setCookies(granted), EXTERNAL_ID_COOKIE);
  const identifier = await identifierIn(granted);

  if (!identifier) {
    checks.push(fail('consent_granted', granted.ok ? 'no_identifier' : 'endpoint_error'));
    return rest('not_run');
  }
  if (!grantedCookie || isExpiredCookie(grantedCookie)) {
    checks.push(fail('consent_granted', 'no_cookie'));
    return rest('not_run');
  }
  checks.push(ok('consent_granted'));

  const problem = cookieAttributeProblem(grantedCookie);
  checks.push(problem ? fail('cookie_attributes', problem) : ok('cookie_attributes'));

  // Nessun parametro di permesso: e' il caso del visitatore che non ha ancora
  // risposto al banner, ed e' il controllo che conta di piu' — un endpoint che
  // qui conia un identificativo lo conia per tutti, banner o non banner.
  try {
    const missing = await call({});
    const missingId = await identifierIn(missing);
    const missingCookie = parseSetCookie(setCookies(missing), EXTERNAL_ID_COOKIE);
    const planted = missingCookie && !isExpiredCookie(missingCookie);

    if (missingId) checks.push(fail('consent_missing', 'identifier_without_consent'));
    else if (planted) checks.push(fail('consent_missing', 'cookie_without_consent'));
    else checks.push(ok('consent_missing'));
  } catch (err) {
    checks.push(fail('consent_missing', callFailure(err)));
  }

  // La revoca: si dichiara il no e si rimanda l'identificativo di prima, che e'
  // esattamente cio' che fa l'endpoint quando il visitatore cambia idea.
  try {
    // Il cookie oltre al parametro: il template sGTM riconosce come "di questo
    // browser" solo l'identificativo che arriva nel cookie, e un parametro da
    // solo non lo fa cancellare.
    const withdrawn = await call(
      {
        [CONSENT_QUERY_PARAM]: CONSENT_WITHDRAWN,
        [EXISTING_EXTERNAL_ID_PARAM]: identifier,
      },
      identifier ? `${EXTERNAL_ID_COOKIE}=${identifier}` : undefined,
    );
    const stillThere = await identifierIn(withdrawn);
    const cookie = parseSetCookie(setCookies(withdrawn), EXTERNAL_ID_COOKIE);

    if (stillThere) checks.push(fail('consent_withdrawn', 'identifier_after_withdrawal'));
    else if (!cookie) checks.push(fail('consent_withdrawn', 'cookie_not_cleared'));
    else if (!isExpiredCookie(cookie)) checks.push(fail('consent_withdrawn', 'cookie_not_cleared'));
    else checks.push(ok('consent_withdrawn'));
  } catch (err) {
    checks.push(fail('consent_withdrawn', callFailure(err)));
  }

  return { passed: checks.every((c) => c.ok), checks };
}
