import { describe, it, expect, vi } from 'vitest';
import { verifyTrackingEndpoint } from './verify-endpoint.server';
import type { CheckId } from './verify-checks';
import type { Resolver, Transport } from '~/lib/net/safe-fetch.server';

const ID = 'corew_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GOOD_COOKIE = `kerdon_eid=${ID}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
const EXPIRED_COOKIE = 'kerdon_eid=; Path=/; Max-Age=0; SameSite=Lax; Secure';

const ENDPOINT = 'https://negozio.it/kerdon/id';
const PUBLIC_IP = '93.184.216.34';

interface Fake {
  status?: number;
  body?: string;
  cookies?: string[];
  headers?: Record<string, string>;
}

function reply({ status = 200, body = '[]', cookies = [], headers: extra = {} }: Fake): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', ...extra });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(status === 204 || status === 304 ? null : body, { status, headers });
}

/**
 * Un endpoint finto che si comporta bene: e' il metro con cui si misurano
 * quelli che si comportano male. E' il trasporto, non la `fetch`: la verifica
 * passa sempre dal client che controlla gli indirizzi, e i test con lei.
 */
function goodEndpoint(overrides: Partial<Record<'granted' | 'missing' | 'withdrawn', Fake>> = {}) {
  return vi.fn<Transport>(async ({ url }) => {
    const consent = url.searchParams.get('consent');

    if (!consent) return reply(overrides.missing ?? {});
    if (consent.includes('a0') || consent.includes('m0')) {
      return reply(overrides.withdrawn ?? { cookies: [EXPIRED_COOKIE] });
    }
    return reply(
      overrides.granted ?? { body: JSON.stringify([{ external_id: ID }]), cookies: [GOOD_COOKIE] },
    );
  });
}

/** Il DNS finto: tutto si risolve in un indirizzo pubblico, salvo diversa istruzione. */
const publicDns: Resolver = async () => [{ address: PUBLIC_IP, family: 4 }];

const run = (
  transport: Transport,
  endpoint = ENDPOINT,
  storefrontDomain?: string,
  resolve: Resolver = publicDns,
  timeoutMs?: number,
) =>
  verifyTrackingEndpoint({
    endpoint,
    appHost: 'api.kerdon.io',
    storefrontDomain,
    transport,
    resolve,
    timeoutMs,
  });

const reasonOf = (checks: { id: CheckId; reason: string | null }[], id: CheckId) =>
  checks.find((c) => c.id === id)?.reason;

