// e2e/server/fakes/rete.ts
//
// La rete del server di prova: chi `fetch` chiama, quando l'indirizzo e' di
// qualcun altro.
//
// PERCHE' DAVANTI A `fetch` E NON AL POSTO DEI MODULI. L'import da Klaviyo
// passa da tre servizi esterni — Klaviyo, l'Admin API di Shopify e il database
// Supabase del merchant — e in tutti e tre i casi il codice dell'app che li
// chiama (i tentativi, la paginazione, la classificazione degli errori, il
// client Supabase vero) e' proprio cio' che va provato. Sostituire i moduli
// avrebbe provato il sostituto. Qui cambia solo cosa risponde dall'altra parte.
//
// Gli indirizzi deviati sono pochi e scritti qui sotto; tutto il resto passa
// com'era, cosi' le prove che non sanno niente di Klaviyo non cambiano.

import { rispondiKlaviyo } from './klaviyo.server';
import { rispostaGraphQL } from './shopify.server';
import { stato } from './state';

/** L'host del progetto Supabase del merchant nelle prove. Inventato: non risolve. */
export const HOST_DATABASE_MERCHANT = 'merchant-finto.supabase.co';

type Riga = Record<string, unknown>;

function confronta(a: unknown, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a).localeCompare(b);
}

/**
 * Il minimo di PostgREST che le letture dell'app usano: `select`, i filtri
 * `eq`, `gt`, `in` e `is`, `order` e `limit`. Un operatore che non conosce lo
 * rifiuta con un 400, invece di ignorarlo e restituire righe che il filtro
 * vero avrebbe scartato.
 */
function postgrest(request: Request, url: URL): Response {
  const m = /^\/rest\/v1\/([^/]+)$/.exec(url.pathname);
  if (!m || request.method !== 'GET') {
    return Response.json({ message: `non previsto dal finto: ${request.method} ${url.pathname}` }, { status: 400 });
  }
  let righe: Riga[] = [...(stato().databaseMerchant[decodeURIComponent(m[1])] ?? [])];
  let ordine: { col: string; asc: boolean }[] = [];
  let limite: number | null = null;
  let colonne: string[] | null = null;

  for (const [chiave, valore] of url.searchParams) {
    if (chiave === 'select') {
      colonne = valore === '*' ? null : valore.split(',').map((c) => c.trim());
      continue;
    }
    if (chiave === 'order') {
      ordine = valore.split(',').map((o) => {
        const [col, dir] = o.split('.');
        return { col, asc: dir !== 'desc' };
      });
      continue;
    }
    if (chiave === 'limit') {
      limite = Number(valore);
      continue;
    }
    const punto = valore.indexOf('.');
    const op = valore.slice(0, punto);
    const arg = valore.slice(punto + 1);
    if (op === 'eq') righe = righe.filter((r) => String(r[chiave]) === arg);
    else if (op === 'gt') righe = righe.filter((r) => r[chiave] != null && confronta(r[chiave], arg) > 0);
    else if (op === 'in') {
      const ammessi = new Set(arg.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, '')));
      righe = righe.filter((r) => ammessi.has(String(r[chiave])));
    } else if (op === 'is' && arg === 'null') righe = righe.filter((r) => r[chiave] == null);
    else {
      return Response.json({ message: `operatore non previsto dal finto: ${chiave}=${valore}` }, { status: 400 });
    }
  }

  for (const { col, asc } of [...ordine].reverse()) {
    righe.sort((a, b) => (asc ? 1 : -1) * confronta(a[col], String(b[col])));
  }
  if (limite !== null) righe = righe.slice(0, limite);
  const proiettate = colonne
    ? righe.map((r) => Object.fromEntries(colonne!.map((c) => [c, r[c] ?? null])))
    : righe;

  return new Response(JSON.stringify(proiettate), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Range': `0-${Math.max(proiettate.length - 1, 0)}/*`,
    },
  });
}

/** L'Admin GraphQL di Shopify chiamato via HTTP, come fa `ShopifyAPIClient`. */
async function adminShopify(request: Request): Promise<Response> {
  const corpo = (await request.json()) as { query: string; variables?: unknown };
  stato().adminLog.push({ query: corpo.query, variables: corpo.variables ?? null });
  return rispostaGraphQL(corpo.query);
}

/**
 * Mette il finto davanti a `fetch`. Va chiamata una volta, prima di caricare i
 * moduli dell'app.
 *
 * `/api/cron/sync` sul server stesso risponde 202 senza fare niente: e' la
 * sveglia che `triggerSyncDrain` manda dopo un'importazione accodata. Nelle
 * prove la coda la drena la prova, con `/__test/drain`, quando lo dice lei:
 * un drenaggio partito da solo a meta' prova la renderebbe una corsa.
 */
export function installaRete(base: string): void {
  const originale = globalThis.fetch.bind(globalThis);
  const proprio = new URL(base);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);

    if (url.hostname === 'www.klaviyo.com' || url.hostname === 'a.klaviyo.com') {
      return rispondiKlaviyo(request, url);
    }
    if (url.hostname.endsWith('.myshopify.com') && /^\/admin\/api\/[^/]+\/graphql\.json$/.test(url.pathname)) {
      return adminShopify(request);
    }
    if (url.hostname === HOST_DATABASE_MERCHANT) {
      return postgrest(request, url);
    }
    if (url.host === proprio.host && url.pathname === '/api/cron/sync') {
      return new Response(null, { status: 202 });
    }
    return originale(input as RequestInfo, init);
  }) as typeof fetch;
}
