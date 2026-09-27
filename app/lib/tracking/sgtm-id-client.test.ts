import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Il Client sGTM, eseguito per intero.
//
// `ingest-guard.test.ts` estrae ed esegue gia' la parte fra INVIO:INIZIO e
// INVIO:FINE. Qui si esegue TUTTO `___SANDBOXED_JS_FOR_SERVER___`, con finti
// delle API del sandbox che il template richiede — e solo quelle: un `require`
// di un'API che il finto non conosce fa fallire la prova, come farebbe il
// sandbox con un permesso mancante.
//
// Le API finte seguono la documentazione di Google: `sendHttpGet` risolve con
// `{statusCode, headers, body}` e rifiuta con `{reason: 'failed'}` o
// `{reason: 'timed_out'}`; `JSON.parse` su un testo malformato restituisce
// `undefined` invece di sollevare.
//
// La regola che conta di piu': un Client che non chiama `returnResponse` lascia
// la vetrina appesa fino al timeout del container. Ogni ramo deve rispondere,
// e una volta sola.
//
// COSA NON DICE: che il sandbox vero esegua questo codice identico. Quello
// resta da provare in anteprima (passi manuali nelle NOTE del template).

const TEMPLATE = readFileSync(
  resolve(__dirname, '../../../integrations/sgtm/kerdon-id-client.tpl'),
  'utf8',
);

function sezione(nome: string): string {
  const apertura = `___${nome}___`;
  const inizio = TEMPLATE.indexOf(apertura);
  if (inizio < 0) throw new Error(`manca la sezione ${nome}`);
  const resto = TEMPLATE.slice(inizio + apertura.length);
  const fine = resto.search(/\n___[A-Z_]+___/);
  return (fine < 0 ? resto : resto.slice(0, fine)).trim();
}

const CODICE = sezione('SANDBOXED_JS_FOR_SERVER');
const PERMESSI = JSON.parse(sezione('SERVER_PERMISSIONS')) as Array<{
  instance: {
    key: { publicId: string };
    param?: Array<{ key: string; value: { listItem?: Array<{ string?: string }> } }>;
  };
}>;

const VECCHIO = 'kerdon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NUOVO = 'kerdon_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

type Upstream =
  | { statusCode: number; headers?: Record<string, string>; body?: string }
  | { reject: 'failed' | 'timed_out' };

interface Richiesta {
  query?: Record<string, string>;
  cookies?: Record<string, string>;
  upstream?: Upstream;
}

async function esegui(r: Richiesta) {
  const esito = {
    status: 0,
    body: '',
    headers: {} as Record<string, string>,
    cookies: [] as { name: string; value: string; maxAge: unknown }[],
    returned: 0,
    upstreamCalls: [] as string[],
  };
  let pendente: Promise<unknown> = Promise.resolve();

  const api: Record<string, unknown> = {
    claimRequest: () => {},
    getRequestPath: () => '/kerdon/id',
    getRequestQueryParameter: (k: string) => r.query?.[k],
    getRequestHeader: (k: string) => (k === 'origin' ? 'https://www.negozio.it' : undefined),
    getCookieValues: (k: string) => (r.cookies?.[k] ? [r.cookies[k]] : []),
    setCookie: (name: string, value: string, opts: Record<string, unknown>) =>
      esito.cookies.push({ name, value, maxAge: opts['max-age'] }),
    setResponseBody: (b: string) => (esito.body = b),
    setResponseHeader: (k: string, v: string) => (esito.headers[k.toLowerCase()] = v),
    setResponseStatus: (s: number) => (esito.status = s),
    returnResponse: () => (esito.returned += 1),
    sendHttpGet: (url: string) => {
      esito.upstreamCalls.push(url);
      const u = r.upstream ?? { statusCode: 200, body: '[]' };
      const p =
        'reject' in u
          ? Promise.reject({ reason: u.reject })
          : Promise.resolve({ statusCode: u.statusCode, headers: u.headers ?? {}, body: u.body ?? '' });
      pendente = p.catch(() => {});
      return p;
    },
    encodeUriComponent: encodeURIComponent,
    JSON: {
      parse: (s: unknown) => {
        try {
          return JSON.parse(String(s));
        } catch {
          return undefined;
        }
      },
      stringify: JSON.stringify,
    },
    logToConsole: () => {},
  };

  const richiesti: string[] = [];
  const require = (nome: string) => {
    richiesti.push(nome);
    if (!(nome in api)) throw new Error(`API del sandbox non prevista: ${nome}`);
    return api[nome];
  };

  const data = {
    requestPath: '/kerdon/id',
    kerdonUrl: 'https://api.kerdon.io',
    ingestKey: 'kin_prova.segreto',
    storefrontDomain: 'negozio.it',
    cookieMaxAge: '31536000',
  };

  new Function('require', 'data', CODICE)(require, data);
  await pendente;
  for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0));
  return { ...esito, richiesti };
}

const REVOCA = { consent: 'v1.a0.m0', existing_external_id: VECCHIO };
const PERMESSO = { consent: 'v1.a1.m1' };

