import { describe, it, expect } from 'vitest';
import {
  CART_ATTRIBUTE,
  ENDPOINT_ATTRIBUTE,
  IDENTITY_EVENT,
  REVOCATION_MAX_AGE_MS,
  REVOCATION_STORAGE_KEY,
  consentBridgeScript,
} from './consent-bridge';
import { EXTERNAL_ID_COOKIE } from './external-id';

// La revoca che sopravvive a un errore di rete.
//
// Il difetto che questo file sorveglia: alla revoca il ponte cancellava il
// cookie e poi chiamava l'endpoint senza guardare com'era andata. Un 503 o una
// rete che cade lasciavano la riga sul server e l'identificativo sul carrello,
// e il browser perdeva l'unico riferimento con cui chiederne la cancellazione.
//
// Qui la vetrina si "ricarica": ogni `carica()` esegue di nuovo lo script vero,
// con lo stesso localStorage e gli stessi cookie. E' cosi' che si prova il
// "riprova al prossimo caricamento".

const ENDPOINT = 'https://negozio.it/kerdon/id';
const VECCHIO = 'kerdon_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NUOVO = 'kerdon_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

type Risposta =
  | { status: number; retryAfter?: string; body?: unknown }
  | 'rete-giu';

interface Mondo {
  jar: Map<string, string>;
  storage: Map<string, string>;
  now: number;
  /** Le risposte, in ordine, per le chiamate all'endpoint. Finite: poi 200. */
  endpoint: Risposta[];
  /** Le risposte per /cart/update.js. Finite: poi 200. */
  carrello: Risposta[];
  fetches: { url: string; init: RequestInit }[];
}

function mondo(over: Partial<Mondo> = {}): Mondo {
  return {
    jar: new Map(),
    storage: new Map(),
    now: Date.UTC(2026, 8, 27, 12),
    endpoint: [],
    carrello: [],
    fetches: [],
    ...over,
  };
}

function risposta(r: Risposta | undefined, corpoDiDefault: unknown) {
  if (r === 'rete-giu') return Promise.reject(new TypeError('Failed to fetch'));
  const status = r?.status ?? 200;
  const body = r && 'body' in r ? r.body : corpoDiDefault;
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (nome: string) =>
        nome.toLowerCase() === 'retry-after' ? (r?.retryAfter ?? null) : null,
    },
    json: () => Promise.resolve(body),
  });
}

/** Una visita alla vetrina: lo script vero, con lo stato del mondo. */
function carica(
  m: Mondo,
  consenso: { analytics?: 'yes' | 'no'; marketing?: 'yes' | 'no' } = {},
  opzioni: { noStorage?: boolean } = {},
) {
  const timers: { at: number; fn: () => void }[] = [];
  const listeners = new Map<string, () => void>();

  const doc = {
    location: { protocol: 'https:', hostname: 'www.negozio.it' },
    currentScript: {
      getAttribute: (name: string) => (name === ENDPOINT_ATTRIBUTE ? ENDPOINT : null),
    },
    querySelector: () => null,
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
  };
  Object.defineProperty(doc, 'cookie', {
    get: () => [...m.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    set: (raw: string) => {
      const [pair, ...attributes] = raw.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const expired = attributes.some((a) => a.trim().toLowerCase() === 'max-age=0');
      if (expired) m.jar.delete(name);
      else m.jar.set(name, pair.slice(eq + 1));
    },
  });

  const allowed = (v?: string) => v === 'yes';
  const detto = { ...consenso };
  const localStorage = opzioni.noStorage
    ? undefined
    : {
        getItem: (k: string) => (m.storage.has(k) ? m.storage.get(k)! : null),
        setItem: (k: string, v: string) => void m.storage.set(k, String(v)),
        removeItem: (k: string) => void m.storage.delete(k),
      };

  const win: Record<string, unknown> & { dataLayer: Record<string, unknown>[] } = {
    dataLayer: [],
    localStorage,
    Date: { now: () => m.now },
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ at: m.now + ms, fn });
      return timers.length;
    },
    Shopify: {
      customerPrivacy: {
        currentVisitorConsent: () => ({
          analytics: detto.analytics ?? '',
          marketing: detto.marketing ?? '',
        }),
        analyticsProcessingAllowed: () => allowed(detto.analytics),
        marketingAllowed: () => allowed(detto.marketing),
        preferencesProcessingAllowed: () => false,
        saleOfDataAllowed: () => false,
      },
    },
    fetch: (url: string, init: RequestInit = {}) => {
      m.fetches.push({ url, init });
      if (url === '/cart/update.js') return risposta(m.carrello.shift(), {});
      return risposta(m.endpoint.shift(), [{ external_id: NUOVO }]);
    },
  };

  new Function('window', 'document', consentBridgeScript())(win, doc);

  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  return {
    win,
    settle,
    /** Fa passare il tempo, e scatta i timer dovuti. */
    async avanza(ms: number) {
      const fine = m.now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const prossimo = timers[0];
        if (!prossimo || prossimo.at > fine) break;
        timers.shift();
        m.now = prossimo.at;
        prossimo.fn();
        await settle();
      }
      m.now = fine;
    },
    timersInAttesa: () => timers.map((t) => t.at - m.now),
    dichiara(nuovo: { analytics?: 'yes' | 'no'; marketing?: 'yes' | 'no' }) {
      Object.assign(detto, nuovo);
      listeners.get('visitorConsentCollected')?.();
    },
  };
}

