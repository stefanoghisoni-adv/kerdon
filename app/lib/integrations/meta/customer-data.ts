import { createHash } from 'node:crypto';

/**
 * I dati con cui Meta riconosce la persona dietro un evento.
 *
 * La Conversions API non riceve un nome e un'email in chiaro: riceve la loro
 * impronta. Meta calcola la stessa impronta sui dati che ha, e se coincidono
 * l'evento viene attribuito. Perche' coincida, pero', il testo va normalizzato
 * allo stesso modo da entrambe le parti — ed e' quasi tutto il lavoro di questo
 * file: minuscolo, spazi via, prefissi via, il paese in due lettere.
 *
 * Due valori fanno eccezione e NON si cifrano: `fbp` e `fbc`, il cookie del
 * pixel e l'identificativo del clic. Non sono dati personali dichiarati dalla
 * persona ma riferimenti che Meta stessa ha creato, e cifrarli li renderebbe
 * inservibili.
 */

export interface CustomerData {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  /** Provincia o stato: "MI", "California". */
  state?: string | null;
  /** Il paese, in qualunque forma arrivi: si riduce a due lettere. */
  country?: string | null;
  zip?: string | null;
  /** L'id del cliente sul negozio: nostro, sempre disponibile. */
  externalId?: string | number | null;
  /** Cookie del pixel, dal browser. */
  fbp?: string | null;
  /** Identificativo del clic, da fbclid. */
  fbc?: string | null;
}

/** Il payload come la Conversions API se lo aspetta. */
export interface MetaUserData {
  em?: string[];
  ph?: string[];
  fn?: string[];
  ln?: string[];
  ct?: string[];
  st?: string[];
  zp?: string[];
  country?: string[];
  external_id?: string[];
  fbp?: string;
  fbc?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Minuscolo e senza spazi ai lati: la base di quasi ogni campo. */
function plain(value: string | null | undefined): string | null {
  const text = (value ?? '').trim().toLowerCase();
  return text === '' ? null : text;
}

/**
 * Nomi, citta' e province: via anche la punteggiatura e gli spazi interni.
 *
 * "De Luca" e "deluca" devono produrre la stessa impronta, altrimenti met
 * dei clienti non verrebbe riconosciuta per un apostrofo.
 */
function name(value: string | null | undefined): string | null {
  const text = plain(value);
  if (!text) return null;
  const cleaned = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  return cleaned === '' ? null : cleaned;
}

/** Solo cifre, con il prefisso internazionale attaccato davanti. */
function phone(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return digits === '' ? null : digits;
}

/**
 * Il paese in due lettere minuscole.
 *
 * Shopify lo da' gia' cosi', ma un ordine importato o scritto a mano puo'
 * portare "Italia" o "IT ": tre lettere o piu' significano che non e' un codice,
 * e mandare "italia" a Meta equivale a non mandare niente.
 */
function country(value: string | null | undefined): string | null {
  const text = plain(value);
  if (!text) return null;
  return text.length === 2 ? text : null;
}

/** Il CAP: cifre e lettere, senza spazi — "SW1A 1AA" diventa "sw1a1aa". */
function zip(value: string | null | undefined): string | null {
  const text = plain(value)?.replace(/\s+/g, '') ?? null;
  return text === '' ? null : text;
}

/** Un valore cifrato dentro l'elenco che Meta si aspetta, o niente. */
function hashed(value: string | null): string[] | undefined {
  return value == null ? undefined : [sha256(value)];
}

/**
 * Da quel che sappiamo del cliente al payload di Meta.
 *
 * I campi assenti restano assenti: mandare una stringa vuota cifrata vorrebbe
 * dire mandare l'impronta del nulla, che non corrisponde a nessuno e sporca il
 * punteggio di qualita' del match.
 */
export function toMetaUserData(data: CustomerData): MetaUserData {
  const payload: MetaUserData = {
    em: hashed(plain(data.email)),
    ph: hashed(phone(data.phone)),
    fn: hashed(name(data.firstName)),
    ln: hashed(name(data.lastName)),
    ct: hashed(name(data.city)),
    st: hashed(name(data.state)),
    zp: hashed(zip(data.zip)),
    country: hashed(country(data.country)),
    external_id: hashed(plain(data.externalId == null ? null : String(data.externalId))),
    // Non cifrati: sono riferimenti creati da Meta, non dati dichiarati dalla
    // persona. Cifrarli li renderebbe inservibili.
    fbp: data.fbp?.trim() || undefined,
    fbc: data.fbc?.trim() || undefined,
  };

  // Via le chiavi vuote: un oggetto con dieci `undefined` dentro viaggia
  // comunque nel JSON di alcune serializzazioni, e Meta conta i campi mandati.
  for (const key of Object.keys(payload) as (keyof MetaUserData)[]) {
    if (payload[key] === undefined) delete payload[key];
  }

  return payload;
}

/**
 * Quanti dei parametri utili sono stati davvero mandati.
 *
 * Meta assegna un punteggio alla qualita' del match: piu' campi coincidono,
 * meglio attribuisce. Questo conteggio serve a poterlo dire al merchant senza
 * fargli aprire Gestione eventi.
 */
export function matchParameterCount(payload: MetaUserData): number {
  return Object.keys(payload).length;
}
