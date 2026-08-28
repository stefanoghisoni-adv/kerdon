import { availability, feedTitle, productLink, type FeedProduct } from './meta';

/**
 * Il catalogo, come lo vuole Google.
 *
 * Meta si accontenta di poco e indovina il resto. Google no: chiede una
 * ventina di campi, alcuni con nomi che su Shopify non esistono (`gtin`,
 * `mpn`, `identifier_exists`), e quando un campo obbligatorio manca non scarta
 * la riga — segnala il prodotto come "non approvato" e lo tiene fuori dagli
 * annunci finche' non lo si sistema.
 *
 * Da qui la differenza con Meta: qui la corrispondenza fra colonna del catalogo
 * e campo di Google non si puo' decidere una volta per tutte. Un negozio ha il
 * codice a barre nel campo giusto, un altro lo tiene nello SKU, un terzo non ce
 * l'ha affatto. Il merchant sceglie, e questo file gli dice da dove partire.
 */

/** Le colonne del catalogo del merchant che hanno senso in un feed. */
export const VARIABLES = [
  'product_title',
  'variant_title',
  'title_with_variant',
  'product_description',
  'vendor',
  'product_type',
  'handle',
  'sku',
  'barcode',
  'price',
  'compare_at_price',
  /**
   * Il prezzo pieno: il prezzo di confronto se c'e', altrimenti il prezzo.
   *
   * Google e Shopify chiamano "prezzo" due cose diverse. Per Shopify `price` e'
   * quello che il cliente paga adesso e `compare_at_price` il pieno barrato;
   * per Google `price` e' il listino e `sale_price` lo sconto in corso, che
   * DEVE essere il minore dei due. Mandare il prezzo di confronto su
   * `sale_price` mette il numero piu' alto nel campo dello sconto, e Google
   * scarta l'articolo.
   *
   * Il ribaltamento giusto — pieno su `price`, scontato su `sale_price` — non si
   * puo' fare con le due colonne cosi' come sono: il prezzo di confronto e'
   * vuoto su tutti i prodotti non scontati, e `price` per Google e'
   * obbligatorio. Quindi la si ricava: mai vuota, e pari al prezzo quando
   * sconto non ce n'e'.
   */
  'list_price',
  /**
   * Il prezzo scontato: il prezzo, ma solo quando uno sconto esiste davvero.
   *
   * Vuota quando manca il prezzo di confronto, ed e' voluto: per Google un
   * `sale_price` assente vuol dire "nessuna promozione", mentre uno pari al
   * prezzo dichiarerebbe uno sconto dello zero per cento — che e' una
   * promozione finta, e le promozioni finte Google le contesta.
   */
  'discounted_price',
  'image_url',
  'option1',
  'option2',
  'option3',
  'tags',
  'weight',
  'inventory_quantity',
  'shopify_product_id',
  'shopify_variant_id',
  /** Non una colonna: l'indirizzo pubblico, che si compone da dominio e handle. */
  'product_link',
  /** Non una colonna: disponibile / esaurito, dedotto dal magazzino. */
  'availability_state',
  /** Costante: Google vuole "new" per un negozio che vende prodotti nuovi. */
  'condition_new',
  /** Niente: il campo resta fuori dal file. */
  'none',
] as const;

export type Variable = (typeof VARIABLES)[number];

/**
 * Il prodotto e' in sconto: c'e' un prezzo di confronto e supera il prezzo.
 *
 * Il confronto non e' pignoleria. Shopify lascia salvare un prezzo di confronto
 * uguale o minore del prezzo — capita riportando un prodotto a listino pieno
 * senza svuotare il campo — e in quel caso di sconto non ce n'e': trattarlo come
 * tale darebbe a Google uno sconto nullo o negativo.
 */
function hasDiscount(product: FeedProduct): boolean {
  const full = Number(product.compare_at_price);
  const now = Number(product.price);
  return Number.isFinite(full) && Number.isFinite(now) && full > now;
}

export function isVariable(value: string): value is Variable {
  return (VARIABLES as readonly string[]).includes(value);
}

/** Un campo del feed di Google. */
export interface GmcField {
  /** Il nome che Google si aspetta nel file. */
  name: string;
  /** Senza, il prodotto non viene approvato. */
  required: boolean;
  /**
   * La variabile da cui partire.
   *
   * Non e' una preferenza: e' la corrispondenza che Google stessa documenta per
   * chi esporta da Shopify. Chi non ha motivo di cambiarla non deve toccarla.
   */
  suggested: Variable;
}

