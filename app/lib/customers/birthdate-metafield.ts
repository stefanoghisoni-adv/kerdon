/**
 * La data di nascita del cliente: dove vive su Shopify.
 *
 * Non e' un campo dell'anagrafica, ma non e' nemmeno un campo da inventare:
 * Shopify ne prevede gia' uno suo, `facts.birth_date`, che tutto l'ecosistema
 * — temi, app, segmenti, automazioni — sa gia' leggere. Usare quello invece di
 * un campo nostro e' la differenza fra una data che serve anche fuori da questa
 * app e una che serve solo dentro.
 *
 * `facts` e' un namespace riservato: le sue definizioni non si creano, si
 * abilitano. La conseguenza pratica e' che nome e descrizione non li scriviamo
 * noi — li mette Shopify, gia' tradotti nella lingua del negozio — ed e'
 * esattamente il comportamento voluto: su un negozio inglese il campo si chiama
 * "Date of birth", su uno italiano "Data di nascita", senza che nessuno debba
 * scegliere.
 *
 * Questo modulo sta a se' perche' gli stessi due valori servono in punti lontani
 * fra loro — chi abilita la definizione, chi chiede il valore nella query dei
 * clienti, chi lo scrive nel database del merchant — e se uno solo dei tre
 * battesse una chiave diversa il campo risulterebbe sempre vuoto senza che
 * niente segnali un errore.
 */

/** Namespace e chiave della definizione standard: insieme fanno `facts.birth_date`. */
export const BIRTHDATE_METAFIELD = {
  namespace: 'facts',
  key: 'birth_date',
  /**
   * `date` e non `date_time`: una persona nasce in un giorno, non a un'ora. E'
   * anche il tipo che Shopify ha dato alla definizione standard, quindi qui non
   * c'e' niente da scegliere — c'e' da non sbagliare.
   */
  type: 'date',
} as const;

/**
 * Gli accessi della definizione, nella forma che vuole
 * `standardMetafieldDefinitionEnable`.
 *
 * `admin` NON si tocca di proposito: su una definizione standard il livello
 * amministratore lo decide Shopify, e mandarlo lo fa rifiutare l'input.
 */
export const BIRTHDATE_METAFIELD_ACCESS = {
  /** Leggibile dalla vetrina: serve a chi personalizza il tema. */
  storefront: 'PUBLIC_READ',
  /** Il cliente puo' leggerla e correggerla dal proprio account. */
  customerAccount: 'READ_WRITE',
} as const;

/**
 * Gli interruttori che vorremmo accesi sulla definizione.
 *
 * "Vorremmo" e non "vogliamo": le capability non esistono tutte in tutte le
 * versioni dell'API, e mandarne una che la versione in uso non conosce non la
 * ignora — fa fallire l'intera mutation prima ancora di eseguirla. E' successo
 * con `analyticsQueryable`, che la documentazione mostra ma che la 2026-07
 * rifiuta con "Field is not defined on MetafieldCapabilityCreateInput". Da qui
 * la regola che segue: si chiede all'API stessa cosa accetta, e si manda solo
 * quello.
 */
export const BIRTHDATE_METAFIELD_CAPABILITIES: Record<string, { enabled: boolean }> = {
  /** "Filtra o raggruppa i dati in Analisi" nella schermata dell'admin. */
  analyticsQueryable: { enabled: true },
};

/**
 * Le sole capability che la versione dell'API in uso dichiara di conoscere.
 *
 * Meglio una definizione con un interruttore in meno che una mutation che non
 * parte: il campo che serve al merchant e' il campo, non l'interruttore.
 * `undefined` quando non ne resta nessuna, cosi' chi compone la mutation puo'
 * omettere l'argomento invece di mandarne uno vuoto.
 */
