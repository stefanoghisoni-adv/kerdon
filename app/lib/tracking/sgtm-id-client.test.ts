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
  /** Una risposta per tutte le chiamate, o una per chiamata, in ordine. */
  upstream?: Upstream | Upstream[];
  /** Campi del client da sovrascrivere (es. un indirizzo vuoto). */
  data?: Record<string, unknown>;
  /** Quante volte `returnResponse` solleva prima di riuscire. */
  returnThrows?: number;
  /** Solleva dentro `setCookie`. */
  setCookieThrows?: boolean;
}

async function esegui(r: Richiesta) {
  const esito = {
    status: 0,
    body: '',
    headers: {} as Record<string, string>,
    cookies: [] as { name: string; value: string; maxAge: unknown }[],
    httpOnly: {} as Record<string, unknown>,
    returned: 0,
    returnAttempts: 0,
    upstreamCalls: [] as string[],
    upstreamIds: [] as (string | undefined)[],
    cookiesRead: [] as string[],
  };
  let pendente: Promise<unknown> = Promise.resolve();
  let ritorniFalliti = 0;

  const api: Record<string, unknown> = {
    claimRequest: () => {},
    getRequestPath: () => '/kerdon/id',
    getRequestQueryParameter: (k: string) => r.query?.[k],
    getRequestHeader: (k: string) => (k === 'origin' ? 'https://www.negozio.it' : undefined),
    getCookieValues: (k: string) => {
      esito.cookiesRead.push(k);
      return r.cookies?.[k] ? [r.cookies[k]] : [];
    },
    setCookie: (name: string, value: string, opts: Record<string, unknown>) => {
      if (r.setCookieThrows) throw new Error('setCookie rotto');
      esito.cookies.push({ name, value, maxAge: opts['max-age'] });
      esito.httpOnly[name] = opts.httpOnly;
    },
    setResponseBody: (b: string) => (esito.body = b),
    setResponseHeader: (k: string, v: string) => (esito.headers[k.toLowerCase()] = v),
    setResponseStatus: (s: number) => (esito.status = s),
    returnResponse: () => {
      esito.returnAttempts += 1;
      if (ritorniFalliti < (r.returnThrows ?? 0)) {
        ritorniFalliti += 1;
        throw new Error('returnResponse rotto');
      }
      esito.returned += 1;
    },
    sendHttpGet: (url: string, opts: { headers?: Record<string, string> }) => {
      const n = esito.upstreamCalls.length;
      esito.upstreamCalls.push(url);
      esito.upstreamIds.push(opts?.headers?.['X-Kerdon-External-Id']);
      const tutte = r.upstream ?? { statusCode: 200, body: '[]' };
      const u = Array.isArray(tutte) ? (tutte[n] ?? tutte[tutte.length - 1]) : tutte;
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
    ...r.data,
  };

  new Function('require', 'data', CODICE)(require, data);
  // Le revoche in fila fanno piu' giri: si aspetta finche' le chiamate in
  // uscita smettono di crescere.
  for (let giro = 0; giro < 10; giro++) {
    const prima = esito.upstreamCalls.length;
    await pendente;
    for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0));
    if (esito.upstreamCalls.length === prima) break;
  }
  return { ...esito, richiesti };
}

/** I cookie del browser dopo la risposta: l'ultimo `setCookie` per nome vince. */
function barattolo(prima: Record<string, string>, e: { cookies: { name: string; value: string; maxAge: unknown }[] }) {
  const dopo = { ...prima };
  for (const c of e.cookies) {
    if (c.maxAge === 0 || c.value === '') delete dopo[c.name];
    else dopo[c.name] = c.value;
  }
  return dopo;
}

// La revoca come arriva davvero: il no, e il cookie del browser che la porta.
const REVOCA: Richiesta = { query: { consent: 'v1.a0.m0' }, cookies: { kerdon_eid: VECCHIO } };
const IN_SOSPESO = `v1.a0.m0~${VECCHIO}`;
const PERMESSO = { consent: 'v1.a1.m1' };

