export interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string | null;
  vendor: string | null;
  product_type: string | null;
  handle: string | null;
  status: string | null;
  tags: string;
  published_at: string | null;
  // Data di creazione su Shopify: decide l'ordine con cui i prodotti vengono
  // sincronizzati (dal piu' vecchio) e quindi chi entra sotto il tetto del piano.
  // Opzionale perche' con `fields` ristretti Shopify non la restituisce.
  created_at?: string | null;
  /**
   * Ultima modifica su Shopify. Serve al confine incrementale: quando la
   * scrittura di questo prodotto non riesce, e' fin qui che il confine viene
   * tenuto indietro, ed e' cosi' che la corsa successiva lo ritrova nel delta.
   * Opzionale perche' un prodotto costruito a mano non ce l'ha.
   */
  updated_at?: string | null;
  variants: ShopifyVariant[];
  images?: ShopifyImage[];
  /**
   * `variants` e' l'elenco COMPLETO delle varianti su Shopify, oppure solo la
   * parte che si e' riusciti a leggere?
   *
   * Le connessioni annidate di GraphQL hanno un tetto per pagina, quindi un
   * prodotto con centocinquanta taglie puo' benissimo arrivare qui con cento
   * varianti e nessun segno che ne mancassero altre. Chi cancella per differenza
   * — "questa riga non c'e' piu' su Shopify, quindi via" — deve pretendere `true`
   * prima di procedere: su un elenco troncato quella differenza e' inventata, e
   * cancellerebbe varianti vive.
   *
   * Opzionale, e assente vale come `false`: un chiamante che costruisce un
   * prodotto a mano non sta dimostrando nulla sulla completezza.
   */
  variants_complete?: boolean;
  /** Stessa domanda per `images`, che ha lo stesso tetto per pagina. */
  images_complete?: boolean;
}

export interface ShopifyVariant {
  id: number;
  product_id: number;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  price: string;
  compare_at_price: string | null;
  cost: string | null;
  position: number | null;
  inventory_quantity: number | null;
  // Riferimento all'InventoryItem: il cost_per_item vive lì, non sulla variante.
  inventory_item_id?: number | null;
  // null quando le scorte NON sono monitorate (inventory_management assente).
  inventory_management?: string | null;
  inventory_policy?: string | null;
  weight: number | null;
  weight_unit: string | null;
  requires_shipping: boolean | null;
  taxable: boolean | null;
  image_id: number | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

export interface ShopifyImage {
  id: number | null;
  product_id?: number;
  src: string;
}

export interface ShopifyCustomer {
  id: number;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  accepts_marketing?: boolean;
  marketing_opt_in_level?: string | null;
  email_marketing_consent?: {
    state?: string | null;
    opt_in_level?: string | null;
  } | null;
  total_spent?: string | null;
  orders_count?: number | null;
  state?: string | null;
  tags?: string;
  note?: string | null;
  verified_email?: boolean | null;
  tax_exempt?: boolean | null;
  created_at?: string | null;
  updated_at?: string | null;
  /**
   * La data di nascita, dal metafield `custom.data_di_nascita` (vedi
   * `lib/customers/birthdate-metafield`). Shopify la restituisce come
   * `1985-04-23`; qui arriva cosi' com'e' ed e' il transformer a compattarla.
   *
   * La distinzione fra assente e vuota conta: `undefined` vuol dire "non l'ho
   * chiesta" — e' il caso del payload dei webhook, che i metafield non li porta
   * — mentre `null` vuol dire "l'ho chiesta e il campo e' vuoto". Il transformer
   * ci si appoggia per non cancellare una data che non ha mai letto.
   */
  date_of_birth?: string | null;
  /**
   * L'indirizzo predefinito. Shopify ne restituisce anche l'elenco completo
   * (`addresses`), ma per un pubblico pubblicitario conta quello in uso: gli
   * altri sono indirizzi di spedizione occasionali, non dove il cliente vive.
   */
  default_address?: {
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    country?: string | null;
    /**
     * La sigla ISO a due lettere (`IT`, `DE`, `CA`). Nome piatto alla REST
     * perche' e' la forma in cui arriva il payload dei webhook; la corsa
     * periodica lo chiede a GraphQL come `countryCodeV2` e lo riporta qui.
     */
    country_code?: string | null;
    zip?: string | null;
  } | null;
}

export interface SupabaseCustomerRow {
  shopify_customer_id: number;
  // Nomi per esteso: sono le colonne della tabella del merchant, non i campi
  // del payload Shopify (che restano email / phone).
  email_address: string | null;
  phone_number: string | null;
  first_name: string | null;
  last_name: string | null;
  accepts_marketing: boolean | null;
  marketing_opt_in_level: string | null;
  total_spent: number | null;
  orders_count: number | null;
  customer_state: string | null;
  tags: string[];
  note: string | null;
  verified_email: boolean | null;
  tax_exempt: boolean | null;
  created_at: string | null;
  updated_at: string | null;
  /** Dall'indirizzo predefinito: paese, via, citta', CAP, regione. */
  country: string | null;
  /**
   * La sigla ISO del paese, accanto al nome esteso e non al suo posto: le
   * piattaforme pubblicitarie confrontano `IT`, chi legge la tabella vuole
   * `Italy`.
   */
  country_code: string | null;
  address: string | null;
  city: string | null;
  zipcode: string | null;
  region: string | null;
  /**
   * Shopify non ce l'ha come campo proprio, e resta null finche' non si decide
   * da quale metafield leggerlo: la colonna esiste perche' chi costruisce un
   * pubblico trovi il posto gia' pronto, non perche' sia gia' riempita.
   */
  external_id: string | null;
  /**
   * La data di nascita come `YYYYMMDD`, dal metafield del cliente.
   *
   * OPZIONALE, e non per pigrizia: la chiave assente e la chiave a null sono
   * due istruzioni diverse per PostgREST. Assente significa "questa colonna non
   * la tocco" e lascia in pace quello che c'e' gia'; a null significa
   * "svuotala". I webhook dei clienti non portano i metafield, quindi non
   * sanno nulla di questo campo: se scrivessero null cancellerebbero a ogni
   * modifica del cliente una data che solo la corsa periodica sa leggere.
   */
  date_of_birth?: string | null;
  synced_at: string;
}

export interface SupabaseProductRow {
  shopify_product_id: number;
  shopify_variant_id: number | null;
  is_variant: boolean;
  product_title: string;
  product_description: string | null;
  vendor: string | null;
  product_type: string | null;
  handle: string | null;
  product_status: string | null;
  tags: string[];
  product_published_at: string | null;
  variant_title: string | null;
  sku: string | null;
  barcode: string | null;
  price: number;
  compare_at_price: number | null;
  cost_per_item: number | null;
  // Profitto per unita': price - cost_per_item. Derivato, mai scritto a mano.
  net_value: number | null;
  position: number | null;
  inventory_quantity: number | null;
  inventory_tracked: boolean;
  inventory_policy: string | null;
  weight: number | null;
  weight_unit: string | null;
  requires_shipping: boolean | null;
  taxable: boolean | null;
  image_url: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  synced_at: string;
}
