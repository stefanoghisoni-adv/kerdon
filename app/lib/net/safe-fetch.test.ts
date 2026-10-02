import { describe, it, expect, vi } from 'vitest';
import net from 'node:net';
import {
  SafeFetchError,
  httpsTransport,
  pinnedLookup,
  safeFetch,
  urlProblem,
  type Resolver,
  type Transport,
} from './safe-fetch.server';

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946';

const resolveTo =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }) as const);

/** Un trasporto finto: registra a che indirizzo gli si chiede di collegarsi. */
function fakeTransport(handler: (url: URL) => Response = () => new Response('ok')) {
  return vi.fn<Transport>(async ({ url }) => handler(url));
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SafeFetchError) return err.code;
    throw err;
  }
  throw new Error('nessun errore');
}

describe('urlProblem', () => {
  it('accetta https sulla porta standard', () => {
    expect(urlProblem(new URL('https://negozio.it/kerdon/id'))).toBeNull();
    expect(urlProblem(new URL('https://negozio.it:443/kerdon/id'))).toBeNull();
  });

  it('rifiuta http', () => {
    expect(urlProblem(new URL('http://negozio.it/'))).toBe('not_https');
  });

  it('rifiuta una porta diversa da 443', () => {
    expect(urlProblem(new URL('https://negozio.it:8443/'))).toBe('bad_port');
    expect(urlProblem(new URL('https://negozio.it:22/'))).toBe('bad_port');
  });

  it('rifiuta nome utente e password', () => {
    expect(urlProblem(new URL('https://utente@negozio.it/'))).toBe('userinfo');
    expect(urlProblem(new URL('https://utente:segreto@negozio.it/'))).toBe('userinfo');
  });
});