describe('il Client sGTM: ogni ramo risponde, una volta sola', () => {
  describe('alla revoca', () => {
    it('upstream 200: 200, cookie scaduto', async () => {
      const e = await esegui({ query: REVOCA, upstream: { statusCode: 200, body: '[]' } });
      expect(e.returned).toBe(1);
      expect(e.status).toBe(200);
      expect(e.body).toBe('[]');
      expect(e.cookies).toEqual([{ name: 'kerdon_eid', value: '', maxAge: 0 }]);
    });

    it('rete giu: 503 con Retry-After leggibile dalla vetrina', async () => {
      const e = await esegui({ query: REVOCA, upstream: { reject: 'failed' } });
      expect(e.returned).toBe(1);
      expect(e.status).toBe(503);
      expect(e.headers['retry-after']).toMatch(/^\d+$/);
      expect(e.headers['access-control-expose-headers']).toMatch(/retry-after/i);
      // Il cookie scade comunque: il tracciamento cessa nell'istante del no.
      expect(e.cookies).toEqual([{ name: 'kerdon_eid', value: '', maxAge: 0 }]);
    });

    it('timeout: 503', async () => {
      const e = await esegui({ query: REVOCA, upstream: { reject: 'timed_out' } });
      expect(e.returned).toBe(1);
      expect(e.status).toBe(503);
    });

    it('upstream 503 con Retry-After: lo si inoltra', async () => {
      const e = await esegui({
        query: REVOCA,
        upstream: { statusCode: 503, headers: { 'retry-after': '120' }, body: '{"error":"x"}' },
      });
      expect(e.returned).toBe(1);
      expect(e.status).toBe(503);
      expect(e.headers['retry-after']).toBe('120');
    });

    it('upstream 500 o 429: 503, mai un ok', async () => {
      for (const statusCode of [500, 429, 401]) {
        const e = await esegui({ query: REVOCA, upstream: { statusCode, body: 'non json' } });
        expect(e.returned).toBe(1);
        expect(e.status).toBe(503);
      }
    });

    it('un Retry-After malformato non passa', async () => {
      const e = await esegui({
        query: REVOCA,
        upstream: { statusCode: 503, headers: { 'retry-after': '1; rm -rf' } },
      });
      expect(e.headers['retry-after']).toMatch(/^\d+$/);
    });

    it('senza identificativo non si chiama nessuno, e si risponde', async () => {
      const e = await esegui({ query: { consent: 'v1.a0.m0' } });
      expect(e.upstreamCalls).toHaveLength(0);
      expect(e.returned).toBe(1);
      expect(e.status).toBe(200);
    });
  });

  describe('con il permesso', () => {
    it('upstream 200 con l identificativo: cookie e corpo', async () => {
      const e = await esegui({
        query: PERMESSO,
        upstream: { statusCode: 200, body: JSON.stringify([{ external_id: NUOVO }]) },
      });
      expect(e.returned).toBe(1);
      expect(e.status).toBe(200);
      expect(JSON.parse(e.body)).toEqual([{ external_id: NUOVO }]);
      expect(e.cookies[0]).toMatchObject({ name: 'kerdon_eid', value: NUOVO });
    });

    it('rete giu o timeout: si risponde vuoto, nessun cookie', async () => {
      for (const reject of ['failed', 'timed_out'] as const) {
        const e = await esegui({ query: PERMESSO, upstream: { reject } });
        expect(e.returned).toBe(1);
        expect(e.body).toBe('[]');
        expect(e.cookies).toHaveLength(0);
      }
    });

    it('upstream non-2xx: nessun identificativo, anche se il corpo ne contiene uno', async () => {
      const e = await esegui({
        query: PERMESSO,
        upstream: {
          statusCode: 500,
          headers: { 'x-kerdon-external-id': NUOVO },
          body: JSON.stringify([{ external_id: NUOVO }]),
        },
      });
      expect(e.returned).toBe(1);
      expect(e.body).toBe('[]');
      expect(e.cookies).toHaveLength(0);
    });

    it('corpo malformato: si risponde vuoto', async () => {
      for (const body of ['{non json', '', 'null', '42', '[null]']) {
        const e = await esegui({ query: PERMESSO, upstream: { statusCode: 200, body } });
        expect(e.returned).toBe(1);
        expect(e.status).toBe(200);
        expect(e.body).toBe('[]');
        expect(e.cookies).toHaveLength(0);
      }
    });
  });

  describe('senza permesso', () => {
    it('nessun segnale: nessuna chiamata, nessun cookie', async () => {
      const e = await esegui({});
      expect(e.upstreamCalls).toHaveLength(0);
      expect(e.cookies).toHaveLength(0);
      expect(e.returned).toBe(1);
    });

    it('cookie di Shopify malformato: vale come silenzio, e si risponde', async () => {
      const e = await esegui({ cookies: { _tracking_consent: '{rotto' } });
      expect(e.upstreamCalls).toHaveLength(0);
      expect(e.returned).toBe(1);
    });
  });

  it('ogni intestazione scritta e permessa dal template', async () => {
    const scrivibili = (
      PERMESSI.find((p) => p.instance.key.publicId === 'access_response')!.instance.param ?? []
    )
      .filter((p) => p.key === 'writeHeaderAccess')
      .flatMap((p) => (p.value.listItem ?? []).map((v) => (v.string ?? '').toLowerCase()));

    const casi = [
      await esegui({ query: REVOCA, upstream: { reject: 'failed' } }),
      await esegui({ query: PERMESSO, upstream: { statusCode: 200, body: JSON.stringify([{ external_id: NUOVO }]) } }),
    ];
    for (const e of casi) {
      for (const nome of Object.keys(e.headers)) expect(scrivibili).toContain(nome);
    }
  });
});
