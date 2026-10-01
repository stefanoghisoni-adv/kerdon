/**
 * Il vocabolario della verifica: cosa si controlla, e come si legge un cookie.
 *
 * PERCHE' E' UN FILE A PARTE. La verifica vera chiama l'endpoint del merchant,
 * quindi vive sul server e si chiama `.server`. Ma i nomi dei controlli e i
 * motivi per cui falliscono li deve conoscere anche la pagina che li mostra, e
 * un modulo del server tirato dentro il pacchetto del browser porterebbe con se'
 * tutto quello che importa. Qui non c'e' niente che chiami niente: solo forme e
 * funzioni pure, che girano dalle due parti.
 */

export type CheckId =
  | 'endpoint_url'
  | 'https'
  | 'reachable'
  | 'no_redirect'
  | 'consent_granted'
  | 'cookie_attributes'
  | 'consent_missing'
  | 'consent_withdrawn';

/** L'ordine in cui si mostrano: e' anche l'ordine in cui si rompono. */
export const CHECK_ORDER: CheckId[] = [
  'endpoint_url',
  'https',
  'reachable',
  'no_redirect',
  'consent_granted',
  'cookie_attributes',
  'consent_missing',
  'consent_withdrawn',
];

export interface CheckResult {
  id: CheckId;
  ok: boolean;
  /**
   * Il motivo, come codice.
   *
   * `null` quando e' andata bene. `not_run` quando un controllo precedente ha
   * reso questo impossibile — che non e' la stessa cosa di fallito, e mostrarli
   * uguali manderebbe il merchant a cercare un problema dove non c'e'.
   */
  reason: string | null;
}

export interface VerifyResult {
  passed: boolean;
  checks: CheckResult[];
}

export interface ParsedCookie {
  value: string;
  attributes: Record<string, string>;
}

/** Il nostro cookie dentro i `Set-Cookie` di una risposta, se c'e'. */
export function parseSetCookie(
  headers: readonly string[],
  name: string,
): ParsedCookie | null {
  for (const raw of headers) {
    const [pair, ...rest] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;

    const attributes: Record<string, string> = {};
    for (const part of rest) {
      const [key, ...value] = part.trim().split('=');
      // Il valore vuoto per gli attributi senza valore (`Secure`, `HttpOnly`):
      // quello che conta li' e' la presenza, non il contenuto.
      attributes[key.toLowerCase()] = value.join('=').trim();
    }

    return { value: pair.slice(eq + 1).trim(), attributes };
  }

  return null;
}

/** Il cookie e' stato fatto scadere: valore vuoto, o durata a zero, o data passata. */
export function isExpiredCookie(cookie: ParsedCookie): boolean {
  const maxAge = cookie.attributes['max-age'];
  if (maxAge !== undefined && Number(maxAge) <= 0) return true;

  const expires = cookie.attributes.expires;
  if (expires) {
    const at = new Date(expires);
    if (!Number.isNaN(at.getTime()) && at.getTime() <= Date.now()) return true;
  }

  return cookie.value === '';
}

/**
 * Gli attributi che il cookie first-party deve avere.
 *
 * `Secure` perche' un identificativo che segue una persona per un anno non
 * viaggia in chiaro. `Path=/` perche' altrimenti esiste solo sotto la pagina
 * dove e' nato, e chi arriva da un'altra parte del negozio riparte da zero.
 * `SameSite` dichiarato — `Lax` va benissimo, first-party — perche' senza il
 * browser decide da se' e la decisione cambia fra un browser e l'altro. Una
 * durata, infine: un cookie di sessione muore chiudendo la scheda, e
 * l'attribuzione a tre settimane non esiste piu'.
 *
 * NON si pretende `HttpOnly`, ed e' voluto: lo script in vetrina deve poterlo
 * leggere per attaccare lo stesso identificativo al carrello.
 */
export function cookieAttributeProblem(cookie: ParsedCookie): string | null {
  if (!('secure' in cookie.attributes)) return 'cookie_not_secure';
  if ((cookie.attributes.path ?? '') !== '/') return 'cookie_path';
  if (!cookie.attributes.samesite) return 'cookie_samesite';

  const maxAge = Number(cookie.attributes['max-age'] ?? NaN);
  const hasExpiry = (!Number.isNaN(maxAge) && maxAge > 0) || Boolean(cookie.attributes.expires);
  if (!hasExpiry) return 'cookie_session_only';

  return null;
}
