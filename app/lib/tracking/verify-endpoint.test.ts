import { describe, it, expect, vi } from 'vitest';
import { verifyTrackingEndpoint } from './verify-endpoint.server';
import type { CheckId } from './verify-checks';

const ID = 'corew_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GOOD_COOKIE = `kerdon_eid=${ID}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
const EXPIRED_COOKIE = 'kerdon_eid=; Path=/; Max-Age=0; SameSite=Lax; Secure';

const ENDPOINT = 'https://negozio.it/kerdon/id';

interface Fake {
  status?: number;
  body?: string;
  cookies?: string[];
}

function reply({ status = 200, body = '[]', cookies = [] }: Fake): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(body, { status, headers });
}

/**
 * Un endpoint finto che si comporta bene: e' il metro con cui si misurano
 * quelli che si comportano male.
 */
function goodEndpoint(overrides: Partial<Record<'granted' | 'missing' | 'withdrawn', Fake>> = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const consent = url.searchParams.get('consent');

    if (!consent) return reply(overrides.missing ?? {});
    if (consent.includes('a0') || consent.includes('m0')) {
      return reply(overrides.withdrawn ?? { cookies: [EXPIRED_COOKIE] });
    }
    return reply(
      overrides.granted ?? { body: JSON.stringify([{ external_id: ID }]), cookies: [GOOD_COOKIE] },
    );
  }) as unknown as typeof fetch;
}

const run = (fetchImpl: typeof fetch, endpoint = ENDPOINT, storefrontDomain?: string) =>
  verifyTrackingEndpoint({
    endpoint,
    appHost: 'api.coreward.app',
    storefrontDomain,
    fetchImpl,
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
    const fetchImpl = goodEndpoint();
    await run(fetchImpl);
    for (const call of (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls) {
      const init = call[1] as RequestInit | undefined;
      const headers = new Headers(init?.headers);
      expect(headers.get('apikey')).toBeNull();
      expect(headers.get('authorization')).toBeNull();
    }
  });

  it('non segue i rimandi: farlo perderebbe per strada header e cookie', async () => {
    const fetchImpl = goodEndpoint();
    await run(fetchImpl);
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('manual');
  });

  describe('l indirizzo', () => {
    it('rifiuta quel che non e un indirizzo, senza chiamare niente', async () => {
      const fetchImpl = goodEndpoint();
      const result = await run(fetchImpl, 'non-un-indirizzo');
      expect(result.passed).toBe(false);
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_malformed');
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rifiuta quel che punta dentro casa nostra', async () => {
      const result = await run(goodEndpoint(), 'https://10.0.0.5/kerdon');
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_not_public');
    });

    // Il cookie li e' di terze parti: e' il problema per cui tutto questo giro
    // esiste, e vederlo configurato cosi' significa che non ha capito.
    it('rifiuta un endpoint che punta a noi', async () => {
      const result = await run(goodEndpoint(), 'https://api.coreward.app/rest/v1/tracking_id');
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_is_app');
    });

    it('rifiuta un dominio myshopify.com, dove non puo mettere il proprio codice', async () => {
      const result = await run(goodEndpoint(), 'https://negozio.myshopify.com/kerdon/id');
      expect(reasonOf(result.checks, 'endpoint_url')).toBe('endpoint_is_shopify');
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

  it('un endpoint che non risponde si dice irraggiungibile, non rotto', async () => {
    const result = await run(vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch);
    expect(reasonOf(result.checks, 'reachable')).toBe('unreachable');
    expect(reasonOf(result.checks, 'consent_granted')).toBe('not_run');
  });

  it('un rimando fa fallire il controllo che gli tocca', async () => {
    const result = await run(
      goodEndpoint({ granted: { status: 302, body: '' } }) as unknown as typeof fetch,
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
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const consent = url.searchParams.get('consent');
      if (!consent) return reply({});
      if (consent.includes('a0')) return reply({ cookies: [EXPIRED_COOKIE] });
      const headers = new Headers({
        'Content-Type': 'application/json',
        'X-CoreW-External-Id': ID,
      });
      headers.append('Set-Cookie', GOOD_COOKIE);
      return new Response('[]', { status: 200, headers });
    }) as unknown as typeof fetch;

    const result = await run(fetchImpl);
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
    const fetchImpl = goodEndpoint();
    await run(fetchImpl);
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      String(c[0]),
    );
    const withdrawal = calls.find((url) => url.includes('a0'));
    expect(withdrawal).toContain(`existing_external_id=${ID}`);
  });
});
