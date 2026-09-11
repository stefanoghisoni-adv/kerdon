import { describe, it, expect, vi } from 'vitest';
import {
  CART_ATTRIBUTE,
  CONSENT_GRANTED_EVENT,
  CONSENT_WITHDRAWN_EVENT,
  ENDPOINT_ATTRIBUTE,
  IDENTITY_EVENT,
  consentBridgeScript,
} from './consent-bridge';
import { EXTERNAL_ID_COOKIE } from './external-id';
import { CONSENT_COOKIE } from './consent';

const ENDPOINT = 'https://negozio.it/kerdon/id';
const ID = 'corew_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

type Answer = 'yes' | 'no' | undefined;

interface Storefront {
  analytics?: Answer;
  marketing?: Answer;
  /** Nessuna Customer Privacy API in pagina: il caso piu' comune di silenzio. */
  noApi?: boolean;
  endpoint?: string | null;
  cookies?: string;
}

/**
 * La vetrina di un negozio, finta quanto basta.
 *
 * Il ponte gira davvero — si esegue lo script vero, non una sua descrizione —
 * dentro una finestra e un documento costruiti qui. E' l'unico modo di provare
 * la cosa che conta: che senza un permesso dichiarato non parta nessuna
 * chiamata.
 */
function run(storefront: Storefront) {
  const jar = new Map<string, string>();
  for (const part of (storefront.cookies ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1));
  }

  const fetches: { url: string; init: RequestInit }[] = [];
  const listeners = new Map<string, () => void>();

  const doc = {
    currentScript: {
      getAttribute: (name: string) =>
        name === ENDPOINT_ATTRIBUTE
          ? (storefront.endpoint === undefined ? ENDPOINT : storefront.endpoint)
          : null,
    },
    querySelector: () => null,
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
  };

  Object.defineProperty(doc, 'cookie', {
    get: () =>
      [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    set: (raw: string) => {
      const [pair, ...attributes] = raw.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const expired = attributes.some((a) => a.trim().toLowerCase() === 'max-age=0');
      if (expired) jar.delete(name);
      else jar.set(name, pair.slice(eq + 1));
    },
  });

  const answered = (value: Answer) => value === 'yes';
  const win = {
    dataLayer: [] as Record<string, unknown>[],
    Shopify: storefront.noApi
      ? {}
      : {
          customerPrivacy: {
            currentVisitorConsent: () => ({
              analytics: storefront.analytics ?? '',
              marketing: storefront.marketing ?? '',
            }),
            analyticsProcessingAllowed: () => answered(storefront.analytics),
            marketingAllowed: () => answered(storefront.marketing),
            preferencesProcessingAllowed: () => false,
            saleOfDataAllowed: () => false,
          },
        },
    fetch: vi.fn((url: string, init: RequestInit = {}) => {
      fetches.push({ url, init });
      return Promise.resolve({
        json: () => Promise.resolve([{ external_id: ID }]),
      });
    }),
  };

  new Function('window', 'document', consentBridgeScript())(win, doc);

  return {
    win,
    jar,
    fetches,
    /** Il banner che risponde: e' l'evento che Shopify spinge in vetrina. */
    consentCollected: () => listeners.get('visitorConsentCollected')?.(),
    /** Le promesse in volo: il ponte chiama e poi legge la risposta. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    events: () => win.dataLayer.map((entry) => entry.event),
    identityCalls: () => fetches.filter((f) => f.url.startsWith(ENDPOINT)),
    cartCalls: () => fetches.filter((f) => f.url === '/cart/update.js'),
  };
}

describe('il ponte in vetrina', () => {
  it('e uno script che si esegue davvero', () => {
    expect(() => new Function(consentBridgeScript())).not.toThrow();
  });

  // La regola che non si puo' rompere: qui dentro non passa nessuna credenziale,
  // perche' questo file lo legge chiunque apra gli strumenti di sviluppo.
  it('non contiene nessuna credenziale, e nemmeno il posto dove metterla', () => {
    const script = consentBridgeScript();
    expect(script).not.toMatch(/apikey/i);
    expect(script).not.toMatch(/authorization/i);
    expect(script).not.toMatch(/bearer/i);
    expect(script).not.toMatch(/spx_/);
  });

  it('parla solo con l endpoint del negozio, non con l app', () => {
    expect(consentBridgeScript()).not.toContain('kerdon.io');
  });

  describe('senza permesso', () => {
    it('chi non ha ancora risposto non fa partire niente', async () => {
      const page = run({});
      await page.settle();
      expect(page.identityCalls()).toHaveLength(0);
      expect(page.cartCalls()).toHaveLength(0);
      expect(page.jar.has(CONSENT_COOKIE)).toBe(false);
    });

    it('senza la Customer Privacy API in pagina, il ponte tace', async () => {
      const page = run({ noApi: true });
      await page.settle();
      expect(page.fetches).toHaveLength(0);
    });

    // Una sola delle due non basta: e' lo stesso identificativo a misurare e ad
    // attribuire, e non se ne conia mezzo.
    it('il permesso su una sola finalita non basta', async () => {
      const page = run({ analytics: 'yes' });
      await page.settle();
      expect(page.identityCalls()).toHaveLength(0);
    });

    it('senza indirizzo dell endpoint non si chiama nessuno', async () => {
      const page = run({ analytics: 'yes', marketing: 'yes', endpoint: null });
      await page.settle();
      expect(page.fetches).toHaveLength(0);
    });

    // Su http l'endpoint non puo' emettere un cookie Secure: meglio non partire.
    it('un indirizzo che non e https viene ignorato', async () => {
      const page = run({
        analytics: 'yes',
        marketing: 'yes',
        endpoint: 'http://negozio.it/kerdon/id',
      });
      await page.settle();
      expect(page.fetches).toHaveLength(0);
    });
  });

  describe('con il permesso', () => {
    it('chiama l endpoint del negozio portando il permesso', async () => {
      const page = run({ analytics: 'yes', marketing: 'yes' });
      await page.settle();

      const [call] = page.identityCalls();
      expect(call.url).toContain('consent=v1.a1.m1');
      expect(call.init.credentials).toBe('include');
    });

    it('attacca l identificativo al carrello: e cosi che risale nell ordine', async () => {
      const page = run({ analytics: 'yes', marketing: 'yes' });
      await page.settle();

      const [cart] = page.cartCalls();
      expect(cart.init.method).toBe('POST');
      expect(JSON.parse(String(cart.init.body))).toEqual({
        attributes: { [CART_ATTRIBUTE]: ID },
      });
    });

    it('annuncia il permesso e poi l identificativo, in quest ordine', async () => {
      const page = run({ analytics: 'yes', marketing: 'yes' });
      await page.settle();
      expect(page.events()).toEqual([CONSENT_GRANTED_EVENT, IDENTITY_EVENT]);
    });

    it('scrive la copia leggibile del permesso sul dominio del negozio', async () => {
      const page = run({ analytics: 'yes', marketing: 'yes' });
      await page.settle();
      // Solo le finalita' dichiarate: quelle su cui il visitatore non si e'
      // espresso non compaiono, invece di comparire come no.
      expect(page.jar.get(CONSENT_COOKIE)).toBe('v1.a1.m1');
    });

    it('rimanda indietro l identificativo che il browser ha gia', async () => {
      const page = run({
        analytics: 'yes',
        marketing: 'yes',
        cookies: `${EXTERNAL_ID_COOKIE}=${ID}`,
      });
      await page.settle();
      expect(page.identityCalls()[0].url).toContain(`existing_external_id=${ID}`);
    });
  });

  describe('alla revoca', () => {
    const revoked = () =>
      run({
        analytics: 'no',
        marketing: 'no',
        cookies: `${EXTERNAL_ID_COOKIE}=${ID}`,
      });

    it('lo dice all endpoint, che e l unico che puo disfare la sua parte', async () => {
      const page = revoked();
      await page.settle();
      expect(page.identityCalls()[0].url).toContain('consent=v1.a0.m0');
    });

    it('toglie l identificativo dal browser', async () => {
      const page = revoked();
      await page.settle();
      expect(page.jar.has(EXTERNAL_ID_COOKIE)).toBe(false);
    });

    it('svuota l attributo del carrello', async () => {
      const page = revoked();
      await page.settle();
      expect(JSON.parse(String(page.cartCalls()[0].init.body))).toEqual({
        attributes: { [CART_ATTRIBUTE]: '' },
      });
    });

    it('annuncia la revoca', async () => {
      const page = revoked();
      await page.settle();
      expect(page.events()).toContain(CONSENT_WITHDRAWN_EVENT);
    });
  });

  // Un tag che parte due volte conta due volte: l'evento e' "e' cambiato", non
  // "e' cosi'". E il banner ripete l'evento a ogni navigazione.
  it('lo stesso permesso non si riannuncia', async () => {
    const page = run({ analytics: 'yes', marketing: 'yes' });
    await page.settle();

    page.consentCollected();
    page.consentCollected();
    await page.settle();

    expect(page.identityCalls()).toHaveLength(1);
    expect(page.events()).toEqual([CONSENT_GRANTED_EVENT, IDENTITY_EVENT]);
  });

  it('un permesso che cambia invece si riannuncia', async () => {
    const page = run({ analytics: 'yes', marketing: 'yes' });
    await page.settle();

    // Il visitatore torna sul banner e revoca.
    page.win.Shopify.customerPrivacy!.currentVisitorConsent = () => ({
      analytics: 'no' as const,
      marketing: 'no' as const,
    });
    page.win.Shopify.customerPrivacy!.analyticsProcessingAllowed = () => false;
    page.win.Shopify.customerPrivacy!.marketingAllowed = () => false;

    page.consentCollected();
    await page.settle();

    expect(page.events()).toContain(CONSENT_WITHDRAWN_EVENT);
  });
});
