import { KLAVIYO_REVISION } from './config.server';

const API_BASE = 'https://a.klaviyo.com/api';

/** Klaviyo ha detto no al token (401/403): serve ricollegare. */
export class KlaviyoAuthError extends Error {
  constructor(message = 'Klaviyo ha rifiutato il token') {
    super(message);
    this.name = 'KlaviyoAuthError';
  }
}

/** Klaviyo non risponde, o ci chiede di rallentare, anche dopo i tentativi. */
export class KlaviyoUnavailableError extends Error {
  constructor(message = 'Klaviyo non disponibile') {
    super(message);
    this.name = 'KlaviyoUnavailableError';
  }
}

export interface KlaviyoProfile {
  id: string;
  email: string | null;
  phone: string | null;
  /** ISO 3166-1 alpha-2 da `attributes.location.country`, null se non riconoscibile. */
  countryCode: string | null;
  shopifyCustomerId: number | null;
  properties: Record<string, unknown>;
}

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

/**
 * Il massimo che si aspetta per un singolo `Retry-After`. Una tappa della coda
 * dura pochi minuti: una pausa piu' lunga la farebbe staccare a meta' pagina.
 * Se Klaviyo chiede di piu', si cede subito e ritenta la coda, piu' tardi.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Una GET verso Klaviyo con i tentativi.
 *
 * 429 e 5xx (e la rete giu') si ritentano: si aspetta quanto dice
 * `Retry-After` (secondi, come da documentazione, al massimo 30: oltre si cede
 * subito) oppure 1/2/4/8 s. Al quinto
 * tentativo andato male: `KlaviyoUnavailableError`. 401/403 non si ritentano.
 */