export const GMC_FIELDS: GmcField[] = [
  { name: 'id', required: true, suggested: 'shopify_variant_id' },
  { name: 'title', required: true, suggested: 'title_with_variant' },
  { name: 'description', required: true, suggested: 'product_description' },
  { name: 'link', required: true, suggested: 'product_link' },
  { name: 'image_link', required: true, suggested: 'image_url' },
  { name: 'availability', required: true, suggested: 'availability_state' },
  { name: 'price', required: true, suggested: 'list_price' },
  { name: 'condition', required: true, suggested: 'condition_new' },
  // Marca e codici: Google li chiede insieme, e ne bastano due su tre. Senza
  // nessuno dei tre il prodotto entra ma non partecipa alle corrispondenze,
  // cioe' non compare quando qualcuno cerca il prodotto per nome.
  { name: 'brand', required: true, suggested: 'vendor' },
  { name: 'gtin', required: false, suggested: 'barcode' },
  { name: 'mpn', required: false, suggested: 'sku' },
  { name: 'sale_price', required: false, suggested: 'discounted_price' },
  { name: 'item_group_id', required: false, suggested: 'shopify_product_id' },
  { name: 'product_type', required: false, suggested: 'product_type' },
  { name: 'shipping_weight', required: false, suggested: 'weight' },
  { name: 'custom_label_0', required: false, suggested: 'none' },
  { name: 'custom_label_1', required: false, suggested: 'none' },
];

/** La mappatura di partenza: quella suggerita, campo per campo. */
export function defaultMapping(): Record<string, Variable> {
  return Object.fromEntries(GMC_FIELDS.map((field) => [field.name, field.suggested]));
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * Il valore di una variabile, per un prodotto.
 *
 * Le tre variabili che non sono colonne — link, disponibilita', condizione —
 * si calcolano qui: sono le stesse che il feed di Meta gia' costruisce, e
 * farle scegliere al merchant come le altre evita di spiegargli perche' quelle
 * tre no.
 */
export function valueOf(
  variable: Variable,
  product: FeedProduct,
  opts: { domain: string; currency: string },
): string {
  switch (variable) {
    case 'none':
      return '';
    case 'title_with_variant':
      return feedTitle(product);
    case 'product_link':
      return text(product.handle) ? productLink(opts.domain, product) : '';
    case 'availability_state':
      return availability(product) === 'in stock' ? 'in_stock' : 'out_of_stock';
    case 'condition_new':
      return 'new';
    case 'price':
    case 'compare_at_price': {
      const amount = Number(product[variable]);
      // Google vuole "9.99 EUR": la cifra da sola viene rifiutata, e con il
      // punto decimale, non la virgola, qualunque sia la lingua del merchant.
      return Number.isFinite(amount) && amount > 0
        ? `${amount.toFixed(2)} ${opts.currency}`
        : '';
    }
    case 'list_price':
      return valueOf(hasDiscount(product) ? 'compare_at_price' : 'price', product, opts);
    case 'discounted_price':
      return hasDiscount(product) ? valueOf('price', product, opts) : '';
    case 'weight': {
      const amount = Number(product.weight);
      return Number.isFinite(amount) && amount > 0 ? `${amount} kg` : '';
    }
    case 'tags': {
      const tags = (product as unknown as { tags?: string[] | null }).tags;
      return Array.isArray(tags) ? tags.join(', ') : '';
    }
    default:
      return text((product as unknown as Record<string, unknown>)[variable]);
  }
}

/**
 * Un articolo del catalogo Google, costruito con la mappatura del merchant.
 *
 * I campi vuoti non entrano: un tag vuoto vale come assente per Google, ma
 * scriverlo gonfia il file e nasconde nella lettura a occhio quali campi
 * mancano davvero.
 */
export function toGmcItem(
  product: FeedProduct,
  mapping: Record<string, Variable>,
  opts: { domain: string; currency: string },
): Record<string, string> | null {
  const item: Record<string, string> = {};

  for (const field of GMC_FIELDS) {
    const variable = mapping[field.name] ?? field.suggested;
    const value = valueOf(variable, product, opts);
    if (value) item[field.name] = value;
  }

  // Manca un obbligatorio: la riga non entra. Google la accetterebbe e la
  // segnerebbe come non approvata, che e' peggio — il merchant vede il
  // prodotto nel catalogo e non capisce perche' non gira.
  const missing = GMC_FIELDS.filter((field) => field.required && !item[field.name]);
  if (missing.length > 0) return null;

  // Senza marca e senza codici Google chiede di dichiararlo, altrimenti tratta
  // l'assenza come un errore invece che come una scelta.
  if (!item.gtin && !item.mpn) item.identifier_exists = 'no';

  return item;
}

/** Quali campi obbligatori mancano a questo prodotto, con questa mappatura. */
export function missingFields(
  product: FeedProduct,
  mapping: Record<string, Variable>,
  opts: { domain: string; currency: string },
): string[] {
  return GMC_FIELDS.filter(
    (field) => field.required && !valueOf(mapping[field.name] ?? field.suggested, product, opts),
  ).map((field) => field.name);
}
