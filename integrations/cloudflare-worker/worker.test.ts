import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Il Worker e' JavaScript senza build: si pubblica com'e', e importarlo qui e'
// l'unico modo di provare l'asset vero invece di una sua copia riscritta.
import worker from './worker.js';

const ID = 'corew_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ENDPOINT = 'https://negozio.it/kerdon/id';
const TOKEN = 'spx_segretissimo';

const ENV = {
  KERDON_URL: 'https://api.coreward.app',
  KERDON_TOKEN: TOKEN,
  COOKIE_DOMAIN: '.negozio.it',
};

/** Kerdon, finto: risponde come risponde la rotta vera. */
function kerdon(body: unknown = [{ external_id: ID }]) {
  // I due parametri sono dichiarati anche se il finto non li guarda: senza, i
  // test non potrebbero leggere con che intestazioni e' stato chiamato, che e'
  // meta' di quello che c'e' da controllare.
  return vi.fn(async (_url: string | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-CoreW-External-Id': ID },
    }),
  );
}

interface Visit {
  search?: string;
  cookies?: string;
  method?: string;
  origin?: string;
}

function call(env: Record<string, string>, visit: Visit = {}) {
  const headers = new Headers();
  if (visit.cookies) headers.set('Cookie', visit.cookies);
  headers.set('Origin', visit.origin ?? 'https://negozio.it');

  return worker.fetch(
    new Request(`${ENDPOINT}${visit.search ?? ''}`, {
      method: visit.method ?? 'GET',
      headers,
    }),
    env,
  ) as Promise<Response>;
}

const cookiesOf = (response: Response) => response.headers.getSetCookie();
const idCookie = (response: Response) =>
  cookiesOf(response).find((c) => c.startsWith('corew_eid=')) ?? null;

