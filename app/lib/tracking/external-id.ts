/**
 * L'identificativo che segue un browser nel tempo.
 *
 * Serve a una cosa sola: legare fra loro gli eventi di una stessa persona anche
 * prima che si sia identificata, e poi ricollegarli al cliente quando compra.
 * Senza, ogni visita e' una persona nuova e il profitto per cliente non si puo'
 * costruire.
 *
 * Il formato e' `corew_<32 caratteri casuali>`. Due parti, e bastano:
 *
 *  - il prefisso lo rende riconoscibile fra i cookie di un negozio, dove ce ne
 *    sono decine di terzi diversi;
 *  - i 32 caratteri casuali sono cio' che lo rende unico, e non dicono niente
 *    altro.
 *
 * PRIMA C'ERANO ANCHE I MILLISECONDI, e sono stati tolti. Dicevano quando quel
 * browser era stato visto la prima volta — un'informazione vera e comoda, che
 * pero' e' gia' scritta in `first_seen_at`, dove il merchant la controlla e
 * puo' cancellarla. Dentro l'identificativo invece viaggiava ovunque
 * l'identificativo andasse: nel cookie, nelle richieste, in qualunque sistema a
 * valle, leggibile da chiunque lo vedesse passare, e non c'era modo di
 * toglierla senza cambiare l'identificativo. Un identificativo deve identificare
 * e nient'altro.
 *
 * GLI IDENTIFICATIVI VECCHI RESTANO VALIDI. Sono nei browser delle persone e
 * nelle righe gia' scritte: rifiutarli vorrebbe dire coniarne uno nuovo a
 * chiunque torni, cioe' perdere esattamente cio' per cui esistono. Si accettano
 * tutti e due i formati; se ne conia uno solo.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Quanti caratteri casuali. 62^32 e' abbastanza da non doverci pensare. */
export const RANDOM_LENGTH = 32;

export const EXTERNAL_ID_PREFIX = 'kerdon';

/**
 * Riconosce un identificativo nostro, e ben formato.
 *
 * Tre forme, e si accettano tutte e tre per la stessa ragione per cui si
 * accettava la seconda: sono nei browser delle persone e nelle righe gia'
 * scritte, e rifiutarle vorrebbe dire coniare un identificativo nuovo a
 * chiunque torni — cioe' perdere esattamente cio' per cui esistono.
 *
 * Quella corrente (`kerdon_` piu' 32 caratteri), e le due che portano il nome
 * di prima del cambio: `corew_` piu' 32 caratteri, e `corew_` con i
 * millisecondi del conio in mezzo.
 */
export const EXTERNAL_ID_PATTERN = /^(?:kerdon|corew)_(?:\d+_)?[A-Za-z0-9]{32}$/;

/** La forma vecchia, quella con il momento di conio scritto dentro. */
export const LEGACY_EXTERNAL_ID_PATTERN = /^(?:kerdon|corew)_\d+_[A-Za-z0-9]{32}$/;

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
export function newExternalId(): string {
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

  return `${EXTERNAL_ID_PREFIX}_${out}`;
}

/** Il nome del cookie. */
export const EXTERNAL_ID_COOKIE = 'kerdon_eid';