async function klaviyoGet(token: string, url: string, sleep: Sleep): Promise<unknown> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          accept: 'application/vnd.api+json',
          revision: KLAVIYO_REVISION,
        },
      });
    } catch {
      res = null;
    }

    if (res) {
      if (res.status === 401 || res.status === 403) {
        throw new KlaviyoAuthError(`Klaviyo ha rifiutato il token (${res.status})`);
      }
      if (res.ok) return res.json();
      if (res.status !== 429 && res.status < 500) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Richiesta Klaviyo fallita (${res.status}): ${detail}`);
      }
    }

    if (attempt === MAX_ATTEMPTS - 1) break;
    const retryAfter = Number(res?.headers.get('Retry-After'));
    const wait =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BACKOFF_MS[attempt];
    if (wait > MAX_RETRY_AFTER_MS) {
      throw new KlaviyoUnavailableError(`Klaviyo chiede di attendere ${Math.ceil(wait / 1000)} s`);
    }
    await sleep(wait);
  }
  throw new KlaviyoUnavailableError(`Klaviyo non risponde dopo ${MAX_ATTEMPTS} tentativi`);
}

// --- Paesi ------------------------------------------------------------------

function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Nomi comuni che le DisplayNames non coprono. */
const ALIASES: Record<string, string> = {
  usa: 'US',
  'united states of america': 'US',
  us: 'US',
  uk: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  holland: 'NL',
  'stati uniti d america': 'US',
  'czech republic': 'CZ',
  'south korea': 'KR',
  russia: 'RU',
};

/** Regioni che ICU conosce ma non sono paesi. `XK` (Kosovo) resta: Shopify lo usa. */
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'ZZ', 'XA', 'XB']);

/**
 * Scarta i codici deprecati (`UK`, `YU`, `BU`...): ICU li conosce e li
 * nomina come il paese attuale, e senza questo filtro "United Kingdom"
 * finirebbe su `UK` invece che su `GB`.
 */
function isCanonicalRegion(code: string): boolean {
  try {
    return Intl.getCanonicalLocales(`und-${code}`)[0] === `und-${code}`;
  } catch {
    return false;
  }
}

let countryIndex: { names: Map<string, string>; codes: Set<string> } | null = null;

/**
 * L'indice nome → codice, costruito una volta dalle tabelle ICU di Node in
 * inglese e italiano: Klaviyo scrive il paese come lo ha ricevuto (di solito
 * il nome inglese dall'integrazione Shopify, ma da form e CSV arriva di tutto).
 */
function buildCountryIndex(): { names: Map<string, string>; codes: Set<string> } {
  const names = new Map<string, string>();
  const codes = new Set<string>();
  const displays = ['en', 'it'].map(
    (locale) => new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' }),
  );
  const A = 'A'.charCodeAt(0);
  for (let i = 0; i < 26; i++) {
    for (let j = 0; j < 26; j++) {
      const code = String.fromCharCode(A + i, A + j);
      if (NOT_COUNTRIES.has(code) || !isCanonicalRegion(code)) continue;
      let known = false;
      for (const d of displays) {
        let name: string | undefined;
        try {
          name = d.of(code);
        } catch {
          name = undefined;
        }
        if (name && name !== code) {
          known = true;
          names.set(normalizeName(name), code);
        }
      }
      if (known) codes.add(code);
    }
  }
  for (const [alias, code] of Object.entries(ALIASES)) names.set(alias, code);
  return { names, codes };
}

export function toCountryCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  countryIndex ??= buildCountryIndex();
  // Prima gli alias: `UK` non e' un codice ISO ma e' come lo scrivono tutti.
  const alias = ALIASES[normalizeName(trimmed)];
  if (alias) return alias;
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const code = trimmed.toUpperCase();
    if (countryIndex.codes.has(code)) return code;
  }
  return countryIndex.names.get(normalizeName(trimmed)) ?? null;
}

// --- Profili ----------------------------------------------------------------

interface RawProfile {
  id: string;
  attributes?: {
    email?: string | null;
    phone_number?: string | null;
    external_id?: string | null;
    location?: { country?: string | null } | null;
    properties?: Record<string, unknown> | null;
  };
}

/**
 * `external_id` e' l'unico campo del profilo che puo' portare un ID esterno:
 * l'integrazione Shopify di Klaviyo non espone l'ID cliente Shopify negli
 * attributi del profilo. Vale solo se e' un intero.
 */
function toShopifyCustomerId(externalId: string | null | undefined): number | null {
  if (!externalId || !/^\d+$/.test(externalId.trim())) return null;
  const n = Number(externalId.trim());
  return Number.isSafeInteger(n) ? n : null;
}

function mapProfile(raw: RawProfile): KlaviyoProfile {
  const a = raw.attributes ?? {};
  return {
    id: raw.id,
    email: a.email ?? null,
    phone: a.phone_number ?? null,
    countryCode: toCountryCode(a.location?.country ?? null),
    shopifyCustomerId: toShopifyCustomerId(a.external_id),
    properties: a.properties ?? {},
  };
}

/**
 * Il cursore e' l'URL completo di `links.next`. Prima di mandarci il token si
 * controlla che punti davvero a Klaviyo.
 */
function assertKlaviyoUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Cursore Klaviyo non valido');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'a.klaviyo.com') {
    throw new Error('Cursore Klaviyo fuori dominio');
  }
}

export async function listProfiles(
  token: string,
  cursor: string | null,
  opts: { sleep?: Sleep } = {},
): Promise<{ profiles: KlaviyoProfile[]; next: string | null }> {
  let url: string;
  if (cursor) {
    assertKlaviyoUrl(cursor);
    url = cursor;
  } else {
    url = `${API_BASE}/profiles?${new URLSearchParams({ 'page[size]': '100' }).toString()}`;
  }
  const json = (await klaviyoGet(token, url, opts.sleep ?? defaultSleep)) as {
    data?: RawProfile[];
    links?: { next?: string | null };
  };
  return {
    profiles: (json.data ?? []).map(mapProfile),
    next: json.links?.next ?? null,
  };
}

const MAX_SAMPLES_PER_KEY = 5;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

/** Le chiavi custom presenti sui primi `max` profili, con fino a 5 esempi ciascuna. */
export async function sampleProperties(
  token: string,
  max = 300,
): Promise<{ keys: string[]; samples: Record<string, unknown[]> }> {
  // Map e non oggetti: le chiavi sono nomi scelti da chi scrive su Klaviyo, e
  // un `__proto__` o un `constructor` in un oggetto letterale toccherebbe il
  // prototipo invece di diventare una chiave come le altre.
  const samples = new Map<string, unknown[]>();
  const seen = new Map<string, Set<string>>();
  let read = 0;
  let cursor: string | null = null;

  do {
    const page = await listProfiles(token, cursor);
    for (const profile of page.profiles.slice(0, max - read)) {
      for (const [key, value] of Object.entries(profile.properties)) {
        let values = samples.get(key);
        let fingerprints = seen.get(key);
        if (!values || !fingerprints) {
          values = [];
          fingerprints = new Set();
          samples.set(key, values);
          seen.set(key, fingerprints);
        }
        if (isEmpty(value) || values.length >= MAX_SAMPLES_PER_KEY) continue;
        const fingerprint = JSON.stringify(value);
        if (fingerprints.has(fingerprint)) continue;
        fingerprints.add(fingerprint);
        values.push(value);
      }
    }
    read += Math.min(page.profiles.length, max - read);
    cursor = page.next;
  } while (cursor && read < max);

  // `Object.fromEntries` definisce proprieta' proprie: anche `__proto__` resta
  // una chiave qualunque.
  return { keys: [...samples.keys()].sort(), samples: Object.fromEntries(samples) };
}

export async function accountName(token: string): Promise<string | null> {
  const json = (await klaviyoGet(token, `${API_BASE}/accounts`, defaultSleep)) as {
    data?: { attributes?: { contact_information?: { organization_name?: string | null } } }[];
  };
  return json.data?.[0]?.attributes?.contact_information?.organization_name || null;
}