let upstream: ReturnType<typeof kerdon>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  upstream = kerdon();
  globalThis.fetch = upstream as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('il Worker sul dominio del negozio', () => {
  describe('senza permesso', () => {
    // La regola che vale piu' di tutte: chi non ha ancora risposto al banner non
    // deve lasciare traccia da nessuna parte.
    it('nessun segnale: non chiama nessuno e non scrive niente', async () => {
      const response = await call(ENV);
      expect(await response.text()).toBe('[]');
      expect(cookiesOf(response)).toHaveLength(0);
      expect(upstream).not.toHaveBeenCalled();
    });

    // Servono tutte e due: e' lo stesso identificativo a misurare e ad
    // attribuire, e non se ne conia mezzo. Un no esplicito su una delle due e'
    // pero' un no, non un silenzio: il cookie va tolto, non solo non scritto.
    it('il permesso su una sola finalita non basta, e il no toglie quel che c era', async () => {
      const response = await call(ENV, { search: '?consent=v1.a1.m0' });
      expect(await response.text()).toBe('[]');
      expect(idCookie(response)).toContain('Max-Age=0');
    });

    it('il silenzio su una finalita non fa scadere niente', async () => {
      const response = await call(ENV, { search: '?consent=v1.a1' });
      expect(await response.text()).toBe('[]');
      expect(idCookie(response)).toBeNull();
      expect(upstream).not.toHaveBeenCalled();
    });

    it('un valore di consenso che non sappiamo leggere vale come silenzio', async () => {
      await call(ENV, { search: '?consent=v9.tuttosi' });
      expect(upstream).not.toHaveBeenCalled();
    });
  });

  describe('con il permesso', () => {
    it('chiede l identificativo e lo restituisce', async () => {
      const response = await call(ENV, { search: '?consent=v1.a1.m1' });
      expect(await response.json()).toEqual([{ external_id: ID }]);
      expect(response.headers.get('X-CoreW-External-Id')).toBe(ID);
    });

    it('pianta il cookie first-party con gli attributi che servono', async () => {
      const response = await call(ENV, { search: '?consent=v1.a1.m1' });
      const cookie = idCookie(response)!;

      expect(cookie).toContain(`corew_eid=${ID}`);
      expect(cookie).toContain('Path=/');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Max-Age=31536000');
      expect(cookie).toContain('Domain=.negozio.it');
    });

    it('rimanda a Kerdon l identificativo che il browser ha gia', async () => {
      await call(ENV, { search: '?consent=v1.a1.m1', cookies: `corew_eid=${ID}` });
      const init = upstream.mock.calls[0][1] as RequestInit;
      expect(new Headers(init.headers).get('X-CoreW-External-Id')).toBe(ID);
    });

    // Un identificativo scelto dal chiamante sarebbe un modo di farsi passare
    // per un altro visitatore.
    it('un identificativo malformato vale come assente', async () => {
      await call(ENV, { search: '?consent=v1.a1.m1&existing_external_id=non-mio' });
      const init = upstream.mock.calls[0][1] as RequestInit;
      expect(new Headers(init.headers).get('X-CoreW-External-Id')).toBeNull();
    });

    it('legge il permesso anche dal cookie di Shopify, senza il ponte', async () => {
      const cookie = encodeURIComponent(JSON.stringify({ purposes: { a: true, m: true } }));
      const response = await call(ENV, { cookies: `_tracking_consent=${cookie}` });
      expect(await response.json()).toEqual([{ external_id: ID }]);
    });

    it('un identificativo non si mette in cache: sarebbe lo stesso per due persone', async () => {
      const response = await call(ENV, { search: '?consent=v1.a1.m1' });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });
  });

  describe('alla revoca', () => {
    const revoke = () =>
      call(ENV, { search: '?consent=v1.a0.m0', cookies: `corew_eid=${ID}` });

    it('fa scadere il cookie', async () => {
      const cookie = idCookie(await revoke())!;
      expect(cookie).toContain('Max-Age=0');
      expect(cookie).toContain('corew_eid=;');
    });

    it('dice a Kerdon di dimenticare quell identificativo', async () => {
      await revoke();
      const init = upstream.mock.calls[0][1] as RequestInit;
      expect(new Headers(init.headers).get('X-CoreW-External-Id')).toBe(ID);
    });

    it('non restituisce piu niente', async () => {
      expect(await (await revoke()).text()).toBe('[]');
    });

    // Il cookie scade comunque: si perde una cancellazione a valle, non si
    // continua a raccogliere.
    it('se Kerdon non risponde, il cookie scade lo stesso', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('giu');
      }) as unknown as typeof fetch;
      expect(idCookie(await revoke())).toContain('Max-Age=0');
    });
  });

  describe('la chiave', () => {
    it('va a Kerdon e non torna mai indietro', async () => {
      const response = await call(ENV, { search: '?consent=v1.a1.m1' });

      const init = upstream.mock.calls[0][1] as RequestInit;
      expect(new Headers(init.headers).get('apikey')).toBe(TOKEN);

      const dump = JSON.stringify([...response.headers.entries()]) + (await response.text());
      expect(dump).not.toContain(TOKEN);
    });

    it('senza chiave non si chiama nessuno', async () => {
      const response = await call({ ...ENV, KERDON_TOKEN: '' }, { search: '?consent=v1.a1.m1' });
      expect(await response.text()).toBe('[]');
      expect(upstream).not.toHaveBeenCalled();
    });

    // L'indirizzo e' un parametro e non una costante: senza, non si chiama
    // niente invece di indovinare.
    it('senza indirizzo dell API non si chiama nessuno', async () => {
      const response = await call({ ...ENV, KERDON_URL: '' }, { search: '?consent=v1.a1.m1' });
      expect(await response.text()).toBe('[]');
      expect(upstream).not.toHaveBeenCalled();
    });

    it('l indirizzo dell API si puo cambiare senza toccare il codice', async () => {
      await call(
        { ...ENV, KERDON_URL: 'https://api.kerdon.io' },
        { search: '?consent=v1.a1.m1' },
      );
      expect(String(upstream.mock.calls[0][0])).toContain('https://api.kerdon.io/rest/v1/');
    });
  });

  describe('chi puo chiamare', () => {
    it('risponde al controllo preliminare del browser', async () => {
      const response = await call(ENV, { method: 'OPTIONS' });
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://negozio.it');
      expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('accetta i sottodomini del negozio', async () => {
      const response = await call(ENV, { origin: 'https://www.negozio.it' });
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://www.negozio.it');
    });

    // Senza questo, una pagina qualunque su un sito qualunque potrebbe farsi
    // dire l'identificativo di chi la sta guardando.
    it('non riflette l origine di un sito estraneo', async () => {
      const response = await call(ENV, { origin: 'https://tizio.example' });
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    });
  });
});
