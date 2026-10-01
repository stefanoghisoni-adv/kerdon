import https from 'node:https';
import dns from 'node:dns';
import { Readable } from 'node:stream';
import type { LookupFunction } from 'node:net';
import { isGlobalAddress, isIpLiteral } from './ip-address';

/**
 * L'unico modo in cui il nostro server chiama un indirizzo scelto da altri.
 *
 * PERCHE' UNA FUNZIONE SOLA. Ogni volta che il server chiama un indirizzo che
 * ha scritto qualcun altro — un merchant, un rimando di un suo server — sta
 * prestando la propria posizione in rete: puo' arrivare dove da fuori non si
 * arriva, al servizio dei metadati del cloud, ai servizi interni, a se' stesso.
 * Le regole per non farlo sono poche ma vanno rispettate tutte insieme, e la
 * volta che qualcuno ne riscrive una parte a mano e' quella in cui se ne
 * dimentica una. Qui stanno tutte, e chi ha bisogno di chiamare fuori chiama
 * questa.
 *
 * LE REGOLE:
 *  - solo https, solo porta 443, niente nome utente o password nell'indirizzo;
 *  - il nome si risolve (A e AAAA) e TUTTI gli indirizzi devono essere globali:
 *    con un record pubblico e uno privato, quale usare lo deciderebbe chi ha
 *    scritto i record;
 *  - la connessione va all'indirizzo appena verificato, non a una seconda
 *    risoluzione: fra il controllo e la chiamata il DNS puo' cambiare risposta
 *    (e un DNS ostile lo fa apposta), e il controllo varrebbe per un indirizzo
 *    che poi non si usa. Il nome resta nell'header Host e nel saluto TLS, cosi'
 *    il certificato si verifica sul nome come sempre;
 *  - i rimandi non li segue la libreria: si seguono qui, uno per uno, e ognuno
 *    ripassa tutte le regole come se fosse il primo indirizzo;
 *  - un tetto al tempo complessivo, ai byte letti e al numero di risposte: un
 *    server lento o enorme non deve tenere occupata una funzione per minuti.
 */

export type SafeFetchErrorCode =
  | 'invalid_url'
  | 'not_https'
  | 'bad_port'
  | 'userinfo'
  | 'dns_failed'
  | 'blocked_address'
  | 'too_many_redirects'
  | 'too_large'
  | 'timeout'
  | 'network';

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    options?: { cause?: unknown },
  ) {
    super(`safe fetch refused: ${code}`, options);
    this.name = 'SafeFetchError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface TransportRequest {
  /** L'indirizzo con il nome: e' il nome che va nell'Host e nel TLS. */
  url: URL;
  /** L'IP gia' verificato: e' qui, e solo qui, che ci si collega. */
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export type Transport = (request: TransportRequest) => Promise<Response>;

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  /**
   * Quanti rimandi seguire. `0` vuol dire non seguirli: il 3xx torna a chi
   * chiama com'e', che decide lui cosa farne. Oltre il numero, errore.
   */
  maxRedirects?: number;
  /** Il tetto ai byte del corpo: oltre, la lettura si interrompe. */
  maxBytes?: number;
  /** Il tempo massimo per tutto: DNS, connessione, rimandi e corpo. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Iniettabili per i test; in esercizio sono il DNS e https di Node. */
  resolve?: Resolver;
  transport?: Transport;
}

const DEFAULT_MAX_REDIRECTS = 3;
const USER_AGENT = 'Kerdon/1.0 (+https://kerdon.io)';
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Le risposte che per definizione non hanno corpo: `Response` rifiuta di dargliene uno. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
/** Cio' che non deve seguire un rimando verso un altro host. */
const CREDENTIAL_HEADERS = new Set(['cookie', 'authorization', 'proxy-authorization']);

/** Il problema dell'indirizzo in se', prima di qualsiasi risoluzione. */
export function urlProblem(url: URL): 'not_https' | 'bad_port' | 'userinfo' | null {
  if (url.protocol !== 'https:') return 'not_https';
  // `URL` toglie da solo la porta di default: vuota vuol dire 443.
  if (url.port !== '') return 'bad_port';
  if (url.username !== '' || url.password !== '') return 'userinfo';
  return null;
}

