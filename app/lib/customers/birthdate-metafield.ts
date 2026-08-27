/**
 * La data di nascita del cliente: dove vive su Shopify.
 *
 * Shopify non ha un campo "data di nascita" nell'anagrafica del cliente, quindi
 * il posto dove metterla va creato: e' un metafield del cliente, e questo file
 * ne descrive la forma esatta. Sta in un modulo a se' perche' gli stessi quattro
 * valori servono in tre punti lontani fra loro — chi crea la definizione, chi
 * chiede il valore nella query dei clienti, chi lo scrive nel database del
 * merchant — e se uno solo dei tre battesse una chiave diversa il campo
 * risulterebbe sempre vuoto senza che niente segnali un errore.
 */

/** Namespace e chiave: insieme fanno `custom.data_di_nascita`. */
export const BIRTHDATE_METAFIELD = {
  namespace: 'custom',
  key: 'data_di_nascita',
  name: 'Data di nascita',
  description: 'Data di nascita del cliente',
  /**
   * `date` e non `list.date`: una persona nasce una volta sola. Il tipo a lista
   * darebbe un valore JSON (`["1985-04-23"]`) che nessuna delle piattaforme
   * pubblicitarie sa leggere.
   */
  type: 'date',
} as const;

/**
 * Le opzioni della definizione, nella forma che vuole `metafieldDefinitionCreate`.
 *
 * Sono le stesse che il merchant ha impostato a mano sul suo negozio, e vanno
 * riprodotte identiche: una definizione creata dall'app con opzioni diverse
 * darebbe un campo che si comporta in un modo su un negozio e in un altro
 * altrove.
 *
 * `access.admin` NON si tocca di proposito: su un namespace non riservato
 * all'app Shopify rifiuta l'input (`ADMIN_ACCESS_INPUT_NOT_ALLOWED`), e il
 * valore predefinito e' gia' quello giusto — il merchant legge e scrive il
 * campo dalla scheda del cliente.
 */
export const BIRTHDATE_METAFIELD_OPTIONS = {
  /** Il campo compare in cima alla scheda cliente, senza doverlo cercare. */
  pin: true,
  access: {
    /** Leggibile dalla vetrina: serve a chi personalizza il tema. */
    storefront: 'PUBLIC_READ',
    /** Il cliente puo' leggerla e correggerla dal proprio account. */
    customerAccount: 'READ_WRITE',
  },
  capabilities: {
    /** "Filtra o raggruppa i dati in Analisi" nella schermata dell'admin. */
    analyticsQueryable: { enabled: true },
  },
} as const;

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
 * Il namespace sottinteso quando il merchant incolla la sola chiave.
 *
 * `custom` e' quello che l'admin di Shopify usa per le definizioni create dal
 * merchant: chi scrive "data_di_nascita" e basta sta quasi certamente parlando
 * del suo campo li' dentro. Se cosi' non fosse, la tendina elenca i campi veri
 * del negozio con il namespace scritto per intero, e da li' non si sbaglia.
 */
const DEFAULT_NAMESPACE = 'custom';

/**
 * Divide quello che il merchant ha incollato in namespace e chiave.
 *
 * Il gesto che si vuole assecondare e' preciso: nell'admin, sotto il nome della
 * definizione, Shopify mostra `custom.data_di_nascita` con accanto un pulsante
 * che la copia. Il merchant la incolla, e deve funzionare — anche con uno
 * spazio davanti, anche se e' finita in maiuscolo.
 *
 * Si divide sul PRIMO punto: nessuno dei due pezzi puo' contenerne, quindi non
 * c'e' ambiguita' da risolvere. Un secondo punto e' un errore di battitura, non
 * una chiave con un punto dentro, e vale come valore non valido.
 *
 * `null` quando non se ne cava una coppia utilizzabile: meglio dire al merchant
 * che quella stringa non va bene, che salvarne una interpretata a naso e
 * lasciarlo davanti a una colonna che resta vuota senza motivo apparente.
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

/** La forma leggibile, quella che l'admin mostra: `custom.data_di_nascita`. */
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