describe('safeFetch — dove si collega', () => {
  it('si collega all indirizzo risolto e verificato', async () => {
    const transport = fakeTransport();
    const res = await safeFetch('https://negozio.it/x', {
      resolve: resolveTo(PUBLIC_V4),
      transport,
    });
    expect(await res.text()).toBe('ok');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0].address).toBe(PUBLIC_V4);
    expect(transport.mock.calls[0][0].url.hostname).toBe('negozio.it');
  });

  it('IPv6 pubblico risolto: si collega', async () => {
    const transport = fakeTransport();
    await safeFetch('https://negozio.it/x', { resolve: resolveTo(PUBLIC_V6), transport });
    expect(transport.mock.calls[0][0]).toMatchObject({ address: PUBLIC_V6, family: 6 });
  });

  it.each(['10.0.0.5', '127.0.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '64:ff9b::a9fe:a9fe'])(
    'un nome che si risolve in %s non viene mai chiamato',
    async (ip) => {
      const transport = fakeTransport();
      const code = await codeOf(
        safeFetch('https://negozio.it/x', { resolve: resolveTo(ip), transport }),
      );
      expect(code).toBe('blocked_address');
      expect(transport).not.toHaveBeenCalled();
    },
  );

  // Un nome con un record pubblico e uno privato: basta il secondo per
  // rifiutare, altrimenti la scelta di quale usare la farebbe chi ha scritto i
  // record.
  it('se anche uno solo degli indirizzi e privato, si rifiuta', async () => {
    const transport = fakeTransport();
    const code = await codeOf(
      safeFetch('https://negozio.it/x', { resolve: resolveTo(PUBLIC_V4, '10.0.0.1'), transport }),
    );
    expect(code).toBe('blocked_address');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['https://[::1]/x', 'https://[fe80::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest'])(
    'un letterale non globale (%s) non si chiama e non si risolve',
    async (endpoint) => {
      const transport = fakeTransport();
      const resolve = vi.fn(resolveTo(PUBLIC_V4));
      const code = await codeOf(safeFetch(endpoint, { resolve, transport }));
      expect(code).toBe('blocked_address');
      expect(resolve).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('un nome che non si risolve e un errore di rete, non un permesso', async () => {
    const transport = fakeTransport();
    const code = await codeOf(
      safeFetch('https://negozio.it/x', {
        resolve: async () => {
          throw new Error('ENOTFOUND');
        },
        transport,
      }),
    );
    expect(code).toBe('dns_failed');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['http://negozio.it/x', 'not_https'],
    ['https://negozio.it:8443/x', 'bad_port'],
    ['https://u:p@negozio.it/x', 'userinfo'],
    ['non-un-indirizzo', 'invalid_url'],
  ])('%s si ferma prima di qualsiasi chiamata', async (endpoint, expected) => {
    const transport = fakeTransport();
    const resolve = vi.fn(resolveTo(PUBLIC_V4));
    expect(await codeOf(safeFetch(endpoint, { resolve, transport }))).toBe(expected);
    expect(resolve).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('safeFetch — come si presenta', () => {
  it('manda un User-Agent, a meno che chi chiama non ne dia uno suo', async () => {
    const transport = fakeTransport();
    await safeFetch('https://negozio.it/x', { resolve: resolveTo(PUBLIC_V4), transport });
    expect(transport.mock.calls[0][0].headers['User-Agent']).toMatch(/Kerdon/);

    await safeFetch('https://negozio.it/x', {
      resolve: resolveTo(PUBLIC_V4),
      transport,
      headers: { 'user-agent': 'altro' },
    });
    const second = transport.mock.calls[1][0].headers;
    expect(Object.entries(second).filter(([k]) => k.toLowerCase() === 'user-agent')).toEqual([
      ['user-agent', 'altro'],
    ]);
  });
});

describe('safeFetch — rebinding', () => {
  // Il trucco: la prima risposta del DNS e' pubblica e passa il controllo, la
  // seconda — quella che userebbe la connessione se risolvesse da se' — e'
  // privata. Qui la connessione riceve l'indirizzo gia' verificato e il DNS non
  // viene interrogato una seconda volta.
  it('il DNS si interroga una volta sola e la connessione va all indirizzo verificato', async () => {
    const answers = [PUBLIC_V4, '169.254.169.254'];
    const resolve = vi.fn<Resolver>(async () => {
      const address = answers.shift()!;
      return [{ address, family: 4 }];
    });
    const transport = fakeTransport();

    await safeFetch('https://negozio.it/x', { resolve, transport });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls.map((c) => c[0].address)).toEqual([PUBLIC_V4]);
  });

  it('pinnedLookup restituisce sempre gli indirizzi verificati, qualunque nome gli si chieda', async () => {
    const verified = [
      { address: PUBLIC_V6, family: 6 as const },
      { address: PUBLIC_V4, family: 4 as const },
    ];
    const lookup = pinnedLookup(verified);
    const single = (options: object) =>
      new Promise<[string, number]>((resolve, reject) =>
        lookup('negozio.it', options, (err, address, family) =>
          err ? reject(err) : resolve([address as string, family as number]),
        ),
      );

    // La forma singola preferisce l'IPv4: e' quello che esce da ogni runtime.
    expect(await single({})).toEqual([PUBLIC_V4, 4]);
    expect(await single({ family: 6 })).toEqual([PUBLIC_V6, 6]);
    expect(await single({ family: 4 })).toEqual([PUBLIC_V4, 4]);

    // La forma `all` li da' tutti — e solo quelli — cosi' Node puo' ripiegare
    // sull'altra famiglia se la prima non risponde.
    const all = await new Promise<unknown>((resolve, reject) =>
      lookup('altro.it', { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))),
    );
    expect(all).toEqual(verified);
  });

  it('il trasporto riceve tutti gli indirizzi verificati, con l IPv4 come preferito', async () => {
    const transport = fakeTransport();
    await safeFetch('https://negozio.it/x', { resolve: resolveTo(PUBLIC_V6, PUBLIC_V4), transport });
    const [request] = transport.mock.calls[0];
    expect(request.addresses.map((a) => a.address)).toEqual([PUBLIC_V6, PUBLIC_V4]);
    expect(request).toMatchObject({ address: PUBLIC_V4, family: 4 });
  });

  // La prova dal vero, senza uscire dalla macchina: un nome che nessun DNS
  // conosce (`.example` e' riservato) arriva comunque al nostro server locale,
  // perche' la connessione usa l'indirizzo che le passiamo noi. E il nome resta
  // nel saluto TLS (SNI): il certificato si controlla sul nome, non sull'IP.
  it('httpsTransport si collega all indirizzo fissato e presenta il nome nel TLS', async () => {
    const received: Buffer[] = [];
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        received.push(chunk);
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;

    try {
      await expect(
        httpsTransport({
          url: new URL(`https://endpoint-di-prova.example:${port}/kerdon/id`),
          address: '127.0.0.1',
          family: 4,
          addresses: [{ address: '127.0.0.1', family: 4 }],
          headers: {},
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow();
    } finally {
      server.close();
    }

    expect(received).toHaveLength(1);
    expect(received[0].toString('latin1')).toContain('endpoint-di-prova.example');
  });
});

describe('safeFetch — doppio stack', () => {
  // Un endpoint con AAAA e A, su un runtime senza IPv6 in uscita (comune nel
  // serverless): l'IPv6 non risponde, e la connessione deve arrivare lo stesso
  // sull'IPv4 verificato invece di dirsi irraggiungibile. `100::1` sta nel
  // prefisso di scarto: da nessuna macchina porta da nessuna parte.
  it('con l IPv6 irraggiungibile ripiega sull IPv4 verificato', async () => {
    const received: Buffer[] = [];
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        received.push(chunk);
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;

    try {
      await expect(
        httpsTransport({
          url: new URL(`https://doppio-stack.example:${port}/kerdon/id`),
          address: '100::1',
          family: 6,
          addresses: [
            { address: '100::1', family: 6 },
            { address: '127.0.0.1', family: 4 },
          ],
          headers: {},
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow();
    } finally {
      server.close();
    }

    expect(received).toHaveLength(1);
    expect(received[0].toString('latin1')).toContain('doppio-stack.example');
  });
});

describe('safeFetch — intestazioni', () => {
  it('chiede il corpo non compresso, che e quello che sa leggere', async () => {
    const transport = fakeTransport();
    await safeFetch('https://negozio.it/x', { resolve: resolveTo(PUBLIC_V4), transport });
    expect(transport.mock.calls[0][0].headers['Accept-Encoding']).toBe('identity');
  });

  it('copia gli header della risposta in un oggetto Headers nuovo', async () => {
    // Il ciclo che copia gli header sta dentro il try: se Headers.append solleva
    // (per esempio header malformati), la promessa rigetta invece di propagare
    // l'eccezione come non gestita. Questo test verifica che il percorso felice
    // funziona; il percorso di errore richiede mock complessi di Node internals.
    const transport = fakeTransport(() =>
      new Response('ok', {
        headers: {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'value',
          'Cache-Control': 'no-cache',
        },
      }),
    );
    const res = await safeFetch('https://negozio.it/x', {
      resolve: resolveTo(PUBLIC_V4),
      transport,
    });
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-custom-header')).toBe('value');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });
});

describe('safeFetch — rimandi', () => {
  const redirectTo = (location: string, status = 302) =>
    new Response(null, { status, headers: { Location: location } });

  it('con maxRedirects 0 il rimando torna com e, senza seguirlo', async () => {
    const transport = fakeTransport(() => redirectTo('https://altro.it/'));
    const res = await safeFetch('https://negozio.it/x', {
      resolve: resolveTo(PUBLIC_V4),
      transport,
      maxRedirects: 0,
    });
    expect(res.status).toBe(302);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('segue un rimando verso un indirizzo pubblico, rivalidandolo', async () => {
    const transport = fakeTransport((url) =>
      url.hostname === 'negozio.it' ? redirectTo('https://www.negozio.it/y') : new Response('arrivato'),
    );
    const resolve = vi.fn(resolveTo(PUBLIC_V4));
    const res = await safeFetch('https://negozio.it/x', { resolve, transport, maxRedirects: 3 });
    expect(await res.text()).toBe('arrivato');
    expect(resolve.mock.calls.map((c) => c[0])).toEqual(['negozio.it', 'www.negozio.it']);
  });

  it.each([
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/',
    'https://interno.negozio.it/',
    'http://negozio.it/',
    'https://negozio.it:8080/',
    'https://u:p@negozio.it/',
  ])('un rimando verso %s viene rifiutato e non viene mai chiamato', async (location) => {
    const transport = fakeTransport((url) =>
      url.hostname === 'negozio.it' && url.pathname === '/x' ? redirectTo(location) : new Response('dentro'),
    );
    const resolve: Resolver = async (host) =>
      host === 'interno.negozio.it' ? [{ address: '10.1.2.3', family: 4 }] : [{ address: PUBLIC_V4, family: 4 }];

    await expect(
      safeFetch('https://negozio.it/x', { resolve, transport, maxRedirects: 3 }),
    ).rejects.toBeInstanceOf(SafeFetchError);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('oltre il numero massimo di rimandi si ferma', async () => {
    let n = 0;
    const transport = fakeTransport(() => redirectTo(`https://negozio.it/${++n}`));
    const code = await codeOf(
      safeFetch('https://negozio.it/0', { resolve: resolveTo(PUBLIC_V4), transport, maxRedirects: 2 }),
    );
    expect(code).toBe('too_many_redirects');
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('il cookie non segue un rimando verso un altro host', async () => {
    const transport = fakeTransport((url) =>
      url.hostname === 'negozio.it' ? redirectTo('https://altro.it/') : new Response('ok'),
    );
    await safeFetch('https://negozio.it/x', {
      resolve: resolveTo(PUBLIC_V4),
      transport,
      maxRedirects: 1,
      headers: { Cookie: 'kerdon_eid=x', Accept: 'application/json' },
    });
    const second = transport.mock.calls[1][0].headers;
    expect(Object.keys(second).map((k) => k.toLowerCase())).not.toContain('cookie');
    expect(second.Accept).toBe('application/json');
  });
});

describe('safeFetch — limiti', () => {
  it('oltre il tetto di byte si ferma, invece di leggere tutto', async () => {
    const transport = fakeTransport(() => new Response('x'.repeat(2048)));
    const code = await codeOf(
      safeFetch('https://negozio.it/x', { resolve: resolveTo(PUBLIC_V4), transport, maxBytes: 1024 }),
    );
    expect(code).toBe('too_large');
  });

  it('sotto il tetto il corpo arriva intero', async () => {
    const transport = fakeTransport(() => new Response('x'.repeat(1024)));
    const res = await safeFetch('https://negozio.it/x', {
      resolve: resolveTo(PUBLIC_V4),
      transport,
      maxBytes: 1024,
    });
    expect((await res.text()).length).toBe(1024);
  });

  it('un corpo che non finisce mai si ferma al tetto, senza aspettare la fine', async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(512));
      },
    });
    const transport = fakeTransport(() => new Response(endless));
    const code = await codeOf(
      safeFetch('https://negozio.it/x', { resolve: resolveTo(PUBLIC_V4), transport, maxBytes: 4096 }),
    );
    expect(code).toBe('too_large');
  });

  it('un server che non risponde si ferma al tempo massimo', async () => {
    const transport = vi.fn<Transport>(
      ({ signal }) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    );
    const code = await codeOf(
      safeFetch('https://negozio.it/x', { resolve: resolveTo(PUBLIC_V4), transport, timeoutMs: 30 }),
    );
    expect(code).toBe('timeout');
  });

  it('il tempo massimo vale anche per un corpo che arriva a gocce', async () => {
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 20));
        controller.enqueue(new Uint8Array(1));
      },
    });
    const transport = fakeTransport(() => new Response(slow));
    const code = await codeOf(
      safeFetch('https://negozio.it/x', { resolve: resolveTo(PUBLIC_V4), transport, timeoutMs: 60 }),
    );
    expect(code).toBe('timeout');
  });

  it('il tempo massimo vale anche per un DNS che non risponde', async () => {
    const transport = fakeTransport();
    const code = await codeOf(
      safeFetch('https://negozio.it/x', {
        resolve: () => new Promise(() => {}),
        transport,
        timeoutMs: 30,
      }),
    );
    expect(code).toBe('timeout');
    expect(transport).not.toHaveBeenCalled();
  });
});
