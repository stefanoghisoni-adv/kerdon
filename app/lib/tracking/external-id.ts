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