/**
 * IL TRASPORTO, dichiarato una volta sola perche' finora non lo era.
 *
 * Questa app parla con UN SOLO interlocutore: un endpoint first-party del
 * negozio — un container server-side su un sottodominio del negozio, un worker
 * di CDN, il backend del merchant. Non parla con il browser, e non ci prova.
 *
 * Il perche' non e' una preferenza. Un cookie `SameSite=None; Secure` emesso
 * dal nostro dominio e' di terze parti: Safari lo cancella dopo sette giorni
 * quando lo accetta, e spesso non lo accetta; Firefox lo isola per sito. Un
 * identificativo che deve durare un anno non puo' vivere li'. Vive invece nel
 * cookie first-party che l'endpoint del negozio pianta sul PROPRIO dominio,
 * dove nessun browser lo tratta da estraneo — ed e' l'endpoint del negozio a
 * emetterlo, non noi, perche' quel dominio e' suo.
 *
 * Il nostro compito diventa allora piu' piccolo e piu' preciso: ricevere il
 * valore che quel browser ha gia', dirlo se e' buono, coniarne uno nuovo solo
 * se non c'e'. L'header di risposta e' come lo diciamo.
 *
 * Il giro completo, e cosa deve fare il container, stanno in
 * docs/tracking-integration.md.
 *
 * PERCHE' NON DAL BROWSER. Il progetto non ha, e non deve avere, nessun
 * `Access-Control-Allow-Origin` ne' un gestore di `OPTIONS`: una chiamata
 * diretta dalla vetrina fallirebbe comunque il controllo preliminare. E
 * dovrebbe portarsi dietro il token di lettura del negozio, che finirebbe
 * scritto in chiaro nel codice di ogni pagina, leggibile da chiunque apra gli
 * strumenti di sviluppo. Il token vive dove deve vivere: nella pagina di
 * impostazioni dell'app, dietro sessione amministratore, da dove il merchant
 * lo copia dentro il proprio container.
 */
export const EXTERNAL_ID_HEADER = 'X-CoreW-External-Id';

/**
 * Come il container ci rimanda il valore che il browser ha gia'.
 *
 * E' lo stesso nome dell'header di risposta, usato nell'altro verso, e sono
 * due meta' dello stesso scambio: noi lo diciamo, il container lo pianta come
 * cookie sul dominio del negozio, e alla visita dopo ce lo rimanda cosi'.
 *
 * Prima questo non c'era, e l'unico posto da cui l'identificativo si leggeva
 * era l'intestazione `Cookie` della richiesta. Ma in una chiamata fatta da un
 * container quell'intestazione e' del container, non del visitatore: era
 * sempre vuota, e quindi si coniava un identificativo nuovo a ogni visita. Il
 * database si riempiva di righe che erano tutte la stessa persona, e nessuna
 * di loro la riconosceva.
 */
export const EXISTING_EXTERNAL_ID_PARAM = 'existing_external_id';

/**
 * Un anno di vita richiesta, che e' una richiesta e non una garanzia.
 *
 * `Max-Age` dice al browser per quanto ci piacerebbe che quel cookie restasse.
 * Il browser fa quel che vuole: puo' accorciarlo per politica — Safari lo fa —
 * puo' cancellarlo con la cronologia, puo' non accettarlo affatto. Prometterlo
 * come una durata certa e' il modo in cui un giorno qualcuno si accorge che i
 * numeri non tornano e non capisce perche'. La durata vera la ottiene il
 * cookie first-party dell'endpoint del negozio, non questo.
 */
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

/**
 * L'identificativo che il chiamante gia' possiede, se ne possiede uno.
 *
 * Tre posti, in quest'ordine, e l'ordine e' la parte che conta:
 *
 *  1. l'header `X-CoreW-External-Id` della richiesta. E' la via normale: il
 *     container server-side rimanda il valore letto dal cookie first-party del
 *     negozio;
 *  2. il parametro di query `existing_external_id`. Serve dove l'header non si
 *     puo' aggiungere — certi template di tag non lo permettono, e chi li usa
 *     non li puo' modificare;
 *  3. l'intestazione `Cookie`. Ha senso solo se a chiamare e' davvero un
 *     browser, cosa che questa app non incoraggia ma che non ha motivo di
 *     rompere.
 *
 * Il corpo della richiesta non e' fra questi posti perche' entrambe le rotte
 * che leggono l'identificativo sono letture: non hanno un corpo da guardare.
 *
 * Un valore malformato vale come assente: se ne conia uno buono invece di
 * trascinarsi dietro qualcosa che nessuna query sapra' incrociare. E' anche la
 * difesa contro chi provasse a farsi assegnare un identificativo scelto da lui.
 */
export function incomingExternalId(request: Request): string | null {
  const forwarded = request.headers.get(EXTERNAL_ID_HEADER);
  if (isExternalId(forwarded)) return forwarded;

  const fromQuery = new URL(request.url).searchParams.get(EXISTING_EXTERNAL_ID_PARAM);
  if (isExternalId(fromQuery)) return fromQuery;

  return readExternalId(request.headers.get('Cookie'));
}
