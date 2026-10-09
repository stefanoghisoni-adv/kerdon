// e2e/server/fakes/klaviyo.server.ts
//
// Klaviyo, finto e sotto controllo: la pagina di autorizzazione, l'endpoint dei
// gettoni, l'account e i profili. Le altre rotte dell'API non esistono qui, e
// chi le chiamasse riceverebbe un 404 — che e' il punto: l'app ne usa quattro.
//
// COME CI SI ARRIVA. Il codice dell'app resta quello vero, con i suoi
// indirizzi veri (`https://www.klaviyo.com/oauth/authorize`,
// `https://a.klaviyo.com/...`). Dal server le chiamate le devia `rete.ts`,
// che si mette davanti a `fetch`; dal browser la deviazione la fa la prova,
// con `context.route`, verso `/__fake/klaviyo/...` su questo stesso server.
// Niente variabili d'ambiente che spostino l'indirizzo di Klaviyo: una
// variabile cosi' esisterebbe anche in produzione.
//
// COSA VERIFICA, PERCHE' UN FINTO CHE DICE SEMPRE SI' NON PROVA NIENTE.
//  - L'autorizzazione vuole il client id di prova, il redirect registrato, la
//    risposta `code`, gli scope di sola lettura e una challenge PKCE S256.
//  - Lo scambio vuole le credenziali del client in Basic, il codice emesso, lo
//    stesso redirect e un verifier che corrisponda alla challenge: e' la prova
//    che il verifier viaggia cifrato nello `state` e torna intero.
//  - L'API vuole un gettone emesso qui e la revisione su cui il connettore e'
//    scritto.
//
// E REGISTRA OGNI RICHIESTA, metodo e percorso: e' cosi' che la prova dice che
// verso Klaviyo non e' partita nessuna scrittura.

import { createHash, randomBytes } from 'node:crypto';
import { stato } from './state';

const REVISIONE = '2026-07-15';
const SCOPE_ATTESI = 'profiles:read accounts:read';

function json(dati: unknown, status = 200): Response {
  return new Response(JSON.stringify(dati), {
    status,
    headers: { 'Content-Type': 'application/vnd.api+json' },
  });
}