describe('il Client sGTM: ogni ramo risponde, una volta sola', () => {
  describe('alla revoca', () => {
    it('upstream 200: 200, cookie scaduto', async () => {
      const e = await esegui({ ...REVOCA, upstream: { statusCode: 200, body: '[]' } });
      expect(e.returned).toBe(1);
      expect(e.status).toBe(200);
      expect(e.body).toBe('[]');
      expect(e.cookies).toEqual([{ name: 'kerdon_eid', value: '', maxAge: 0 }]);
    });

    it('rete giu: 503 con Retry-After leggibile dalla vetrina', async () => {
      const e = await esegui({ ...REVOCA, upstream: { reject: 'failed' } });
      expect(e.returned).toBe(1);
      expect(e.status).toBe(503);
      expect(e.headers['retry-after']).toMatch(/^\d+$/);
      expect(e.headers['access-control-expose-headers']).toMatch(/retry-after/i);
      // Il cookie scade comunque: il tracciamento cessa nell'istante del no.
      // L'identificativo resta solo in `kerdon_rv`, per riprovare.
      expect(e.cookies).toEqual([
        { name: 'kerdon_eid', value: '', maxAge: 0 },
        { name: 'kerdon_rv', value: IN_SOSPESO, maxAge: 2592000 },
      ]);
      expect(e.httpOnly.kerdon_rv).toBe(true);
      expect(e.body).not.toContain(VECCHIO);
      expect(e.headers['x-kerdon-external-id']).toBeUndefined();
    });

    it('timeout: 503', async () => {
      const e = await esegui({ ...REVOCA, upstream: { reject: 'timed_out' } });
      expect(e.returned).toBe(1);
      expect(e.status).toBe(503);
    });

    it('upstream 503 con Retry-After: lo si inoltra', async () => {
      const e = await esegui({
        ...REVOCA,
        upstream: { statusCode: 503, headers: { 'retry-after': '120' }, body: '{"error":"x"}' },
      });
      expect(e.returned).toBe(1);
      expect(e.status).toBe(503);
      expect(e.headers['retry-after']).toBe('120');
    });

    it('upstream 500 o 429: 503, mai un ok', async () => {
      for (const statusCode of [500, 429, 401]) {
        const e = await esegui({ ...REVOCA, upstream: { statusCode, body: 'non json' } });
        expect(e.returned).toBe(1);
        expect(e.status).toBe(503);
      }
    });

    it('un Retry-After malformato non passa', async () => {
      const e = await esegui({
        ...REVOCA,
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

  describe('la revoca in sospeso, senza nessuno script in vetrina', () => {
    it('rete giu, poi la visita dopo senza nessun segnale: si riprova e si chiude', async () => {
      const prima = await esegui({ ...REVOCA, upstream: { reject: 'failed' } });
      expect(prima.status).toBe(503);
      const jar = barattolo({ kerdon_eid: VECCHIO }, prima);
      expect(jar).toEqual({ kerdon_rv: IN_SOSPESO });

      // Visita successiva: nessun parametro, nessun consenso. Il cookie basta.
      const dopo = await esegui({ cookies: jar, upstream: { statusCode: 200, body: '[]' } });
      expect(dopo.upstreamCalls).toHaveLength(1);
      expect(dopo.upstreamIds[0]).toBe(VECCHIO);
      expect(dopo.upstreamCalls[0]).toContain('consent=v1.a0.m0');
      expect(dopo.returned).toBe(1);
      expect(dopo.status).toBe(200);
      expect(dopo.body).toBe('[]');
      expect(barattolo(jar, dopo)).toEqual({});
    });

    it('503 anche alla visita dopo: 503, e il cookie in sospeso non si riscrive', async () => {
      const e = await esegui({
        cookies: { kerdon_rv: IN_SOSPESO },
        upstream: { statusCode: 503, headers: { 'retry-after': '30' } },
      });
      expect(e.returned).toBe(1);
      expect(e.status).toBe(503);
      expect(e.headers['retry-after']).toBe('30');
      // Riscriverlo farebbe ripartire i 30 giorni a ogni guasto.
      expect(e.cookies.filter((c) => c.name === 'kerdon_rv')).toHaveLength(0);
    });

    it('permesso ridato mentre la revoca e in sospeso: prima si revoca, poi un identificativo NUOVO', async () => {
      const e = await esegui({
        query: { consent: 'v1.a1.m1', existing_external_id: VECCHIO },
        cookies: { kerdon_rv: IN_SOSPESO, kerdon_eid: VECCHIO },
        upstream: [
          { statusCode: 200, body: '[]' },
          { statusCode: 200, body: JSON.stringify([{ external_id: NUOVO }]) },
        ],
      });
      expect(e.upstreamCalls).toHaveLength(2);
      expect(e.upstreamIds).toEqual([VECCHIO, undefined]);
      expect(e.upstreamCalls[0]).toContain('consent=v1.a0.m0');
      expect(e.upstreamCalls[1]).toContain('consent=v1.a1.m1');
      expect(e.returned).toBe(1);
      expect(JSON.parse(e.body)).toEqual([{ external_id: NUOVO }]);
      expect(barattolo({ kerdon_rv: IN_SOSPESO }, e)).toEqual({ kerdon_eid: NUOVO });
    });

    it('permesso ridato ma revoca ancora non confermata: niente conio, niente riuso', async () => {
      const e = await esegui({
        query: { consent: 'v1.a1.m1' },
        cookies: { kerdon_rv: IN_SOSPESO },
        upstream: { reject: 'timed_out' },
      });
      expect(e.upstreamCalls).toHaveLength(1);
      expect(e.returned).toBe(1);
      expect(e.status).toBe(503);
      expect(e.body).not.toContain(VECCHIO);
      expect(e.cookies.filter((c) => c.name === 'kerdon_eid')).toHaveLength(0);
    });

    it('un kerdon_rv che non porta un no, o nessun identificativo valido, non vale', async () => {
      for (const rotto of [`v1.a1.m1~${VECCHIO}`, 'v1.a0.m0~nonunid', 'spazzatura', `~${VECCHIO}`]) {
        const e = await esegui({ cookies: { kerdon_rv: rotto } });
        expect(e.upstreamCalls).toHaveLength(0);
        expect(e.returned).toBe(1);
        expect(e.body).toBe('[]');
      }
    });

    it('in sospeso piu un nuovo identificativo da revocare: tutti e due, in fila; se il secondo fallisce resta lui', async () => {
      const e = await esegui({
        query: { consent: 'v1.a0.m0' },
        cookies: { kerdon_rv: IN_SOSPESO, kerdon_eid: NUOVO },
        upstream: [{ statusCode: 200, body: '[]' }, { statusCode: 500 }],
      });
      expect(e.upstreamIds).toEqual([VECCHIO, NUOVO]);
      expect(e.returned).toBe(1);
      expect(e.status).toBe(503);
      expect(barattolo({ kerdon_rv: IN_SOSPESO }, e)).toEqual({ kerdon_rv: `v1.a0.m0~${NUOVO}` });
    });
  });

  describe('existing_external_id vale solo se e il cookie del browser', () => {
    it('dopo una revoca confermata, permesso ridato con il vecchio id nel parametro e nessun cookie: id NUOVO', async () => {
      const revoca = await esegui({ ...REVOCA, upstream: { statusCode: 200, body: '[]' } });
      expect(revoca.status).toBe(200);
      const jar = barattolo({ kerdon_eid: VECCHIO }, revoca);
      expect(jar).toEqual({});

      const dopo = await esegui({
        query: { consent: 'v1.a1.m1', existing_external_id: VECCHIO },
        cookies: jar,
        upstream: { statusCode: 200, body: JSON.stringify([{ external_id: NUOVO }]) },
      });
      expect(dopo.upstreamCalls).toHaveLength(1);
      // Nessun identificativo mandato a Kerdon: si chiede di coniarne uno.
      expect(dopo.upstreamIds).toEqual([undefined]);
      expect(JSON.parse(dopo.body)).toEqual([{ external_id: NUOVO }]);
      expect(barattolo(jar, dopo)).toEqual({ kerdon_eid: NUOVO });
    });

    it('parametro diverso dal cookie: vale il cookie', async () => {
      const e = await esegui({
        query: { consent: 'v1.a1.m1', existing_external_id: VECCHIO },
        cookies: { kerdon_eid: NUOVO },
        upstream: { statusCode: 200, body: JSON.stringify([{ external_id: NUOVO }]) },
      });
      expect(e.upstreamIds).toEqual([NUOVO]);
    });

    it('parametro uguale al cookie: si riusa', async () => {
      const e = await esegui({
        query: { consent: 'v1.a1.m1', existing_external_id: NUOVO },
        cookies: { kerdon_eid: NUOVO },
        upstream: { statusCode: 200, body: JSON.stringify([{ external_id: NUOVO }]) },
      });
      expect(e.upstreamIds).toEqual([NUOVO]);
    });

    it('alla revoca, un id nel solo parametro non si cancella: non e di questo browser', async () => {
      const e = await esegui({ query: { consent: 'v1.a0.m0', existing_external_id: VECCHIO } });
      expect(e.upstreamCalls).toHaveLength(0);
      expect(e.returned).toBe(1);
      expect(e.status).toBe(200);
    });
  });

  describe('il permesso letto dal cookie di Shopify si inoltra a Kerdon', () => {
    it('no dal cookie: la revoca parte con il no nella querystring', async () => {
      const e = await esegui({
        cookies: {
          _tracking_consent: JSON.stringify({ purposes: { a: false, m: false, p: true, s: true } }),
          kerdon_eid: VECCHIO,
        },
        upstream: { statusCode: 200, body: '[]' },
      });
      expect(e.upstreamCalls).toHaveLength(1);
      expect(e.upstreamCalls[0]).toContain('consent=v1.a0.m0.p1.s1');
      expect(e.upstreamIds[0]).toBe(VECCHIO);
      expect(e.status).toBe(200);
    });

    it('si dal cookie: la chiamata porta il si', async () => {
      const e = await esegui({
        cookies: { _tracking_consent: JSON.stringify({ purposes: { a: true, m: true } }) },
        upstream: { statusCode: 200, body: JSON.stringify([{ external_id: NUOVO }]) },
      });
      expect(e.upstreamCalls[0]).toContain('consent=v1.a1.m1');
      expect(JSON.parse(e.body)).toEqual([{ external_id: NUOVO }]);
    });
  });

  describe('ogni strada finisce in una risposta, una sola', () => {
    it('returnResponse che solleva: un secondo tentativo, poi basta', async () => {
      const casi: Richiesta[] = [
        {},
        { query: PERMESSO, upstream: { statusCode: 200, body: JSON.stringify([{ external_id: NUOVO }]) } },
        { ...REVOCA, upstream: { reject: 'failed' } },
      ];
      for (const caso of casi) {
        const e = await esegui({ ...caso, returnThrows: 1 });
        expect(e.returnAttempts).toBe(2);
        expect(e.returned).toBe(1);
        expect(e.status).toBe(500);
      }
      const sempre = await esegui({ query: PERMESSO, returnThrows: 99 });
      expect(sempre.returnAttempts).toBe(2);
      expect(sempre.returned).toBe(0);
    });

    it('indirizzo dell API vuoto, con il permesso: 500, nessuna chiamata', async () => {
      for (const kerdonUrl of ['', undefined, 'http://api.kerdon.io']) {
        const e = await esegui({ query: PERMESSO, data: { kerdonUrl } });
        expect(e.upstreamCalls).toHaveLength(0);
        expect(e.returned).toBe(1);
        expect(e.status).toBe(500);
        expect(e.body).toContain('client_misconfigured');
      }
    });

    it('indirizzo dell API vuoto, alla revoca: 503 e l identificativo resta da parte', async () => {
      const e = await esegui({ ...REVOCA, data: { kerdonUrl: '' } });
      expect(e.upstreamCalls).toHaveLength(0);
      expect(e.returned).toBe(1);
      expect(e.status).toBe(503);
      expect(barattolo({ kerdon_eid: VECCHIO }, e)).toEqual({ kerdon_rv: IN_SOSPESO });
    });

    it('errore sincrono prima di sendHttpGet: si risponde lo stesso', async () => {
      // Una chiave che non e' una stringa fa sollevare la costruzione delle
      // intestazioni, prima di qualunque chiamata.
      const permesso = await esegui({ query: PERMESSO, data: { ingestKey: 12345 } });
      expect(permesso.upstreamCalls).toHaveLength(0);
      expect(permesso.returned).toBe(1);
      expect(permesso.status).toBe(500);

      const revoca = await esegui({ ...REVOCA, data: { ingestKey: 12345 } });
      expect(revoca.upstreamCalls).toHaveLength(0);
      expect(revoca.returned).toBe(1);
      expect(revoca.status).toBe(503);
      expect(barattolo({ kerdon_eid: VECCHIO }, revoca)).toEqual({ kerdon_rv: IN_SOSPESO });
    });

    it('setCookie che solleva: si risponde lo stesso', async () => {
      const e = await esegui({ ...REVOCA, setCookieThrows: true });
      expect(e.returned).toBe(1);
      expect(e.status).toBeGreaterThanOrEqual(500);
    });
  });

  it('ogni cookie letto o scritto e permesso dal template', async () => {
    const lista = (id: string, chiave: string) =>
      (PERMESSI.find((p) => p.instance.key.publicId === id)!.instance.param ?? [])
        .filter((p) => p.key === chiave)
        .flatMap((p) => (p.value.listItem ?? []) as Array<{ string?: string; mapValue?: Array<{ string?: string }> }>);
    const leggibili = lista('get_cookies', 'cookieNames').map((v) => v.string);
    const scrivibili = lista('set_cookies', 'allowedCookies').map((v) => v.mapValue?.[0]?.string);

    const casi = [
      await esegui({ ...REVOCA, upstream: { reject: 'failed' } }),
      await esegui({ cookies: { kerdon_rv: IN_SOSPESO }, upstream: { statusCode: 200, body: '[]' } }),
      await esegui({ query: PERMESSO, upstream: { statusCode: 200, body: JSON.stringify([{ external_id: NUOVO }]) } }),
    ];
    for (const e of casi) {
      for (const nome of e.cookiesRead) expect(leggibili).toContain(nome);
      for (const c of e.cookies) expect(scrivibili).toContain(c.name);
    }
  });

  it('ogni intestazione scritta e permessa dal template', async () => {
    const scrivibili = (
      PERMESSI.find((p) => p.instance.key.publicId === 'access_response')!.instance.param ?? []
    )
      .filter((p) => p.key === 'writeHeaderAccess')
      .flatMap((p) => (p.value.listItem ?? []).map((v) => (v.string ?? '').toLowerCase()));

    const casi = [
      await esegui({ ...REVOCA, upstream: { reject: 'failed' } }),
      await esegui({ query: PERMESSO, upstream: { statusCode: 200, body: JSON.stringify([{ external_id: NUOVO }]) } }),
    ];
    for (const e of casi) {
      for (const nome of Object.keys(e.headers)) expect(scrivibili).toContain(nome);
    }
  });
});