export function supportedCapabilities(
  wanted: Record<string, { enabled: boolean }>,
  supported: ReadonlySet<string> | null | undefined,
): Record<string, { enabled: boolean }> | undefined {
  if (!supported) return undefined;
  const kept = Object.entries(wanted).filter(([name]) => supported.has(name));
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/** Namespace e chiave di un metafield, gia' divisi. */
export interface MetafieldKey {
  namespace: string;
  key: string;
}

/**
 * I caratteri che Shopify ammette in un namespace e in una chiave: lettere,
 * cifre, trattino basso e trattino. Nient'altro — in particolare nessun punto,
 * ed e' proprio questo che rende il primo punto un separatore sicuro.
 */
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Il namespace sottinteso quando manca del tutto.
 *
 * `custom` e' quello che l'admin di Shopify usa per le definizioni create dal
 * merchant: una chiave nuda quasi certamente sta li' dentro. Resta un ripiego,
 * non una strada: i campi che il merchant puo' scegliere arrivano dall'elenco
 * del suo negozio, e li' il namespace c'e' sempre scritto per intero.
 */
const DEFAULT_NAMESPACE = 'custom';

/**
 * Divide una chiave per intero in namespace e chiave.
 *
 * Si divide sul PRIMO punto: nessuno dei due pezzi puo' contenerne, quindi non
 * c'e' ambiguita' da risolvere. Un secondo punto e' un errore, non una chiave
 * annidata.
 *
 * `null` quando non se ne cava una coppia utilizzabile: meglio rifiutare, che
 * salvarne una interpretata a naso e lasciare il merchant davanti a una colonna
 * che resta vuota senza motivo apparente.
 */
export function parseMetafieldKey(value: string | null | undefined): MetafieldKey | null {
  const text = (value ?? '').trim();
  if (!text) return null;

  const dot = text.indexOf('.');
  const namespace = dot === -1 ? DEFAULT_NAMESPACE : text.slice(0, dot);
  const key = dot === -1 ? text : text.slice(dot + 1);

  if (!SEGMENT.test(namespace) || !SEGMENT.test(key)) return null;
  // I limiti di Shopify: oltre, la chiave non esiste su nessun negozio.
  if (namespace.length > 255 || key.length > 64) return null;

  return { namespace, key };
}

/** La forma leggibile, quella che l'admin mostra: `facts.birth_date`. */
export function formatMetafieldKey(field: MetafieldKey | null | undefined): string {
  return field ? `${field.namespace}.${field.key}` : '';
}

/**
 * I tipi di metafield che contengono una data vera.
 *
 * Puntare la colonna a un campo di testo e' permesso — il merchant sa cosa ci
 * tiene dentro — ma va detto: da un testo libero la data si ricava solo se
 * quello che c'e' scritto e' riconoscibile, e quello che non lo e' lascia la
 * colonna vuota invece di finirci dentro convertito a caso.
 */
const DATE_TYPES = new Set(['date', 'date_time']);

export function isDateMetafieldType(type: string | null | undefined): boolean {
  return DATE_TYPES.has((type ?? '').trim().toLowerCase());
}

/** La nostra definizione, nella forma divisa che usa il resto del codice. */
export const BIRTHDATE_METAFIELD_KEY: MetafieldKey = {
  namespace: BIRTHDATE_METAFIELD.namespace,
  key: BIRTHDATE_METAFIELD.key,
};

/**
 * Il metafield configurato per un negozio, o `null` se non ne ha scelto uno.
 *
 * Prende la riga del negozio e non il dominio: chi sincronizza ce l'ha gia' in
 * mano, e una lettura in piu' sul database per due colonne che sono li' sarebbe
 * un giro a vuoto per ogni corsa.
 */
export function birthdateMetafieldOf(
  shop: {
    birthdateMetafieldNamespace?: string | null;
    birthdateMetafieldKey?: string | null;
  } | null
    | undefined,
): MetafieldKey | null {
  const namespace = shop?.birthdateMetafieldNamespace?.trim();
  const key = shop?.birthdateMetafieldKey?.trim();
  if (!namespace || !key) return null;
  return { namespace, key };
}

/**
 * Cosa dire del campo configurato: e' davvero in uso, o e' rimasta solo la
 * scelta?
 *
 * Sono tre stati e non due, e la differenza conta. "Nessuno" e' chi non ha
 * ancora scelto. "In uso" e' chi ha scelto un campo che sul negozio c'e'
 * davvero. "Sparito" e' chi ha scelto un campo che sul negozio non esiste (o
 * non esiste piu'): annunciarlo come attivo sarebbe la bugia piu' facile di
 * questa card — il merchant crederebbe di star sincronizzando una data che non
 * arrivera' mai.
 *
 * `definitions` a `null` significa che l'elenco del negozio non si e' potuto
 * leggere: in quel caso non si smentisce niente, perche' non sapere non e' lo
 * stesso che sapere di no.
 */
export type BirthdateFieldState = 'none' | 'in_use' | 'missing';

export function birthdateFieldState(
  configured: string,
  definitionKeys: readonly string[] | null,
): BirthdateFieldState {
  if (!configured.trim()) return 'none';
  if (definitionKeys == null) return 'in_use';
  return definitionKeys.includes(configured) ? 'in_use' : 'missing';
}