function errore(status: number, codice: string): Response {
  return json({ errors: [{ status: String(status), code: codice }] }, status);
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** La pagina dove il merchant direbbe "consenti". Qui consente da sola, se la richiesta e' in regola. */
function autorizza(url: URL): Response {
  const p = url.searchParams;
  const redirect = p.get('redirect_uri') ?? '';
  const attesoRedirect = `${process.env.SHOPIFY_APP_URL}/auth/klaviyo/callback`;

  const sbagliato =
    p.get('response_type') !== 'code'
      ? 'response_type'
      : p.get('client_id') !== process.env.KLAVIYO_CLIENT_ID
        ? 'client_id'
        : redirect !== attesoRedirect
          ? 'redirect_uri'
          : p.get('scope') !== SCOPE_ATTESI
            ? 'scope'
            : p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')
              ? 'pkce'
              : !p.get('state')
                ? 'state'
                : null;
  if (sbagliato) {
    return new Response(`autorizzazione rifiutata dal finto: ${sbagliato}`, { status: 400 });
  }

  const codice = base64url(randomBytes(16));
  stato().klaviyo.codici[codice] = { challenge: p.get('code_challenge')!, redirectUri: redirect };

  const ritorno = new URL(redirect);
  ritorno.searchParams.set('code', codice);
  ritorno.searchParams.set('state', p.get('state')!);
  return new Response(null, { status: 302, headers: { Location: ritorno.toString() } });
}

async function gettone(request: Request): Promise<Response> {
  const atteso = `Basic ${Buffer.from(
    `${process.env.KLAVIYO_CLIENT_ID}:${process.env.KLAVIYO_CLIENT_SECRET}`,
  ).toString('base64')}`;
  if (request.headers.get('authorization') !== atteso) return errore(401, 'invalid_client');

  const corpo = new URLSearchParams(await request.text());
  const k = stato().klaviyo;

  if (corpo.get('grant_type') === 'authorization_code') {
    const codice = corpo.get('code') ?? '';
    const emesso = k.codici[codice];
    // Un codice vale una volta: lo si toglie prima di guardare il resto.
    delete k.codici[codice];
    if (!emesso) return errore(400, 'invalid_grant');
    if (corpo.get('redirect_uri') !== emesso.redirectUri) return errore(400, 'invalid_grant');
    const challenge = base64url(createHash('sha256').update(corpo.get('code_verifier') ?? '').digest());
    if (challenge !== emesso.challenge) return errore(400, 'invalid_grant');
  } else if (corpo.get('grant_type') === 'refresh_token') {
    if (!corpo.get('refresh_token')) return errore(400, 'invalid_grant');
  } else {
    return errore(400, 'unsupported_grant_type');
  }

  const accessToken = `klaviyo-accesso-${base64url(randomBytes(12))}`;
  k.gettoni.push(accessToken);
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: `klaviyo-rinnovo-${base64url(randomBytes(12))}`,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: SCOPE_ATTESI,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function profili(url: URL): Response {
  const k = stato().klaviyo;
  const chiesta = Number(url.searchParams.get('page[size]') ?? 20);
  const dimensione = Math.max(1, Math.min(chiesta, k.dimensionePagina));
  const da = Number(url.searchParams.get('page[cursor]') ?? 0) || 0;
  const pagina = k.profili.slice(da, da + dimensione);

  const seguito = da + dimensione < k.profili.length;
  // `links.next` e' l'indirizzo completo, su a.klaviyo.com, come lo scrive
  // Klaviyo: l'app lo controlla prima di mandarci il gettone.
  const next = seguito
    ? `https://a.klaviyo.com/api/profiles?${new URLSearchParams({
        'page[size]': String(chiesta),
        'page[cursor]': String(da + dimensione),
      }).toString()}`
    : null;

  return json({
    data: pagina.map((p) => ({ type: 'profile', ...p })),
    links: { self: url.toString(), next, prev: null },
  });
}

/**
 * Risponde a una richiesta destinata a Klaviyo. `url` e' l'indirizzo VERO
 * (`www.klaviyo.com` o `a.klaviyo.com`), anche quando la richiesta e' arrivata
 * deviata su `/__fake/klaviyo/...`.
 */
export async function rispondiKlaviyo(request: Request, url: URL): Promise<Response> {
  const k = stato().klaviyo;
  k.richieste.push(`${request.method} ${url.hostname}${url.pathname}`);

  if (url.hostname === 'www.klaviyo.com' && url.pathname === '/oauth/authorize' && request.method === 'GET') {
    return autorizza(url);
  }

  if (url.hostname !== 'a.klaviyo.com') return errore(404, 'not_found');

  if (url.pathname === '/oauth/token' && request.method === 'POST') return gettone(request);
  if (url.pathname === '/oauth/revoke' && request.method === 'POST') {
    return new Response(null, { status: 200 });
  }

  if (url.pathname.startsWith('/api/')) {
    const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!k.gettoni.includes(bearer)) return errore(401, 'not_authenticated');
    if (request.headers.get('revision') !== REVISIONE) return errore(400, 'invalid_revision');
    if (request.method !== 'GET') return errore(405, 'method_not_allowed');

    if (url.pathname === '/api/accounts') {
      return json({
        data: [
          {
            type: 'account',
            id: 'ACCOUNTFINTO',
            attributes: { contact_information: { organization_name: k.nomeAccount } },
          },
        ],
      });
    }
    if (url.pathname === '/api/profiles') return profili(url);
  }

  return errore(404, 'not_found');
}

/** L'indirizzo vero di una richiesta deviata su `/__fake/klaviyo/<host>/<percorso>`. */
export function indirizzoVeroKlaviyo(deviato: URL): URL | null {
  const m = /^\/__fake\/klaviyo\/(www\.klaviyo\.com|a\.klaviyo\.com)(\/.*)$/.exec(deviato.pathname);
  if (!m) return null;
  return new URL(`https://${m[1]}${m[2]}${deviato.search}`);
}