describe('verifyTrackingEndpoint', () => {
  it('un endpoint che fa tutto giusto passa', async () => {
    const result = await run(goodEndpoint());
    expect(result.passed).toBe(true);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it('non manda nessuna credenziale: parla come parlerebbe un visitatore', async () => {
    const transport = goodEndpoint();
    await run(transport);
    for (const [request] of transport.mock.calls) {
      const headers = new Headers(request.headers);
      expect(headers.get('apikey')).toBeNull();
      expect(headers.get('authorization')).toBeNull();
    }
  });

  it('non segue i rimandi: farlo perderebbe per strada header e cookie', async () => {
    const transport = goodEndpoint({
      granted: { status: 302, body: '', headers: { Location: 'https://www.negozio.it/kerdon/id' } },
    });
    const result = await run(transport);
    expect(reasonOf(result.checks, 'no_redirect')).toBe('redirected');
    expect(transport.mock.calls.every(([r]) => r.url.hostname === 'negozio.it')).toBe(true);
  });

  // Il rimando e' la strada classica per far arrivare il nostro server dove
  // l'indirizzo scritto non arriverebbe: il servizio dei metadati del cloud.
  it('un rimando verso la rete interna non viene mai seguito', async () => {
    const transport = goodEndpoint({
      granted: { status: 302, body: '', headers: { Location: 'https://169.254.169.254/latest/meta-data/' } },
    });
    const result = await run(transport);
    expect(result.passed).toBe(false);
    expect(reasonOf(result.checks, 'no_redirect')).toBe('redirected');
    expect(transport.mock.calls.every(([r]) => r.address === PUBLIC_IP)).toBe(true);
    expect(transport.mock.calls.every(([r]) => r.url.hostname === 'negozio.it')).toBe(true);
  });

  describe('l indirizzo', () => {
    it('rifiuta quel che non e un indirizzo, senza chiamare niente', async () => {
      const transport = goodEndpoint();
      const result = await run(transport, 'non-un-indirizzo');
      expect(result.passed).toBe(false);
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_malformed');
      expect(transport).not.toHaveBeenCalled();
    });

    it('rifiuta quel che punta dentro casa nostra', async () => {
      const result = await run(goodEndpoint(), 'https://10.0.0.5/kerdon');
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_not_public');
    });

    // Il cookie li e' di terze parti: e' il problema per cui tutto questo giro
    // esiste, e vederlo configurato cosi' significa che non ha capito.
    it('rifiuta un endpoint che punta a noi', async () => {
      const result = await run(goodEndpoint(), 'https://api.kerdon.io/rest/v1/tracking_id');
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_is_app');
    });

    it('rifiuta un dominio myshopify.com, dove non puo mettere il proprio codice', async () => {
      const result = await run(goodEndpoint(), 'https://negozio.myshopify.com/kerdon/id');
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_is_shopify');
    });

    // Il punto finale e' lo stesso nome scritto per esteso: non deve bastare
    // a scavalcare i controlli sul nome.
    it('il punto finale non scavalca i controlli sul nome', async () => {
      const transport = goodEndpoint();
      const shopify = await run(transport, 'https://negozio.myshopify.com./kerdon/id');
      expect(reasonOf(shopify.checks, 'endpoint_url')).toBe('endpoint_is_shopify');
      const app = await run(transport, 'https://api.kerdon.io./kerdon/id');
      expect(reasonOf(app.checks, 'endpoint_url')).toBe('endpoint_is_app');
      expect(transport).not.toHaveBeenCalled();
    });

    it('rifiuta un dominio diverso da quello della vetrina', async () => {
      const result = await run(goodEndpoint(), 'https://tracking.altro.it/id', 'www.negozio.it');
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_not_first_party');
    });

    it('un sottodominio della vetrina va bene', async () => {
      const result = await run(
        goodEndpoint(),
        'https://sgtm.negozio.it/kerdon/id',
        'www.negozio.it',
      );
      expect(result.passed).toBe(true);
    });

    it('non conoscendo il dominio della vetrina, quel controllo non si fa', async () => {
      const result = await run(goodEndpoint(), 'https://tracking.altro.it/id');
      expect(result.passed).toBe(true);
    });

    it('http non basta: senza https il cookie non puo essere Secure', async () => {
      const result = await run(goodEndpoint(), 'http://negozio.it/kerdon/id');
      expect(reasonOf(result.checks, 'https')).toBe('not_https');
    });
  });

  describe('dove si collega davvero', () => {
    it.each(['https://[::1]/kerdon', 'https://[fd00::1]/kerdon', 'https://[::ffff:10.0.0.1]/kerdon', 'https://[2606:4700:4700::1111]/kerdon'])(
      'un IPv6 scritto nell indirizzo (%s) non e un endpoint first-party, e non si chiama',
      async (endpoint) => {
        const transport = goodEndpoint();
        const result = await run(transport, endpoint);
        expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_not_public');
        expect(transport).not.toHaveBeenCalled();
      },
    );

    it.each(['10.0.0.5', '127.0.0.1', '169.254.169.254', '100.64.1.1', '::1', 'fd12::1', 'fe80::1', '::ffff:192.168.0.1', '64:ff9b::7f00:1'])(
      'un nome che si risolve in %s non viene mai chiamato',
      async (ip) => {
        const transport = goodEndpoint();
        const resolve: Resolver = async () => [{ address: ip, family: ip.includes(':') ? 6 : 4 }];
        const result = await run(transport, ENDPOINT, undefined, resolve);
        expect(result.passed).toBe(false);
        expect(reasonOf(result.checks, 'reachable')).toBe('endpoint_not_public');
        expect(transport).not.toHaveBeenCalled();
      },
    );

    it('un IPv6 pubblico risolto va bene', async () => {
      const transport = goodEndpoint();
      const resolve: Resolver = async () => [{ address: '2606:4700:4700::1111', family: 6 }];
      const result = await run(transport, ENDPOINT, undefined, resolve);
      expect(result.passed).toBe(true);
      expect(transport.mock.calls[0][0]).toMatchObject({ address: '2606:4700:4700::1111', family: 6 });
    });

    // Il DNS risponde pubblico la prima volta e privato le successive: chi
    // controlla la prima risposta e poi si collega con una seconda finisce
    // dentro la nostra rete. Qui il nome si risolve una volta per verifica, e
    // tutte e tre le chiamate vanno a quell'indirizzo.
    it('rebinding: con il DNS che cambia risposta non si collega mai al privato', async () => {
      const answers = ['93.184.216.34', '169.254.169.254', '10.0.0.1', '127.0.0.1'];
      const resolve = vi.fn<Resolver>(async () => [{ address: answers.shift() ?? '127.0.0.1', family: 4 }]);
      const transport = goodEndpoint();

      const result = await run(transport, ENDPOINT, undefined, resolve);

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(transport).toHaveBeenCalledTimes(3);
      expect(transport.mock.calls.map(([r]) => r.address)).toEqual([PUBLIC_IP, PUBLIC_IP, PUBLIC_IP]);
      expect(result.passed).toBe(true);
    });

    it('una porta diversa da quella di https si rifiuta senza chiamare', async () => {
      const transport = goodEndpoint();
      const result = await run(transport, 'https://negozio.it:8443/kerdon/id');
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_port');
      expect(transport).not.toHaveBeenCalled();
    });

    it('nome utente e password nell indirizzo si rifiutano senza chiamare', async () => {
      const transport = goodEndpoint();
      const result = await run(transport, 'https://utente:segreto@negozio.it/kerdon/id');
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_credentials');
      expect(transport).not.toHaveBeenCalled();
    });

    it('http non si chiama nemmeno', async () => {
      const transport = goodEndpoint();
      await run(transport, 'http://negozio.it/kerdon/id');
      expect(transport).not.toHaveBeenCalled();
    });

    it('una risposta enorme non si legge fino in fondo', async () => {
      const transport = goodEndpoint({
        granted: { body: JSON.stringify([{ external_id: ID, pad: 'x'.repeat(200_000) }]), cookies: [GOOD_COOKIE] },
      });
      const result = await run(transport);
      expect(result.passed).toBe(false);
      expect(reasonOf(result.checks, 'reachable')).toBe('response_too_large');
    });

    it('un endpoint che non risponde mai si ferma al tempo massimo', async () => {
      const transport = vi.fn<Transport>(
        ({ signal }) =>
          new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      );
      const started = Date.now();
      const result = await run(transport, ENDPOINT, undefined, publicDns, 50);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(reasonOf(result.checks, 'reachable')).toBe('unreachable');
    });
  });

  describe('first-party secondo la lista pubblica dei suffissi', () => {
    it('due sottodomini github.io diversi NON sono lo stesso sito', async () => {
      const transport = goodEndpoint();
      const result = await run(transport, 'https://sgtm.altro.github.io/kerdon/id', 'negozio.github.io');
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_not_first_party');
      expect(transport).not.toHaveBeenCalled();
    });

    it('un sottodominio dello stesso github.io invece va bene', async () => {
      const result = await run(goodEndpoint(), 'https://sgtm.negozio.github.io/kerdon/id', 'negozio.github.io');
      expect(result.passed).toBe(true);
    });

    it('due negozi .co.uk diversi restano diversi', async () => {
      const result = await run(goodEndpoint(), 'https://sgtm.altro.co.uk/kerdon/id', 'www.negozio.co.uk');
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_not_first_party');
    });

    it('i nomi di rete locale non sono internet', async () => {
      for (const endpoint of ['https://sgtm.local/id', 'https://api.internal/id', 'https://localhost/id']) {
        const result = await run(goodEndpoint(), endpoint);
        expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_not_public');
      }
    });
  });

  it('un endpoint che non risponde si dice irraggiungibile, non rotto', async () => {
    const result = await run(vi.fn<Transport>(async () => {
      throw new Error('boom');
    }));
    expect(reasonOf(result.checks, 'reachable')).toBe('unreachable');
    expect(reasonOf(result.checks, 'consent_granted')).toBe('not_run');
  });

  it('un rimando fa fallire il controllo che gli tocca', async () => {
    const result = await run(
      goodEndpoint({ granted: { status: 302, body: '', headers: { Location: '/altrove' } } }),
    );
    expect(reasonOf(result.checks, 'no_redirect')).toBe('redirected');
  });

  it('con il consenso ma senza identificativo, non c e niente da tracciare', async () => {
    const result = await run(goodEndpoint({ granted: { body: '[]' } }));
    expect(reasonOf(result.checks, 'consent_granted')).toBe('no_identifier');
  });

  it('con il consenso ma senza cookie, il riconoscimento non dura', async () => {
    const result = await run(
      goodEndpoint({ granted: { body: JSON.stringify([{ external_id: ID }]) } }),
    );
    expect(reasonOf(result.checks, 'consent_granted')).toBe('no_cookie');
  });

  it('legge l identificativo anche dall header, non solo dal corpo', async () => {
    const transport = vi.fn<Transport>(async ({ url }) => {
      const consent = url.searchParams.get('consent');
      if (!consent) return reply({});
      if (consent.includes('a0')) return reply({ cookies: [EXPIRED_COOKIE] });
      const headers = new Headers({
        'Content-Type': 'application/json',
        'X-Kerdon-External-Id': ID,
      });
      headers.append('Set-Cookie', GOOD_COOKIE);
      return new Response('[]', { status: 200, headers });
    });

    const result = await run(transport);
    expect(result.passed).toBe(true);
  });

  it('un cookie senza Secure viene detto per nome', async () => {
    const result = await run(
      goodEndpoint({
        granted: {
          body: JSON.stringify([{ external_id: ID }]),
          cookies: [`kerdon_eid=${ID}; Path=/; Max-Age=31536000; SameSite=Lax`],
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(reasonOf(result.checks, 'cookie_attributes')).toBe('cookie_not_secure');
  });

  // Il controllo che conta di piu': un endpoint che conia senza segnale conia
  // per tutti, banner o non banner.
  it('bocciato chi restituisce un identificativo senza nessun segnale', async () => {
    const result = await run(
      goodEndpoint({ missing: { body: JSON.stringify([{ external_id: ID }]) } }),
    );
    expect(result.passed).toBe(false);
    expect(reasonOf(result.checks, 'consent_missing')).toBe('identifier_without_consent');
  });

  it('bocciato chi pianta il cookie senza nessun segnale', async () => {
    const result = await run(goodEndpoint({ missing: { cookies: [GOOD_COOKIE] } }));
    expect(reasonOf(result.checks, 'consent_missing')).toBe('cookie_without_consent');
  });

  it('bocciato chi continua a riconoscere dopo la revoca', async () => {
    const result = await run(
      goodEndpoint({
        withdrawn: { body: JSON.stringify([{ external_id: ID }]), cookies: [EXPIRED_COOKIE] },
      }),
    );
    expect(reasonOf(result.checks, 'consent_withdrawn')).toBe('identifier_after_withdrawal');
  });

  it('bocciato chi alla revoca non cancella quel che aveva scritto', async () => {
    const result = await run(goodEndpoint({ withdrawn: { cookies: [] } }));
    expect(reasonOf(result.checks, 'consent_withdrawn')).toBe('cookie_not_cleared');
  });

  it('alla revoca rimanda indietro l identificativo di prima, come farebbe la vetrina', async () => {
    const transport = goodEndpoint();
    await run(transport);
    const calls = transport.mock.calls.map(([r]) => r.url.toString());
    const withdrawal = calls.find((url) => url.includes('a0'));
    expect(withdrawal).toContain(`existing_external_id=${ID}`);
  });
});
