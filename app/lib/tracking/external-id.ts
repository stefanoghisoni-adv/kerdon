/**
 * L'identificativo che segue un browser nel tempo.
 *
 * Serve a una cosa sola: legare fra loro gli eventi di una stessa persona anche
 * prima che si sia identificata, e poi ricollegarli al cliente quando compra.
 * Senza, ogni visita e' una persona nuova e il profitto per cliente non si puo'
 * costruire.
 *
 * Il formato e' `corew_<millisecondi>_<32 caratteri>`. Le tre parti servono
 * tutte:
 *
 *  - il prefisso lo rende riconoscibile fra i cookie di un negozio, dove ce ne
 *    sono decine di terzi diversi;
 *  - i millisecondi dicono quando quel browser e' stato visto la prima volta,
 *    che e' l'unica informazione temporale che serve e si legge senza
 *    interrogare niente;
 *  - i 32 caratteri casuali sono cio' che lo rende unico. Il tempo da solo non
 *    basta: due visitatori nello stesso millisecondo avrebbero lo stesso id, e
 *    i loro eventi finirebbero insieme.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Quanti caratteri casuali. 62^32 e' abbastanza da non doverci pensare. */
export const RANDOM_LENGTH = 32;

export const EXTERNAL_ID_PREFIX = 'corew';

/** Riconosce un identificativo nostro, e ben formato. */
export const EXTERNAL_ID_PATTERN = /^corew_\d+_[A-Za-z0-9]{32}$/;

export function isExternalId(value: string | null | undefined): boolean {
  return typeof value === 'string' && EXTERNAL_ID_PATTERN.test(value);
}

/**
 * Genera un identificativo nuovo.
 *
 * La casualita' viene da `crypto.getRandomValues` e non da `Math.random`:
 * quest'ultimo e' prevedibile, e un identificativo indovinabile permetterebbe a
 * qualcuno di farsi passare per un altro visitatore.
 *
 * Il modulo su 256 introdurrebbe una piccola preferenza per le prime lettere
 * dell'alfabeto — 256 non e' divisibile per 62. Qui i valori fuori dall'ultimo
 * multiplo intero si scartano e si ripesca: costa qualche byte in piu' e toglie
 * lo sbilanciamento.
 */
export function newExternalId(now: number = Date.now()): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = '';

  while (out.length < RANDOM_LENGTH) {
    const bytes = new Uint8Array(RANDOM_LENGTH);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === RANDOM_LENGTH) break;
    }
  }

  return `${EXTERNAL_ID_PREFIX}_${Math.floor(now)}_${out}`;
}

/** Il nome del cookie. */
export const EXTERNAL_ID_COOKIE = 'corew_eid';

/**
 * Il nome dell'header di risposta che porta l'identificativo.
 *
 * Un cookie `SameSite=None; Secure` dal nostro dominio e' di terze parti, e
 * Safari e Firefox lo scartano. Quando il tracciamento passa da un container
 * server-side — un GTM server-side ospitato da chiunque, o un backend del
 * merchant — la chiamata al proxy la
 * fa il container e non il browser: il `Set-Cookie` viene consumato li' e al
 * browser non arriva mai.
 *
 * Restituendo l'identificativo anche in un header di risposta, un container
 * server-side puo' leggerlo e piantarlo come cookie first-party sul dominio
 * del negozio, dove nessun browser lo blocca.
 */
export const EXTERNAL_ID_HEADER = 'X-CoreW-External-Id';

/** Un anno: piu' corto perderebbe il legame proprio con chi torna di rado. */
const MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * Il cookie da restituire al browser.
 *
 * `SameSite=None; Secure` perche' la richiesta arriva dal negozio del merchant
 * verso il nostro dominio: senza, il browser lo scarterebbe.
 *
 * Niente `HttpOnly`: questo identificativo deve poter essere letto anche dal
 * codice di tracciamento nella pagina, che e' chi lo allega agli eventi. Non
 * protegge nulla — non e' una credenziale — e nasconderlo al solo script che
 * lo usa lo renderebbe inutile.
 */
export function externalIdCookie(value: string): string {
  return [
    `${EXTERNAL_ID_COOKIE}=${value}`,
    'Path=/',
    `Max-Age=${MAX_AGE_SECONDS}`,
    'SameSite=None',
    'Secure',
  ].join('; ');
}

/**
 * Il cookie che cancella il cookie.
 *
 * Alla revoca il permesso di tenere quell'identificativo nel browser finisce, e
 * il modo di toglierlo e' rimandarlo scaduto: stesso nome, stesso `Path`, stessi
 * attributi — un browser che non li ritrova identici non riconosce il cookie da
 * sostituire e si tiene quello vecchio.
 *
 * DOVE FUNZIONA E DOVE NO, e va detto perche' non e' una promessa che possiamo
 * mantenere sempre. Se la chiamata la fa il browser, funziona. Se la fa un
 * container server-side, il `Set-Cookie` lo consuma lui e al browser non arriva
 * mai: li' l'identificativo sta in un cookie first-party sul dominio del
 * negozio, che non e' nostro e che noi non possiamo toccare. In quel caso a
 * toglierlo e' il ponte in vetrina, che sta dalla parte giusta del confine.
 * Quello che possiamo garantire da qui, in tutti e due i casi, e' che non se ne
 * conii un altro e che quello che c'era sparisca dal database.
 */
export function expiredExternalIdCookie(): string {
  return [
    `${EXTERNAL_ID_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'SameSite=None',
    'Secure',
  ].join('; ');
}

/** Legge l'identificativo da un'intestazione Cookie, se ce n'e' uno valido. */
export function readExternalId(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== EXTERNAL_ID_COOKIE) continue;
    const value = rest.join('=');
    // Un valore malformato vale come assente: si riparte con uno buono invece
    // di trascinarsi dietro qualcosa che nessuna query sapra' incrociare.
    return isExternalId(value) ? value : null;
  }

  return null;
}