/** La risoluzione di default: quella del sistema, tutti gli indirizzi, A e AAAA. */
export const systemResolver: Resolver = async (hostname) => {
  const found = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return found.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

/**
 * Un `lookup` che non chiede niente a nessuno: risponde con l'indirizzo gia'
 * verificato, qualunque nome gli si passi.
 *
 * E' cio' che chiude la porta al rebinding: Node, collegandosi, chiede a questa
 * funzione dove andare invece che al DNS. Risponde nelle due forme che Node usa
 * — un indirizzo solo, o la lista quando chiede `all` per provare le famiglie in
 * parallelo — sempre con lo stesso valore.
 */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((_hostname: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
    if (all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }) as LookupFunction;
}

/**
 * Il trasporto vero: https di Node, collegato all'IP verificato.
 *
 * `agent: false` perche' una connessione riusata da un pool potrebbe essere
 * stata aperta verso un altro indirizzo per lo stesso nome; qui ogni chiamata
 * apre la sua, verso l'IP che le e' stato dato.
 */
export const httpsTransport: Transport = ({ url, address, family, headers, signal }) =>
  new Promise<Response>((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const req = https.request(
      {
        host,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        lookup: pinnedLookup(address, family),
        agent: false,
        signal,
      },
      (res) => {
        const out = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
        }
        const status = res.statusCode ?? 0;
        try {
          const body = NULL_BODY_STATUSES.has(status)
            ? null
            : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
          if (body === null) res.resume();
          resolve(new Response(body, { status, headers: out }));
        } catch (err) {
          res.destroy();
          reject(err);
        }
      },
    );
    req.on('error', reject);
    req.end();
  });

/** Una promessa che si arrende quando scade il tempo, anche se chi la tiene non ascolta. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Gli IP a cui ci si puo' collegare per questo host, tutti verificati. */
async function addressesFor(
  url: URL,
  resolve: Resolver,
  signal: AbortSignal,
): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, '');

  // Un IP scritto nell'indirizzo non si risolve: si giudica e basta.
  if (isIpLiteral(host)) {
    if (!isGlobalAddress(host)) throw new SafeFetchError('blocked_address');
    return { address: host, family: host.includes(':') ? 6 : 4 };
  }

  let found: ResolvedAddress[];
  try {
    found = await untilAborted(resolve(host), signal);
  } catch (err) {
    if (signal.aborted) throw err;
    throw new SafeFetchError('dns_failed', { cause: err });
  }
  if (found.length === 0) throw new SafeFetchError('dns_failed');
  if (!found.every(({ address }) => isGlobalAddress(address))) {
    throw new SafeFetchError('blocked_address');
  }
  return found[0];
}

/** Il corpo, letto fino al tetto e non un byte di piu'. */
async function readCapped(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new SafeFetchError('too_large');
      chunks.push(value);
    }
  } catch (err) {
    // Si chiude lo stream invece di lasciarlo a meta': la connessione si libera
    // subito, e il server dall'altra parte smette di mandare.
    reader.cancel().catch(() => {});
    throw err;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export async function safeFetch(input: string, options: SafeFetchOptions = {}): Promise<Response> {
  const {
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    resolve = systemResolver,
    transport = httpsTransport,
  } = options;

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SafeFetchError('invalid_url');
  }
  let headers = { ...(options.headers ?? {}) };
  // Un nome riconoscibile: alcune protezioni davanti ai siti rifiutano le
  // richieste senza, e il merchant che guarda i log capisce chi ha bussato.
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = USER_AGENT;
  }

  try {
    // Le risposte sono al massimo i rimandi permessi piu' quella finale.
    for (let hop = 0; ; hop++) {
      const problem = urlProblem(url);
      if (problem) throw new SafeFetchError(problem);

      const { address, family } = await addressesFor(url, resolve, signal);

      let response: Response;
      try {
        response = await untilAborted(transport({ url, address, family, headers, signal }), signal);
      } catch (err) {
        if (signal.aborted || err instanceof SafeFetchError) throw err;
        throw new SafeFetchError('network', { cause: err });
      }

      const location = response.headers.get('location');
      const isRedirect = REDIRECT_STATUSES.has(response.status) && location !== null;

      if (isRedirect && maxRedirects > 0) {
        response.body?.cancel().catch(() => {});
        if (hop >= maxRedirects) throw new SafeFetchError('too_many_redirects');

        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new SafeFetchError('invalid_url');
        }
        if (next.host !== url.host) {
          headers = Object.fromEntries(
            Object.entries(headers).filter(([k]) => !CREDENTIAL_HEADERS.has(k.toLowerCase())),
          );
        }
        url = next;
        continue;
      }

      const body = await readCapped(response, maxBytes, signal);
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    if (signal.aborted) throw new SafeFetchError('timeout', { cause: err });
    throw new SafeFetchError('network', { cause: err });
  }
}