const revocazioni = (m: Mondo) =>
  m.fetches.filter(
    (f) => f.url.startsWith(ENDPOINT) && new URL(f.url).searchParams.get('consent')?.includes('0'),
  );
const identita = (m: Mondo) =>
  m.fetches.filter(
    (f) => f.url.startsWith(ENDPOINT) && new URL(f.url).searchParams.get('consent') === 'v1.a1.m1',
  );
const carrelli = (m: Mondo) =>
  m.fetches
    .filter((f) => f.url === '/cart/update.js')
    .map((f) => JSON.parse(String(f.init.body)).attributes[CART_ATTRIBUTE]);
const lapide = (m: Mondo) => m.storage.get(REVOCATION_STORAGE_KEY);

/** Chi aveva l'identificativo e dice di no. */
function revoca(m: Mondo) {
  m.jar.set(EXTERNAL_ID_COOKIE, VECCHIO);
  return carica(m, { analytics: 'no', marketing: 'no' });
}

describe('la revoca ritentabile', () => {
  it('l identificativo smette subito di essere usato, anche se il server non risponde', async () => {
    const m = mondo({ endpoint: ['rete-giu'] });
    const page = revoca(m);
    await page.settle();

    expect(m.jar.has(EXTERNAL_ID_COOKIE)).toBe(false);
    expect(JSON.stringify(page.win.dataLayer)).not.toContain(VECCHIO);
  });

  it('errore di rete: la lapide resta, e al prossimo caricamento si riprova', async () => {
    const m = mondo({ endpoint: ['rete-giu', 'rete-giu', 'rete-giu', 'rete-giu', 'rete-giu'] });
    const page = revoca(m);
    await page.settle();
    await page.avanza(10 * 60_000);

    expect(lapide(m)).toContain(VECCHIO);
    const tentativi = revocazioni(m).length;
    expect(tentativi).toBeGreaterThan(1);

    // Il giorno dopo, su una pagina qualsiasi: nessun consenso letto ancora.
    m.now += 24 * 3600_000;
    m.endpoint = [];
    const dopo = carica(m);
    await dopo.settle();

    const ultima = revocazioni(m).at(-1)!;
    expect(revocazioni(m).length).toBe(tentativi + 1);
    expect(new URL(ultima.url).searchParams.get('existing_external_id')).toBe(VECCHIO);
    expect(new URL(ultima.url).searchParams.get('consent')).toBe('v1.a0.m0');
    expect(lapide(m)).toBeUndefined();
  });

  it('503 con Retry-After: non si richiama prima del tempo detto', async () => {
    const m = mondo({ endpoint: [{ status: 503, retryAfter: '120' }] });
    const page = revoca(m);
    await page.settle();
    expect(revocazioni(m)).toHaveLength(1);

    await page.avanza(119_000);
    expect(revocazioni(m)).toHaveLength(1);

    await page.avanza(2_000);
    expect(revocazioni(m)).toHaveLength(2);
    expect(lapide(m)).toBeUndefined();
  });

  it('Retry-After lungo: si aspetta il prossimo caricamento, e non prima della scadenza', async () => {
    const m = mondo({ endpoint: [{ status: 503, retryAfter: '3600' }] });
    const page = revoca(m);
    await page.settle();
    expect(page.timersInAttesa()).toEqual([]);

    // Ricaricata dopo dieci minuti: il server ha detto un'ora.
    m.now += 10 * 60_000;
    const presto = carica(m);
    await presto.settle();
    expect(revocazioni(m)).toHaveLength(1);

    m.now += 60 * 60_000;
    const dopo = carica(m);
    await dopo.settle();
    expect(revocazioni(m)).toHaveLength(2);
    expect(lapide(m)).toBeUndefined();
  });

  it('500 e poi 200: la lapide si toglie solo alla conferma', async () => {
    const m = mondo({ endpoint: [{ status: 500 }] });
    const page = revoca(m);
    await page.settle();
    expect(lapide(m)).toContain(VECCHIO);

    await page.avanza(60_000);
    expect(revocazioni(m)).toHaveLength(2);
    expect(lapide(m)).toBeUndefined();
  });

  it('429 si ritenta con attesa crescente', async () => {
    const m = mondo({ endpoint: [{ status: 429 }, { status: 429 }] });
    const page = revoca(m);
    await page.settle();
    const primo = page.timersInAttesa()[0];
    await page.avanza(primo);
    const secondo = page.timersInAttesa()[0];
    expect(secondo).toBeGreaterThan(primo);
    await page.avanza(secondo);
    expect(revocazioni(m)).toHaveLength(3);
    expect(lapide(m)).toBeUndefined();
  });

  it('il carrello che non si svuota si riprova al prossimo caricamento', async () => {
    const m = mondo({ carrello: ['rete-giu'] });
    const page = revoca(m);
    await page.settle();
    expect(carrelli(m)).toEqual(['']);
    expect(lapide(m)).toBeDefined();

    const dopo = carica(m);
    await dopo.settle();
    expect(carrelli(m)).toEqual(['', '']);
    expect(lapide(m)).toBeUndefined();
  });

  it('anche un carrello che risponde 500 si riprova', async () => {
    const m = mondo({ carrello: [{ status: 500 }] });
    revoca(m);
    await new Promise((r) => setTimeout(r, 0));
    const dopo = carica(m);
    await dopo.settle();
    expect(carrelli(m)).toEqual(['', '']);
    expect(lapide(m)).toBeUndefined();
  });

  it('con una revoca in sospeso non si conia e non si riusa niente', async () => {
    const m = mondo({ endpoint: [{ status: 503, retryAfter: '3600' }] });
    const page = revoca(m);
    await page.settle();

    // Il visitatore ci ripensa e concede, mentre la revoca e' ancora aperta.
    page.dichiara({ analytics: 'yes', marketing: 'yes' });
    await page.settle();
    expect(identita(m)).toHaveLength(0);

    // E al caricamento successivo, ancora prima della conferma.
    m.now += 60_000;
    const dopo = carica(m, { analytics: 'yes', marketing: 'yes' });
    await dopo.settle();
    expect(identita(m)).toHaveLength(0);
    expect(dopo.win.dataLayer.map((e) => e.event)).not.toContain(IDENTITY_EVENT);
  });

  it('confermata la revoca, il permesso ridato conia un identificativo nuovo, mai il vecchio', async () => {
    const m = mondo({ endpoint: [{ status: 503, retryAfter: '3600' }] });
    revoca(m);
    await new Promise((r) => setTimeout(r, 0));

    m.now += 2 * 3600_000;
    const dopo = carica(m, { analytics: 'yes', marketing: 'yes' });
    await dopo.settle();

    expect(lapide(m)).toBeUndefined();
    expect(identita(m)).toHaveLength(1);
    expect(identita(m)[0].url).not.toContain(VECCHIO);
    expect(JSON.stringify(dopo.win.dataLayer)).not.toContain(VECCHIO);
  });

  it('la lapide non finisce mai in analisi, carrello o identita', async () => {
    const m = mondo({ endpoint: ['rete-giu'] });
    const page = revoca(m);
    await page.settle();
    const dopo = carica(m, { analytics: 'yes', marketing: 'yes' });
    await dopo.settle();

    for (const valore of carrelli(m)) expect(valore).not.toBe(VECCHIO);
    expect(JSON.stringify(page.win.dataLayer)).not.toContain(VECCHIO);
    expect(JSON.stringify(dopo.win.dataLayer)).not.toContain(VECCHIO);
    expect(m.jar.get(EXTERNAL_ID_COOKIE)).not.toBe(VECCHIO);
    for (const f of identita(m)) expect(f.url).not.toContain(VECCHIO);
  });

  it('dopo la conferma non resta nessuna lapide', async () => {
    const m = mondo();
    const page = revoca(m);
    await page.settle();
    expect(revocazioni(m)).toHaveLength(1);
    expect(m.storage.size).toBe(0);
  });

  it('oltre i trenta giorni si rinuncia, e la lapide sparisce', async () => {
    const m = mondo({ endpoint: [{ status: 503, retryAfter: '3600' }] });
    revoca(m);
    await new Promise((r) => setTimeout(r, 0));
    const prima = revocazioni(m).length;

    m.now += REVOCATION_MAX_AGE_MS + 1;
    const dopo = carica(m);
    await dopo.settle();
    expect(revocazioni(m)).toHaveLength(prima);
    expect(lapide(m)).toBeUndefined();
  });

  it('senza localStorage la revoca si ritenta almeno nella pagina', async () => {
    const m = mondo({ endpoint: [{ status: 500 }] });
    m.jar.set(EXTERNAL_ID_COOKIE, VECCHIO);
    const page = carica(m, { analytics: 'no', marketing: 'no' }, { noStorage: true });
    await page.settle();
    await page.avanza(60_000);
    expect(revocazioni(m)).toHaveLength(2);
  });

  it('senza segnale di consenso non si conia niente, lapide o no', async () => {
    const m = mondo();
    const page = carica(m);
    await page.settle();
    expect(m.fetches).toHaveLength(0);
  });
});
