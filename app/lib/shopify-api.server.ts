import { unauthenticated } from '~/shopify.server';
import {
  BIRTHDATE_METAFIELD,
  BIRTHDATE_METAFIELD_ACCESS,
  BIRTHDATE_METAFIELD_CAPABILITIES,
  supportedCapabilities,
  type MetafieldKey,
} from '~/lib/customers/birthdate-metafield';
import type { ShopifyOrder, ShopifyOrderLine } from '~/lib/customers/order-rows';

/**
 * Le capability dei metafield che la versione dell'API in uso conosce.
 *
 * Vive fuori dalla classe perche' non dipende dal negozio ma dalla versione:
 * un client nuovo per ogni richiesta rifarebbe la stessa domanda ogni volta per
 * ricevere sempre la stessa risposta. `undefined` = non ancora chiesto, `null` =
 * chiesto e non saputo.
 */
let capabilityFieldsCache: ReadonlySet<string> | null | undefined;

// Client Admin API in GraphQL.
//
// La superficie pubblica e' deliberatamente quella di prima, quando sotto c'era
// la REST: stesse firme, stesse forme di ritorno (snake_case, id numerici). Non
// e' pigrizia: quei nomi sono le colonne delle tabelle Supabase dei merchant, e
// gli strumenti di tracciamento le leggono per nome. Il confine fra le due
// convenzioni sta qui dentro, in un file solo, invece di essere sparso nei nove
// consumatori.

/** `gid://shopify/Product/123` → `123`. */
function gidToId(gid: string | null | undefined): number | null {
  if (!gid) return null;
  const last = gid.split('/').pop();
  const n = Number(last);
  return Number.isFinite(n) ? n : null;
}

/** Gli enum GraphQL sono maiuscoli, la REST li dava minuscoli. */
function lower(v: string | null | undefined): string | null {
  return v ? v.toLowerCase() : null;
}

// La REST esprimeva il peso con sigle, GraphQL con il nome dell'unita'. La
// colonna `weight_unit` del merchant contiene le sigle: si traduce.
const WEIGHT_UNITS: Record<string, string> = {
  GRAMS: 'g',
  KILOGRAMS: 'kg',
  OUNCES: 'oz',
  POUNDS: 'lb',
};

interface GqlVariant {
  id: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  position: number | null;
  inventoryQuantity: number | null;
  inventoryPolicy: string | null;
  taxable: boolean | null;
  selectedOptions?: { name: string; value: string }[];
  image?: { id: string } | null;
  inventoryItem?: {
    id: string;
    tracked: boolean | null;
    requiresShipping: boolean | null;
    unitCost: { amount: string } | null;
    measurement?: { weight: { value: number; unit: string } | null } | null;
  } | null;
}

/** Il `pageInfo` di una connessione annidata, quando lo si e' chiesto. */
interface GqlPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface GqlConnection<T> {
  nodes: T[];
  pageInfo?: GqlPageInfo;
}

interface GqlProduct {
  id: string;
  title: string;
  descriptionHtml?: string | null;
  vendor?: string | null;
  productType?: string | null;
  handle?: string | null;
  status?: string | null;
  tags?: string[];
  publishedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  images?: GqlConnection<{ id: string; url: string }>;
  variants?: GqlConnection<GqlVariant>;
}

/**
 * Quanto e' completo l'elenco annidato che abbiamo in mano.
 *
 * E' l'unica informazione che autorizza chi sta a valle a cancellare per
 * differenza. Non e' un dettaglio diagnostico: senza, un elenco troncato e un
 * elenco vero sono indistinguibili, e la sincronizzazione "riconcilia" via le
 * righe che semplicemente non ha mai chiesto.
 */
interface ConnectionCompleteness {
  variantsComplete: boolean;
  imagesComplete: boolean;
}

function mapVariant(v: GqlVariant, productId: number) {
  const inv = v.inventoryItem;
  const weight = inv?.measurement?.weight ?? null;
  // `selectedOptions` e' un elenco ordinato: la REST lo dava gia' appiattito in
  // tre campi posizionali, ed e' cosi' che il transformer se lo aspetta.
  const opts = v.selectedOptions ?? [];

  return {
    id: gidToId(v.id) as number,
    product_id: productId,
    title: v.title,
    sku: v.sku,
    barcode: v.barcode,
    price: v.price,
    compare_at_price: v.compareAtPrice,
    position: v.position,
    inventory_quantity: v.inventoryQuantity,
    // La REST non aveva un booleano: diceva "shopify" o null, e il transformer
    // deduce il tracciamento da `inventory_management != null`. Manteniamo la
    // stessa convenzione per non toccare il transformer.
    inventory_management: inv?.tracked ? 'shopify' : null,
    inventory_policy: lower(v.inventoryPolicy),
    weight: weight?.value ?? null,
    weight_unit: weight ? (WEIGHT_UNITS[weight.unit] ?? weight.unit.toLowerCase()) : null,
    requires_shipping: inv?.requiresShipping ?? null,
    taxable: v.taxable,
    option1: opts[0]?.value ?? null,
    option2: opts[1]?.value ?? null,
    option3: opts[2]?.value ?? null,
    image_id: gidToId(v.image?.id),
    inventory_item_id: gidToId(inv?.id),
    // Il costo arriva gia' qui, mentre la REST costringeva a una seconda
    // chiamata su inventory_items. `enrichVariantCosts` continua a girare e
    // riscrive lo stesso valore: nessuna differenza nel risultato.
    cost: inv?.unitCost?.amount ?? null,
  };
}

function mapProduct(p: GqlProduct, completeness: ConnectionCompleteness) {
  const id = gidToId(p.id) as number;
  return {
    id,
    title: p.title,
    body_html: p.descriptionHtml ?? null,
    vendor: p.vendor ?? null,
    product_type: p.productType ?? null,
    handle: p.handle ?? null,
    status: lower(p.status),
    // La REST dava una stringa separata da virgole, e il transformer fa split.
    tags: (p.tags ?? []).join(', '),
    published_at: p.publishedAt ?? null,
    // Non e' un campo decorativo: `sortByCreatedAtAsc` ordina i prodotti con
    // questo, e l'ordine decide quali entrano sotto il tetto del piano. Se
    // mancasse, il taglio cadrebbe su prodotti diversi a ogni sincronizzazione.
    created_at: p.createdAt ?? null,
    // Quando Shopify l'ha modificato l'ultima volta. Non e' decorativo: e' il
    // punto fino a cui il confine incrementale viene tenuto indietro quando la
    // scrittura di questo prodotto non riesce, ed e' cosi' che la corsa dopo se
    // lo ritrova davanti invece di scavalcarlo. Senza, l'unica alternativa
    // sarebbe non far avanzare il confine affatto.
    updated_at: p.updatedAt ?? null,
    images: (p.images?.nodes ?? []).map((img) => ({ id: gidToId(img.id), src: img.url })),
    variants: (p.variants?.nodes ?? []).map((v) => mapVariant(v, id)),
    // I due bit che dicono se gli elenchi qui sopra sono TUTTO quello che
    // Shopify ha, o solo la parte che siamo riusciti a leggere. Chi cancella
    // per differenza deve guardare qui prima di farlo.
    variants_complete: completeness.variantsComplete,
    images_complete: completeness.imagesComplete,
  };
}

const VARIANT_FIELDS = `
  id title sku barcode price compareAtPrice position
  inventoryQuantity inventoryPolicy taxable
  selectedOptions { name value }
  image { id }
  inventoryItem {
    id tracked requiresShipping
    unitCost { amount }
    measurement { weight { value unit } }
  }
`;

const IMAGE_FIELDS = 'id url';

// `currentQuantity` e `priceAfterAllDiscountsBeforeTaxesSet` sono i due campi
// canonici, e sono qui per la stessa ragione: raccontano la riga com'e' ADESSO,
// non com'era stata ordinata.
//
// `quantity` e' la quantita' ordinata e non cambia mai piu': dopo un reso resta
// identica. `currentQuantity` scende, e a zero su una riga interamente
// rimborsata o rimossa dall'ordine.
//
// `priceAfterAllDiscountsBeforeTaxesSet` e' il netto della riga gia' fatto —
// sconti di riga e d'ordine tolti, tasse escluse. Prendere quello invece di
// moltiplicare `discountedUnitPriceSet` per una quantita' non e' pignoleria:
// uno sconto d'ordine viene spalmato sulle righe con arrotondamenti che il
// prodotto non riproduce, e sulle unita' rimborsate viene spalmato lo stesso.
//
// `discountedUnitPriceSet` e `originalUnitPriceSet` restano: sono il prezzo che
// il merchant riconosce guardando una riga, e la colonna `unit_price` li
// contiene da sempre. Semplicemente non entrano piu' in nessun conto.
const LINE_ITEM_FIELDS = `
  id title quantity currentQuantity
  product { id }
  variant { id }
  priceAfterAllDiscountsBeforeTaxesSet { shopMoney { amount currencyCode } }
  discountedUnitPriceSet { shopMoney { amount } }
  originalUnitPriceSet { shopMoney { amount } }
  totalDiscountSet { shopMoney { amount } }
`;

/** Una riga d'ordine come arriva da GraphQL, prima di diventare nostra. */
interface GqlOrderLineItem {
  id: string;
  title: string | null;
  quantity: number | null;
  currentQuantity: number | null;
  product: { id: string } | null;
  variant: { id: string } | null;
  priceAfterAllDiscountsBeforeTaxesSet: {
    shopMoney: { amount: string; currencyCode: string };
  } | null;
  discountedUnitPriceSet: { shopMoney: { amount: string } } | null;
  originalUnitPriceSet: { shopMoney: { amount: string } } | null;
  totalDiscountSet: { shopMoney: { amount: string } } | null;
}

interface GqlOrder {
  id: string;
  name: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
  customer: { id: string; firstName: string | null; lastName: string | null } | null;
  lineItems: GqlConnection<GqlOrderLineItem>;
  // I campi di spedizione. Tutti facoltativi: una risposta che non li porta
  // (un finto nei test, un ordine letto con una query vecchia) non deve
  // rompere la mappatura, solo lasciare vuote le colonne.
  displayFulfillmentStatus?: string | null;
  /** Una lista, non una connessione: `first` e' un argomento, non ci sono `nodes`. */
  fulfillments?: { trackingInfo: { number: string | null }[] | null }[] | null;
  shippingAddress?: { countryCodeV2: string | null } | null;
  /** UnsignedInt64, in grammi: in JSON arriva come stringa. */
  totalWeight?: string | number | null;
  returns?: { nodes: { status: string | null; createdAt: string | null }[] | null } | null;
  metafield?: { value: string | null } | null;
}

/**
 * I campi di un ordine, con quante righe chiedergli nella prima pagina.
 *
 * Uno solo per l'elenco e per il singolo, perche' le due strade devono
 * consegnare la stessa cosa: la corsa periodica e il webhook scrivono nelle
 * stesse colonne, e un campo che arriva da una parte sola vuol dire una colonna
 * che si riempie e si svuota a seconda di chi ha scritto per ultimo.
 */
function orderNodeFields(lineItemsFirst: number): string {
  return `
    id name createdAt updatedAt cancelledAt displayFinancialStatus
    currentTotalPriceSet { shopMoney { amount currencyCode } }
    customer { id firstName lastName }
    displayFulfillmentStatus
    fulfillments(first: 10) { trackingInfo { number } }
    shippingAddress { countryCodeV2 }
    totalWeight
    returns(first: 5) { nodes { status createdAt } }
    metafield(namespace: "custom", key: "packaging_category") { value }
    lineItems(first: ${lineItemsFirst}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${LINE_ITEM_FIELDS} }
    }
  `;
}

/** Un reso annullato o rifiutato non e' un pacco rientrato. */
const RESO_NON_AVVENUTO = new Set(['CANCELED', 'DECLINED']);

/**
 * Dai campi di spedizione GraphQL a quelli che si scrivono sull'ordine.
 *
 * Il tracking vince sullo stato: un ordine reso Shopify lo mostra RESTOCKED, ma
 * il pacco all'andata e' partito e il corriere l'ha fatturato. Se non si
 * guardasse il tracking, il reso cancellerebbe il costo dell'andata proprio
 * nell'ordine che e' costato di piu'.
 *
 * Il peso viene arrotondato all'intero: Shopify lo dichiara in grammi, e
 * `total_weight_grams` e' INTEGER. Un valore non numerico resta NULL — il costo
 * ripiega sul peso di default per articolo — invece di diventare zero.
 */
function mapOrderLogistics(o: GqlOrder): Pick<
  ShopifyOrder,
  | 'fulfillment_status'
  | 'shipping_country_code'
  | 'total_weight_grams'
  | 'returned_at'
  | 'packaging_category'
> {
  const tracciato = (o.fulfillments ?? []).some((f) =>
    (f.trackingInfo ?? []).some((t) => !!t.number),
  );

  const peso = o.totalWeight == null ? NaN : Number(o.totalWeight);

  const reso = (o.returns?.nodes ?? []).find(
    (r) => !RESO_NON_AVVENUTO.has((r.status ?? '').toUpperCase()),
  );

  return {
    fulfillment_status: tracciato ? 'FULFILLED' : (o.displayFulfillmentStatus ?? null),
    shipping_country_code: o.shippingAddress?.countryCodeV2 ?? null,
    total_weight_grams: Number.isFinite(peso) ? Math.round(peso) : null,
    returned_at: reso?.createdAt ?? null,
    packaging_category: o.metafield?.value || null,
  };
}

/**
 * Da riga GraphQL a riga nostra.
 *
 * `currentQuantity` con `quantity` come ripiego: se Shopify non lo mandasse —
 * una versione API piu' vecchia di quella per cui questo codice e' scritto — il
 * ripiego riproduce il comportamento di prima invece di azzerare la riga, che
 * sarebbe l'errore piu' grosso dei due.
 *
 * Il netto invece NON ha ripiego calcolato: se
 * `priceAfterAllDiscountsBeforeTaxesSet` mancasse, la riga resta senza netto e
 * il conto la dichiara non misurabile. Ricostruirlo moltiplicando un prezzo
 * unitario e' proprio l'approssimazione da cui si sta scappando, e farlo di
 * nascosto sotto il nome del campo canonico sarebbe peggio che non averlo.
 *
 * La valuta si prende dalla riga e, quando la riga non la dichiara, da quella
 * dell'ordine: sono entrambe `shopMoney`, quindi coincidono — ed e' esattamente
 * cio' che il conto verifica prima di sommare.
 */
function mapOrderLine(l: GqlOrderLineItem, orderCurrency: string | null): ShopifyOrderLine {
  const net = l.priceAfterAllDiscountsBeforeTaxesSet?.shopMoney ?? null;

  return {
    id: gidToId(l.id),
    title: l.title,
    quantity: l.quantity ?? 0,
    current_quantity: l.currentQuantity ?? l.quantity ?? 0,
    product_id: l.product ? gidToId(l.product.id) : null,
    variant_id: l.variant ? gidToId(l.variant.id) : null,
    unit_price:
      l.discountedUnitPriceSet?.shopMoney.amount ??
      l.originalUnitPriceSet?.shopMoney.amount ??
      null,
    total_discount: l.totalDiscountSet?.shopMoney.amount ?? null,
    line_net_total: net?.amount ?? null,
    line_currency: net?.currencyCode ?? orderCurrency,
  };
}

// Quante varianti (e quante immagini, e quante righe d'ordine) si chiedono nella
// PRIMA pagina, dentro la query d'elenco.
//
// Restano i numeri di prima e non si alzano: il costo che Shopify calcola per
// una query e' il prodotto dei `first` annidati, e una pagina da 250 prodotti
// per 250 varianti verrebbe rifiutata in blocco. Meglio una prima pagina stretta
// piu' qualche coda mirata sui pochi prodotti che la superano, che una query che
// non parte affatto.
const VARIANTS_FIRST_IN_LIST = 100;
const IMAGES_FIRST_IN_LIST = 10;
const LINE_ITEMS_FIRST_IN_LIST = 100;

// Nelle code invece il genitore e' uno solo, quindi si prende il massimo che
// l'API concede: meno giri, meno occasioni di rompersi a meta'.
const NESTED_PAGE_SIZE = 250;

// Shopify ammette fino a 2048 varianti per prodotto: a 250 per giro bastano nove
// pagine. Il tetto e' largo il doppio e serve solo a non restare intrappolati se
// l'API ci ridesse all'infinito lo stesso cursore — in quel caso si esce
// dichiarando l'elenco incompleto, che e' l'esito prudente.
const MAX_NESTED_PAGES = 20;

/**
 * La versione dell'API che l'app chiede. Il default e' la piu' recente
 * supportata; cambiarlo si fa qui e nei tre posti elencati nel README.
 */
export const DEFAULT_API_VERSION = '2026-07';

/** Le versioni si chiamano tutte cosi': anno, trattino, mese del trimestre. */
const API_VERSION_SHAPE = /^\d{4}-(01|04|07|10)$/;

/**
 * La versione configurata, se ha senso; altrimenti quella predefinita.
 *
 * Un valore storto — un refuso, una versione inventata, `latest` — non fa
 * fallire la richiesta in modo riconoscibile: Shopify serve comunque qualcosa,
 * la piu' vecchia ancora supportata, e l'app gira per mesi su una versione che
 * nessuno ha scelto. Meglio accorgersene qui, dove si puo' ancora dire cosa e'
 * successo, e ripartire da un valore noto invece che da uno inventato.
 */
export function resolveApiVersion(configured: string | undefined): string {
  if (!configured) return DEFAULT_API_VERSION;

  const value = configured.trim();
  if (API_VERSION_SHAPE.test(value)) return value;

  console.error(
    `[shopify-api] SHOPIFY_API_VERSION non valida ("${configured}"): si usa ${DEFAULT_API_VERSION}. Le versioni hanno la forma AAAA-MM, con MM fra 01, 04, 07 e 10.`,
  );
  return DEFAULT_API_VERSION;
}

/**
 * Un errore che si porta dietro il motivo, non solo il testo.
 *
 * Chi decide se ritentare aveva davanti una `Error` e basta, e per capire se
 * fosse un 429 o un 403 avrebbe dovuto leggere una sottostringa del messaggio:
 * una regola che si rompe la prima volta che Shopify cambia una parola.
 */
/**
 * L'indice del cliente dentro il lotto, letto dal percorso del rifiuto.
 *
 * `metafieldsSet` risponde con `field: ["metafields", "3", "value"]`: quel 3 e'
 * la posizione nell'elenco mandato. Restituisce `null` quando il percorso non
 * lo contiene — un rifiuto che riguarda l'intera chiamata, non una riga.
 */
function indiceDelRifiuto(field: string[] | null | undefined): number | null {
  for (const pezzo of field ?? []) {
    if (/^\d+$/.test(pezzo)) return Number(pezzo);
  }
  return null;
}

export class ShopifyRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
    readonly graphqlCode: string | null = null,
  ) {
    super(message);
    this.name = 'ShopifyRequestError';
  }
}

/** Quante volte si prova in tutto, primo tentativo compreso. */
export const MAX_ATTEMPTS = 3;

/**
 * Se l'operazione scrive.
 *
 * Serve a una domanda sola — si puo' ripetere senza rischiare di applicarla due
 * volte? — e la risposta sta nella prima parola utile del documento GraphQL.
 * Il documento puo' cominciare con righe di commento o con spazi, quindi si
 * guarda la prima parola vera e non il primo carattere.
 */
export function isMutation(query: string): boolean {
  const firstWord = query
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .join(' ')
    .trimStart();
  return /^mutation\b/.test(firstWord);
}

/**
 * Quanti millisecondi aspettare prima di riprovare, o null per arrendersi.
 *
 * Si ritenta solo cio' che ha buone probabilita' di riuscire da solo al giro
 * dopo: il limite di frequenza, i guasti interni di Shopify, la connessione
 * caduta. Un 401, un 403 e un 422 non cambiano idea riprovando — sono un token
 * scaduto, un permesso mancante, una richiesta sbagliata — e ritentarli
 * ritarda soltanto l'errore che va mostrato.
 *
 * L'attesa raddoppia a ogni giro perche' un guasto che dura piu' di un istante
 * dura di solito qualche secondo, e tre richieste ravvicinate lo attraversano
 * tutte e tre.
 */
export function retryDelay(error: unknown, attempt: number, mutation: boolean): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;

  const backoff = 300 * 2 ** (attempt - 1);

  if (error instanceof ShopifyRequestError) {
    const throttled = error.status === 429 || error.graphqlCode === 'THROTTLED';
    // Fermati e riprova: la richiesta e' stata respinta prima di essere
    // eseguita, quindi ripeterla e' sicuro anche se scriveva.
    if (throttled) {
      return error.retryAfterSeconds != null
        ? Math.max(error.retryAfterSeconds * 1000, backoff)
        : backoff;
    }

    // Da qui in giu' non si sa se l'operazione sia passata: solo le letture.
    if (mutation) return null;

    if (error.graphqlCode === 'INTERNAL_SERVER_ERROR') return backoff;
    if (error.status != null && error.status >= 500) return backoff;
    return null;
  }

  // Non e' una risposta di Shopify: e' `fetch` che non e' arrivato in fondo
  // (DNS, connessione chiusa, timeout). Per una lettura si riprova, per una
  // scrittura no — la richiesta potrebbe essere arrivata comunque.
  return mutation ? null : backoff;
}


/**
 * Il filtro della query dei clienti, in un posto solo.
 *
 * Tre casi e non due: la pagina successiva non porta filtro (il cursore lo
 * conserva gia'), un id chiede quel cliente e basta, una data chiede la
 * finestra. Scritti in linea erano un ternario che nascondeva la precedenza.
 */
function filtroClienti(options: {
  pageInfo?: string;
  updatedAtMin?: string;
  customerId?: number | null;
}): string | null {
  if (options.pageInfo) return null;
  if (options.customerId != null) return `id:${options.customerId}`;
  return options.updatedAtMin ? `updated_at:>='${options.updatedAtMin}'` : null;
}

export class ShopifyAPIClient {
  private shopDomain: string;
  private accessToken: string;
  private apiVersion: string;
  private readonly RATE_LIMIT_THRESHOLD = 0.9;
  private readonly THROTTLE_DELAY_MS = 500;

  /** Il token va passato in chiaro: chi lo procura e' `forShop`. */
  constructor(shopDomain: string, accessToken: string) {
    this.shopDomain = shopDomain;
    this.accessToken = accessToken;
    this.apiVersion = resolveApiVersion(process.env.SHOPIFY_API_VERSION);
  }

  // Unico modo corretto di costruire il client. Il token NON si legge piu' dalla
  // copia cifrata in `shops.access_token`: da quando Shopify impone i token a
  // scadenza (un'ora), una copia congelata all'installazione e' garantita
  // scaduta, e l'API risponde 403. `unauthenticated.admin` carica la sessione
  // corrente e, se manca meno di 5 minuti alla scadenza, la rinnova con il
  // refresh token prima di restituirla — anche fuori da una richiesta HTTP
  // autenticata, quindi vale anche per i worker e per il cron.
  static async forShop(shopDomain: string): Promise<ShopifyAPIClient> {
    const { session } = await unauthenticated.admin(shopDomain);
    return new ShopifyAPIClient(shopDomain, session.accessToken ?? '');
  }

  /**
   * Una richiesta a Shopify, ritentata quando il guasto e' dell'altra parte.
   *
   * Shopify risponde INTERNAL_SERVER_ERROR ogni tanto senza che ci sia niente di
   * sbagliato nella richiesta: il 4 settembre due chiamate identiche a un
   * secondo di distanza hanno dato una il catalogo e l'altra un errore, e la
   * dashboard ha mostrato 500 su una card che al secondo tentativo si sarebbe
   * riempita da sola. Un guasto che passa da solo non deve arrivare al merchant.
   *
   * Le mutazioni si ritentano SOLO quando e' certo che non siano state
   * eseguite, cioe' quando Shopify ha risposto 429 o THROTTLED: li' la
   * richiesta e' stata rifiutata prima di toccare qualcosa. Su un 500 o su una
   * connessione caduta non si sa se la scrittura sia passata, e riprovare
   * significherebbe rischiare di applicarla due volte — un addebito doppio, un
   * prodotto creato due volte. Meglio un errore che un duplicato.
   */
  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const mutation = isMutation(query);
    let attempt = 0;

    for (;;) {
      try {
        return await this.graphqlOnce<T>(query, variables);
      } catch (err) {
        attempt += 1;
        const retry = retryDelay(err, attempt, mutation);
        if (retry === null) throw err;
        console.warn(
          `[shopify-api] tentativo ${attempt} fallito, riprovo fra ${retry}ms: ${
            err instanceof Error ? err.message.slice(0, 200) : String(err)
          }`,
        );
        await this.sleep(retry);
      }
    }
  }

  private async graphqlOnce<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': this.accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      // Il corpo va letto: Shopify ci scrive il motivo vero, e senza di esso un
      // 403 "Forbidden" e' indistinguibile da un altro. E' costato una diagnosi
      // sbagliata, quando il messaggio "Non-expiring access tokens are no longer
      // accepted" era li' e lo stavamo buttando via.
      const detail = await response.text().catch(() => '');
      throw new ShopifyRequestError(
        `Shopify API error: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`,
        response.status,
        // Shopify dice lui quanto aspettare quando ci ferma: rispettarlo e'
        // l'unico modo di non farsi fermare di nuovo al tentativo dopo.
        Number(response.headers?.get('Retry-After')) || null,
      );
    }

    const body = (await response.json()) as {
      data?: T;
      errors?: unknown;
      extensions?: { cost?: { throttleStatus?: { maximumAvailable: number; currentlyAvailable: number } } };
    };

    // Qui sta la trappola di GraphQL: una query fallita risponde comunque 200,
    // con il motivo dentro `errors`. Senza questo controllo un errore
    // passerebbe per successo e scriverebbe righe vuote nel database del
    // merchant — un guasto silenzioso, il peggior tipo.
    if (body.errors) {
      const serialized = JSON.stringify(body.errors);
      throw new ShopifyRequestError(
        `Shopify API error: ${serialized.slice(0, 300)}`,
        null,
        null,
        // Il codice sta dentro `extensions`, e da li' si capisce se il guasto e'
        // passeggero. Cercarlo nella stringa e' brutale ma regge qualunque
        // forma abbia l'elenco degli errori, che GraphQL non fissa.
        serialized.includes('INTERNAL_SERVER_ERROR')
          ? 'INTERNAL_SERVER_ERROR'
          : serialized.includes('THROTTLED')
            ? 'THROTTLED'
            : null,
      );
    }

    // Il limite non si conta piu' in richieste ma in punti: il serbatoio si
    // svuota in proporzione a quanto chiede la query e si ricarica da solo.
    // Stessa soglia di prima (90% consumato), letta dove ora vive il dato.
    const t = body.extensions?.cost?.throttleStatus;
    if (t && t.maximumAvailable > 0) {
      const used = t.maximumAvailable - t.currentlyAvailable;
      if (used >= t.maximumAvailable * this.RATE_LIMIT_THRESHOLD) {
        console.warn(`Approaching rate limit: ${used}/${t.maximumAvailable} punti`);
        await this.sleep(this.THROTTLE_DELAY_MS);
      }
    }

    // Sorveglianza della versione API: se Shopify risponde con una versione diversa
    // da quella richiesta, significa che quella richiesta e' stata ritirata e
    // Shopify sta facendo fall-forward in silenzio. Segnalarlo evita che l'app giri
    // su una versione diversa da quella per cui e' scritta senza che nessuno se ne
    // accorga.
    // `?.` non e' difensivismo: e' una diagnostica, e una diagnostica non deve
    // poter far fallire una richiesta andata a buon fine.
    const apiVersionReceived = response.headers?.get('X-Shopify-API-Version');
    if (apiVersionReceived && apiVersionReceived !== this.apiVersion) {
      console.warn(
        `[shopify-api] versione API disallineata: richiesta ${this.apiVersion}, ricevuta ${apiVersionReceived}`,
      );
    }

    return body.data as T;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Svuota una connessione annidata a partire da dove la prima pagina si e'
   * fermata, e dice se ci e' riuscita.
   *
   * Le connessioni dentro una query di elenco hanno un tetto proprio: chiedere
   * `variants(first: 100)` non e' "le varianti del prodotto", e' "le prime cento".
   * Su un prodotto con centocinquanta taglie le altre cinquanta non arrivano mai,
   * e per chi legge non esistono. Da qui in poi si continua a chiedere finche'
   * `hasNextPage` non dice di no.
   *
   * Perche' non le Bulk Operations, che con una sola richiesta darebbero l'intero
   * catalogo senza connessioni troncate: sono asincrone (si avvia, si interroga,
   * si scarica un JSONL), una sola per negozio alla volta, e restituiscono tutto
   * o niente. La sincronizzazione qui e' a flusso — pagina, scrive, riporta
   * l'avanzamento — e soprattutto ha bisogno di sapere prodotto per prodotto se
   * l'elenco e' completo, che e' esattamente cio' che autorizza una cancellazione.
   * Con il cursore quel bit ce l'abbiamo per costruzione; con il bulk avremmo un
   * file da fidarsi in blocco e nessun modo di isolare il prodotto andato storto.
   *
   * L'errore NON si propaga: si restituisce quel che si e' raccolto con
   * `complete: false`. Una pagina persa deve costare un aggiornamento parziale,
   * mai una cancellazione — ed e' proprio il chiamante, vedendo `false`, a
   * rinunciare a riconciliare.
   */
  private async drainConnection<TNode>(opts: {
    parentGid: string;
    parentType: 'Product' | 'Order';
    field: 'variants' | 'images' | 'lineItems';
    nodeFields: string;
    after: string | null;
  }): Promise<{ nodes: TNode[]; complete: boolean }> {
    const nodes: TNode[] = [];
    let after = opts.after;

    // `node(id:)` piu' il frammento sul tipo del genitore: una sola forma di
    // query per varianti, immagini e righe d'ordine.
    const query = `
      query DrainConnection($id: ID!, $first: Int!, $after: String) {
        node(id: $id) {
          ... on ${opts.parentType} {
            ${opts.field}(first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { ${opts.nodeFields} }
            }
          }
        }
      }
    `;

    try {
      for (let page = 0; page < MAX_NESTED_PAGES; page++) {
        const data = await this.graphql<{
          node: Record<string, GqlConnection<TNode> | undefined> | null;
        }>(query, { id: opts.parentGid, first: NESTED_PAGE_SIZE, after });

        const connection = data.node?.[opts.field];
        // Nodo sparito o tipo inatteso: non si e' letto nulla, e nulla si puo'
        // dichiarare completo.
        if (!connection) return { nodes, complete: false };

        nodes.push(...(connection.nodes ?? []));

        const info = connection.pageInfo;
        if (!info) return { nodes, complete: false };
        if (!info.hasNextPage) return { nodes, complete: true };
        if (!info.endCursor) return { nodes, complete: false };
        after = info.endCursor;
      }
    } catch (error) {
      console.warn(
        `Paginazione di ${opts.field} su ${opts.parentGid} interrotta:`,
        error instanceof Error ? error.message : error,
      );
      return { nodes, complete: false };
    }

    console.warn(`Paginazione di ${opts.field} su ${opts.parentGid}: superato il tetto di pagine`);
    return { nodes, complete: false };
  }

  /**
   * Porta a termine le connessioni annidate di un prodotto, aggiungendo in coda
   * agli elenchi gia' ricevuti quel che mancava.
   *
   * Se una connessione non e' stata nemmeno chiesta (accade con `fields`
   * ristretti) risulta incompleta, non completa: l'assenza di dati non e' la
   * prova che non ci sia nulla, ed e' meglio rinunciare a una riconciliazione
   * legittima che autorizzarne una cieca.
   */
  private async completeProductConnections(p: GqlProduct): Promise<ConnectionCompleteness> {
    const gid = p.id;

    const drain = async <TNode>(
      connection: GqlConnection<TNode> | undefined,
      field: 'variants' | 'images',
      nodeFields: string,
    ): Promise<boolean> => {
      if (!connection) return false;
      const info = connection.pageInfo;
      if (!info) return false;
      if (!info.hasNextPage) return true;

      const rest = await this.drainConnection<TNode>({
        parentGid: gid,
        parentType: 'Product',
        field,
        nodeFields,
        after: info.endCursor,
      });
      connection.nodes = [...(connection.nodes ?? []), ...rest.nodes];
      return rest.complete;
    };

    // In sequenza e non in parallelo: il serbatoio dei punti e' uno solo, e due
    // code che corrono insieme lo svuotano il doppio piu' in fretta.
    const variantsComplete = await drain<GqlVariant>(p.variants, 'variants', VARIANT_FIELDS);
    const imagesComplete = await drain<{ id: string; url: string }>(
      p.images,
      'images',
      IMAGE_FIELDS,
    );

    return { variantsComplete, imagesComplete };
  }

  async getProducts(options: {
    limit?: number;
    pageInfo?: string;
    updatedAtMin?: string;
    fields?: string;
  } = {}) {
    // `fields` serviva a ridurre il payload REST. In GraphQL i campi si
    // dichiarano sempre, quindi lo usiamo per decidere se chiedere anche i dati
    // di livello prodotto: chi passa "id,variants" vuole solo le varianti (e' il
    // caso della readiness, che guarda i costi) e non ha bisogno del resto.
    const wanted = options.fields ? new Set(options.fields.split(',').map(f => f.trim())) : null;
    const wants = (f: string) => !wanted || wanted.has(f);

    const productFields = [
      'id',
      wants('title') ? 'title' : '',
      wants('body_html') ? 'descriptionHtml' : '',
      wants('vendor') ? 'vendor' : '',
      wants('product_type') ? 'productType' : '',
      wants('handle') ? 'handle' : '',
      wants('status') ? 'status' : '',
      wants('tags') ? 'tags' : '',
      wants('published_at') ? 'publishedAt' : '',
      'createdAt',
      // Sempre, come `createdAt`, e per un motivo dello stesso peso: e' fin qui
      // che il confine incrementale viene tenuto indietro se la scrittura di
      // questo prodotto non riesce. Senza, l'unico modo di non perdere il
      // prodotto sarebbe non far avanzare il confine per niente.
      'updatedAt',
      // Il `pageInfo` non e' un extra: e' cio' che distingue "il prodotto ha
      // dieci immagini" da "gliene abbiamo chieste dieci". Senza, la risposta e'
      // la stessa in entrambi i casi.
      wants('images')
        ? `images(first: ${IMAGES_FIRST_IN_LIST}) { pageInfo { hasNextPage endCursor } nodes { ${IMAGE_FIELDS} } }`
        : '',
      wants('variants')
        ? `variants(first: ${VARIANTS_FIRST_IN_LIST}) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT_FIELDS} } }`
        : '',
    ].filter(Boolean).join('\n');

    const query = `
      query Products($first: Int!, $after: String, $query: String) {
        products(first: $first, after: $after, query: $query) {
          pageInfo { hasNextPage endCursor }
          nodes { ${productFields} }
        }
      }
    `;

    const data = await this.graphql<{
      products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlProduct[] };
    }>(query, {
      first: options.limit || 250,
      // Il cursore di GraphQL prende il posto di `page_info`: e' una stringa
      // opaca in entrambi i casi, e i consumatori si limitano a ripassarcela.
      after: options.pageInfo ?? null,
      // Il filtro sull'aggiornamento vale solo alla prima pagina: dalla seconda
      // in poi e' gia' inciso nel cursore, come lo era nel page_info.
      query: !options.pageInfo && options.updatedAtMin ? `updated_at:>='${options.updatedAtMin}'` : null,
    });

    // Le code prima della mappatura: un prodotto esce di qui solo quando le sue
    // connessioni sono state portate a termine (o dichiarate incomplete). Nel
    // caso normale — quasi tutti i prodotti stanno sotto il tetto della prima
    // pagina — non parte nessuna richiesta in piu'.
    const products = [];
    for (const node of data.products.nodes) {
      products.push(mapProduct(node, await this.completeProductConnections(node)));
    }

    return {
      products,
      nextPageInfo: data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null,
    };
  }

  async getProductById(productId: number) {
    const data = await this.graphql<{ product: GqlProduct | null }>(
      `query Product($id: ID!) {
        product(id: $id) {
          id title descriptionHtml vendor productType handle status tags publishedAt createdAt updatedAt
          images(first: ${NESTED_PAGE_SIZE}) { pageInfo { hasNextPage endCursor } nodes { ${IMAGE_FIELDS} } }
          variants(first: ${NESTED_PAGE_SIZE}) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT_FIELDS} } }
        }
      }`,
      { id: `gid://shopify/Product/${productId}` },
    );
    if (!data.product) return null;
    // Qui il prodotto e' uno solo: si puo' chiedere subito il massimo per
    // pagina, e le code partono solo oltre le 250 varianti.
    return mapProduct(data.product, await this.completeProductConnections(data.product));
  }

  async getProductsCount(): Promise<number> {
    const data = await this.graphql<{ productsCount: { count: number } | null }>(
      '{ productsCount { count } }',
    );
    return typeof data.productsCount?.count === 'number' ? data.productsCount.count : 0;
  }

  // Il cost_per_item vive sull'InventoryItem, non sulla variante. In GraphQL
  // arriverebbe gia' insieme al prodotto, ma il metodo resta perche' i
  // consumatori lo usano anche da solo, sui soli id che gli servono.
  async getInventoryItems(
    ids: number[],
  ): Promise<{ id: number; cost: string | null }[]> {
    if (ids.length === 0) return [];
    const data = await this.graphql<{
      nodes: ({ id: string; unitCost: { amount: string } | null } | null)[];
    }>(
      `query InventoryItems($ids: [ID!]!) {
        nodes(ids: $ids) { ... on InventoryItem { id unitCost { amount } } }
      }`,
      { ids: ids.map((id) => `gid://shopify/InventoryItem/${id}`) },
    );

    return (data.nodes ?? [])
      .filter((n): n is { id: string; unitCost: { amount: string } | null } => n != null)
      .map((n) => ({ id: gidToId(n.id) as number, cost: n.unitCost?.amount ?? null }));
  }

  async updateInventoryItemCost(
    inventoryItemId: number,
    cost: string,
  ): Promise<{ id: number; cost: string | null }> {
    const data = await this.graphql<{
      inventoryItemUpdate: {
        inventoryItem: { id: string; unitCost: { amount: string } | null } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      `mutation UpdateCost($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
          inventoryItem { id unitCost { amount } }
          userErrors { field message }
        }
      }`,
      { id: `gid://shopify/InventoryItem/${inventoryItemId}`, input: { cost } },
    );

    // Le mutation hanno un secondo canale d'errore, distinto da `errors`: un
    // rifiuto applicativo (valore non valido, permesso mancante) arriva qui, con
    // la mutation formalmente riuscita. Va alzato, o la scrittura risulterebbe
    // andata a buon fine senza esserlo.
    const userErrors = data.inventoryItemUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      throw new Error(`Shopify API error: ${userErrors.map((e) => e.message).join('; ').slice(0, 300)}`);
    }

    const item = data.inventoryItemUpdate?.inventoryItem;
    return { id: gidToId(item?.id) as number, cost: item?.unitCost?.amount ?? null };
  }

  async getCustomers(options: {
    limit?: number;
    pageInfo?: string;
    updatedAtMin?: string;
    /**
     * Un cliente solo, per id.
     *
     * Serve al webhook dei clienti, che del corpo della consegna non conserva
     * niente oltre l'identificativo e rilegge l'anagrafica da qui. Passa dalla
     * stessa query dell'elenco di proposito: il cliente riletto per il webhook
     * e quello riletto dalla corsa periodica devono avere gli stessi campi,
     * altrimenti le due strade scriverebbero due righe diverse per la stessa
     * persona.
     */
    customerId?: number | null;
    /**
     * Il metafield da cui leggere la data di nascita, scelto dal merchant.
     *
     * Assente vuol dire "non chiederlo": i clienti tornano senza il campo
     * `date_of_birth`, e la colonna sul database del merchant resta com'e'
     * invece di essere svuotata. E' il comportamento giusto per chi non ha
     * ancora scelto niente, e anche per chi chiama questo metodo per altro —
     * le statistiche sul consenso, per dire, che della data non sanno che
     * farsene e non hanno motivo di far costare di piu' la query.
     */
    birthdateMetafield?: MetafieldKey | null;
  } = {}) {
    const birthdate = options.birthdateMetafield ?? null;
    // Le variabili non usate sono un errore di GraphQL, non un di piu'
    // innocuo: se si dichiarano `$namespace` e `$key` senza poi chiederle,
    // Shopify rifiuta l'intera query. Quindi o entrano tutte e due le parti, o
    // nessuna.
    const birthdateVars = birthdate ? ', $namespace: String!, $key: String!' : '';
    const birthdateField = birthdate ? 'metafield(namespace: $namespace, key: $key) { value }' : '';

    const data = await this.graphql<{
      customers: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          email: string | null;
          phone: string | null;
          firstName: string | null;
          lastName: string | null;
          emailMarketingConsent: { marketingState: string | null; marketingOptInLevel: string | null } | null;
          amountSpent: { amount: string } | null;
          numberOfOrders: string | number | null;
          state: string | null;
          tags: string[];
          note: string | null;
          verifiedEmail: boolean | null;
          taxExempt: boolean | null;
          createdAt: string | null;
          updatedAt: string | null;
          defaultAddress: {
            address1: string | null;
            address2: string | null;
            city: string | null;
            province: string | null;
            country: string | null;
            countryCodeV2: string | null;
            zip: string | null;
          } | null;
          metafield?: { value: string | null } | null;
        }[];
      };
    }>(
      `query Customers($first: Int!, $after: String, $query: String${birthdateVars}) {
        customers(first: $first, after: $after, query: $query) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id email phone firstName lastName
            emailMarketingConsent { marketingState marketingOptInLevel }
            amountSpent { amount }
            numberOfOrders
            state tags note verifiedEmail taxExempt createdAt updatedAt
            defaultAddress { address1 address2 city province country countryCodeV2 zip }
            ${birthdateField}
          }
        }
      }`,
      {
        first: options.limit || 250,
        after: options.pageInfo ?? null,
        // L'id ha la precedenza sulla finestra temporale: chiedere UN cliente e
        // filtrarlo anche per data significherebbe non trovarlo ogni volta che
        // non e' cambiato di recente, che e' proprio il caso del ritentativo.
        query: filtroClienti(options),
        ...(birthdate ? { namespace: birthdate.namespace, key: birthdate.key } : {}),
      },
    );

    return {
      customers: data.customers.nodes.map((c) => ({
        id: gidToId(c.id),
        email: c.email,
        phone: c.phone,
        first_name: c.firstName,
        last_name: c.lastName,
        // Il transformer confronta con 'subscribed' e 'single_opt_in': gli enum
        // vanno riportati minuscoli o il consenso risulterebbe sempre negato,
        // e nessun cliente verrebbe mai sincronizzato.
        email_marketing_consent: c.emailMarketingConsent
          ? {
              state: lower(c.emailMarketingConsent.marketingState),
              opt_in_level: lower(c.emailMarketingConsent.marketingOptInLevel),
            }
          : null,
        total_spent: c.amountSpent?.amount ?? null,
        orders_count: c.numberOfOrders != null ? Number(c.numberOfOrders) : null,
        state: lower(c.state),
        tags: (c.tags ?? []).join(', '),
        note: c.note,
        verified_email: c.verifiedEmail,
        tax_exempt: c.taxExempt,
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        // L'indirizzo predefinito, nella stessa forma piatta che la REST dava e
        // che il webhook dei clienti manda tuttora. Senza, la corsa periodica
        // riscriveva a null paese, via, CAP e regione che il webhook aveva
        // appena salvato: quattro colonne che si svuotavano da sole poche ore
        // dopo essersi riempite.
        default_address: c.defaultAddress
          ? {
              address1: c.defaultAddress.address1,
              address2: c.defaultAddress.address2,
              city: c.defaultAddress.city,
              province: c.defaultAddress.province,
              country: c.defaultAddress.country,
              // `countryCodeV2` e' il campo che restituisce la sigla a due
              // lettere; qui prende il nome piatto della REST perche' il
              // transformer legge la stessa chiave anche dal payload dei
              // webhook, che quella forma la manda tuttora.
              country_code: c.defaultAddress.countryCodeV2,
              zip: c.defaultAddress.zip,
            }
          : null,
        // La data di nascita non e' un campo dell'anagrafica Shopify: sta nel
        // metafield che il merchant ha scelto nella tab Clienti. Se non ne ha
        // scelto nessuno la chiave non compare affatto — che non e' lo stesso
        // che comparire vuota: assente significa "non l'ho chiesta, non
        // toccare la colonna", null significa "l'ho chiesta ed e' vuota".
        ...(birthdate ? { date_of_birth: c.metafield?.value ?? null } : {}),
      })),
      nextPageInfo: data.customers.pageInfo.hasNextPage ? data.customers.pageInfo.endCursor : null,
    };
  }

  /**
   * Un cliente riletto da Shopify, che e' la fonte canonica.
   *
   * `null` quando non c'e' piu': cancellato, unito a un altro, o fuori da cio'
   * che il negozio ci lascia leggere. Chi chiama non deve scambiarlo per una
   * riga vuota — non abbiamo letto niente, e su un non-letto non si cancella e
   * non si scrive.
   */
  async getCustomerById(
    customerId: number,
    options: { birthdateMetafield?: MetafieldKey | null } = {},
  ) {
    const { customers } = await this.getCustomers({
      limit: 1,
      customerId,
      birthdateMetafield: options.birthdateMetafield ?? null,
    });
    // Si controlla l'id invece di prendere il primo: il filtro di Shopify e'
    // una ricerca, e restituire un cliente diverso da quello chiesto vorrebbe
    // dire scrivere l'anagrafica di una persona sopra quella di un'altra.
    return customers.find((c) => c.id === customerId) ?? null;
  }

  /**
   * Le definizioni di metafield del CLIENTE presenti sul negozio.
   *
   * Riempiono la tendina con cui il merchant indica un campo che ha gia': senza
   * elenco resterebbe solo la casella in cui incollare la chiave a mano, e un
   * refuso li' produce una colonna vuota che nessuno sa spiegare.
   *
   * Il tipo viaggia con ognuna perche' serve a valle: puntare la data di
   * nascita a un campo che non contiene una data e' permesso, ma va detto.
   */
  async listCustomerMetafieldDefinitions(): Promise<
    { namespace: string; key: string; name: string; type: string }[]
  > {
    const data = await this.graphql<{
      metafieldDefinitions: {
        nodes: {
          namespace: string;
          key: string;
          name: string;
          type: { name: string } | null;
        }[];
      } | null;
    }>(
      `query CustomerMetafieldDefinitions($first: Int!) {
        metafieldDefinitions(ownerType: CUSTOMER, first: $first, sortKey: NAME) {
          nodes { namespace key name type { name } }
        }
      }`,
      // 250 e' il massimo per pagina, ed e' molto piu' del numero di
      // definizioni cliente che un negozio ha davvero: una tendina piu' lunga
      // di cosi' non si scorre comunque, e la casella da incollare copre il
      // caso limite.
      { first: 250 },
    );

    return (data.metafieldDefinitions?.nodes ?? []).map((d) => ({
      namespace: d.namespace,
      key: d.key,
      name: d.name,
      type: d.type?.name ?? '',
    }));
  }

  /**
   * C'e' gia' la definizione del metafield della data di nascita?
   *
   * Si chiede prima di proporre di abilitarla, e si richiede dopo averla
   * abilitata: la risposta e' l'unica cosa che autorizza a dire che il campo
   * c'e'. Dedurlo da un tentativo di scrittura andato a vuoto sarebbe peggio —
   * vorrebbe dire provare a scrivere sul negozio del merchant ogni volta che
   * apre la tab, per scoprire una cosa che una lettura dice meglio.
   */
  async hasCustomerBirthdateDefinition(): Promise<boolean> {
    const data = await this.graphql<{
      metafieldDefinitions: { nodes: { id: string }[] } | null;
    }>(
      `query BirthdateDefinition($namespace: String!, $key: String!) {
        metafieldDefinitions(
          ownerType: CUSTOMER
          namespace: $namespace
          key: $key
          first: 1
        ) {
          nodes { id }
        }
      }`,
      { namespace: BIRTHDATE_METAFIELD.namespace, key: BIRTHDATE_METAFIELD.key },
    );

    return (data.metafieldDefinitions?.nodes ?? []).length > 0;
  }

  /**
   * Le capability che QUESTA versione dell'API dichiara di conoscere.
   *
   * Serve perche' un campo sconosciuto in una input di GraphQL non viene
   * ignorato: fa fallire la richiesta in fase di validazione, prima che venga
   * eseguita. Chiederlo alla documentazione non basta — quella descrive la
   * versione piu' recente, non quella a cui siamo agganciati — mentre lo schema
   * risponde per la versione che stiamo davvero chiamando, qualunque essa sia.
   *
   * La risposta si tiene da parte per tutto il processo: dipende dalla versione
   * dell'API e non dal negozio, quindi non cambia fra una chiamata e l'altra.
   * Se la domanda non riesce si restituisce `null`, che a valle vuol dire "non
   * mandare capability": senza sapere cosa e' ammesso, non mandare niente e'
   * l'unica mossa che non rompe la mutation.
   */
  private async metafieldCapabilityFields(): Promise<ReadonlySet<string> | null> {
    if (capabilityFieldsCache !== undefined) return capabilityFieldsCache;

    try {
      const data = await this.graphql<{
        __type: { inputFields: { name: string }[] | null } | null;
      }>(
        `query MetafieldCapabilityFields {
          __type(name: "MetafieldCapabilityCreateInput") {
            inputFields { name }
          }
        }`,
      );
      const names = data.__type?.inputFields?.map((f) => f.name) ?? [];
      capabilityFieldsCache = names.length > 0 ? new Set(names) : null;
    } catch (error) {
      console.warn(
        '[shopify-api] capability dei metafield non interrogabili:',
        error instanceof Error ? error.message : 'errore sconosciuto',
      );
      capabilityFieldsCache = null;
    }

    return capabilityFieldsCache;
  }

  /**
   * Abilita sul negozio la definizione standard della data di nascita.
   *
   * Non `metafieldDefinitionCreate`: `facts` e' un namespace riservato di
   * Shopify e `facts.birth_date` una definizione standard gia' prevista, che
   * non si crea da zero ma si accende. La mutation giusta e'
   * `standardMetafieldDefinitionEnable`, e la differenza non e' formale — e'
   * lei che fa comparire il campo con il nome e la descrizione ufficiali,
   * tradotti da Shopify nella lingua del negozio, e che lo rende quello che
   * temi, segmenti e altre app si aspettano di trovare.
   *
   * Della definizione decidiamo solo cio' che la mutation lascia decidere: gli
   * accessi e il fatto che sia appuntata in cima alla scheda cliente. Nome,
   * descrizione e tipo sono di Shopify, ed e' precisamente il motivo per cui
   * questa e' la strada giusta.
   *
   * `TAKEN` vale come successo: e' la risposta a "questa chiave e' gia'
   * occupata", cioe' esattamente lo stato in cui volevamo arrivare. Serve anche
   * con la rilevazione a monte, perche' fra la lettura e la scrittura la
   * definizione puo' essere comparsa — due schede aperte, o il merchant che la
   * abilita a mano nell'admin.
   */
  async enableCustomerBirthdateDefinition(): Promise<boolean> {
    const capabilities = supportedCapabilities(
      BIRTHDATE_METAFIELD_CAPABILITIES,
      await this.metafieldCapabilityFields(),
    );

    const data = await this.graphql<{
      standardMetafieldDefinitionEnable: {
        createdDefinition: { id: string } | null;
        userErrors: { field: string[] | null; message: string; code: string | null }[];
      } | null;
    }>(
      `mutation EnableBirthdateDefinition(
        $namespace: String!
        $key: String!
        $access: StandardMetafieldDefinitionAccessInput
        $capabilities: MetafieldCapabilityCreateInput
      ) {
        standardMetafieldDefinitionEnable(
          ownerType: CUSTOMER
          namespace: $namespace
          key: $key
          access: $access
          capabilities: $capabilities
          pin: true
        ) {
          createdDefinition { id }
          userErrors { field message code }
        }
      }`,
      {
        namespace: BIRTHDATE_METAFIELD.namespace,
        key: BIRTHDATE_METAFIELD.key,
        access: BIRTHDATE_METAFIELD_ACCESS,
        // `null` e non l'omissione: la variabile e' dichiarata, e un argomento
        // nullo e' il modo di GraphQL per dire "lascia stare".
        capabilities: capabilities ?? null,
      },
    );

    const userErrors = data.standardMetafieldDefinitionEnable?.userErrors ?? [];
    if (userErrors.some((e) => e.code === 'TAKEN')) return true;

    // Ogni altro rifiuto e' un rifiuto: la mutation risponde 200 anche quando
    // non ha abilitato niente, e trattarlo come successo lascerebbe il merchant
    // davanti a un pulsante che dice "fatto" senza che sul suo negozio sia
    // comparso alcun campo.
    if (userErrors.length > 0) {
      throw new Error(
        `Shopify API error: ${userErrors.map((e) => e.message).join('; ').slice(0, 300)}`,
      );
    }

    return data.standardMetafieldDefinitionEnable?.createdDefinition != null;
  }

  /**
   * Scrive la data di nascita sul metafield del cliente, in blocco.
   *
   * E' la meta' che mancava alla data di nascita: finora il valore viaggiava
   * solo da Shopify verso il database del merchant, e quello che il merchant
   * scriveva a mano nella sua tabella non usciva di li' — nessun tema, nessun
   * segmento, nessuna automazione di Shopify poteva vederlo. Chi decide QUALI
   * clienti riscrivere sta in `customers/birthdate-writeback`; qui si scrive e
   * basta.
   *
   * `metafieldsSet` e non una mutation per cliente: ne accetta 25 per chiamata,
   * e su una corsa da centomila clienti la differenza fra 25 e 1 e' la
   * differenza fra una sincronizzazione che finisce e una che sbatte contro il
   * limite di chiamate.
   *
   * Gli errori non si alzano, si restituiscono. Un cliente rifiutato — sparito
   * nel frattempo, valore non gradito alla definizione — non deve far fallire
   * la sincronizzazione dei clienti, che di suo aveva gia' scritto tutto quello
   * che doveva.
   *
   * Ma si restituiscono CON IL NOME DI CHI: `failed` dice quali clienti non
   * sono stati scritti. Prima tornavano solo i messaggi, e chi chiamava sapeva
   * che qualcosa era stato rifiutato senza sapere cosa — quindi non poteva
   * segnarselo, quindi non poteva ritentarlo. E ritentare al giro dopo non
   * succedeva: la corsa successiva legge il delta, e un cliente la cui
   * scrittura NON e' andata non risulta cambiato, quindi nel delta non
   * ricompare.
   */
  async setCustomerBirthdates(
    entries: readonly { customerId: number; date: string }[],
    field: { namespace: string; key: string; type: string } = BIRTHDATE_METAFIELD,
  ): Promise<{
    written: number;
    errors: string[];
    failed: { customerId: number; reason: string }[];
  }> {
    let written = 0;
    const errors: string[] = [];
    const failed: { customerId: number; reason: string }[] = [];
    // Il tetto e' di Shopify, non nostro: oltre i 25 la mutation viene
    // rifiutata per intero, quindi le pagine da 250 clienti vanno spezzate qui
    // e non a monte.
    const BATCH = 25;

    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const data = await this.graphql<{
        metafieldsSet: {
          metafields: { id: string }[] | null;
          userErrors: { field: string[] | null; message: string }[];
        } | null;
      }>(
        `mutation SetCustomerBirthdates($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id }
            userErrors { field message }
          }
        }`,
        {
          metafields: batch.map((entry) => ({
            ownerId: `gid://shopify/Customer/${entry.customerId}`,
            namespace: field.namespace,
            key: field.key,
            type: field.type,
            value: entry.date,
          })),
        },
      );

      // Le mutation hanno un secondo canale d'errore, distinto da `errors`: un
      // rifiuto applicativo arriva qui, con la mutation formalmente riuscita.
      // Ignorarlo farebbe risultare scritto cio' che non lo e'.
      for (const error of data.metafieldsSet?.userErrors ?? []) {
        errors.push(error.message);

        // A quale cliente si riferisce. `field` di `metafieldsSet` porta il
        // percorso dentro l'elenco mandato — ["metafields","3","value"] — e
        // quel 3 e' l'indice nel lotto. Senza questa lettura si saprebbe che
        // qualcosa e' stato rifiutato ma non cosa, e un rifiuto che non si sa
        // attribuire non si puo' ritentare.
        const indice = indiceDelRifiuto(error.field);
        if (indice !== null && batch[indice]) {
          failed.push({ customerId: batch[indice].customerId, reason: error.message });
        } else {
          // Rifiuto senza indice: riguarda il lotto intero, e allora vale per
          // tutti. Meglio ritentare qualcuno che era passato che perdere
          // qualcuno che non lo era.
          for (const entry of batch) failed.push({ customerId: entry.customerId, reason: error.message });
        }
      }
      written += data.metafieldsSet?.metafields?.length ?? 0;
    }

    return { written, errors, failed };
  }

  /**
   * Un ordine con TUTTE le sue righe, e il bit che dice se ci siamo riusciti.
   *
   * Le righe si esauriscono qui dentro: `lines_complete` a `true` e' l'unica
   * cosa che autorizza chi scrive a cancellare per differenza, e va calcolata
   * dove si conosce l'esito della paginazione — non dedotta piu' in la'.
   */
  private async mapOrderWithAllLines(o: GqlOrder): Promise<ShopifyOrder> {
    // Un ordine da piu' di cento righe e' raro ma esiste (ingrosso, carrelli
    // composti a mano), e le righe che restassero fuori sarebbero venduto che
    // non entra nel margine: il profitto risulterebbe piu' alto del vero, cioe'
    // l'errore che meno si nota.
    const info = o.lineItems.pageInfo;
    let lineNodes = o.lineItems.nodes ?? [];
    let linesComplete = !!info && !info.hasNextPage;

    if (info?.hasNextPage) {
      const rest = await this.drainConnection<GqlOrderLineItem>({
        parentGid: o.id,
        parentType: 'Order',
        field: 'lineItems',
        nodeFields: LINE_ITEM_FIELDS,
        after: info.endCursor,
      });
      lineNodes = [...lineNodes, ...rest.nodes];
      linesComplete = rest.complete;
    }

    const currency = o.currentTotalPriceSet?.shopMoney.currencyCode ?? null;

    return {
      id: gidToId(o.id),
      order_number: o.name,
      placed_at: o.createdAt,
      updated_at: o.updatedAt,
      cancelled_at: o.cancelledAt,
      financial_status: lower(o.displayFinancialStatus),
      total_price: o.currentTotalPriceSet?.shopMoney.amount ?? null,
      currency,
      // null = acquisto senza account: l'ordine esiste, ma non appartiene a
      // nessun cliente da mettere in elenco.
      customer_id: o.customer ? gidToId(o.customer.id) : null,
      customer_first_name: o.customer?.firstName ?? null,
      customer_last_name: o.customer?.lastName ?? null,
      lines: lineNodes.map((l) => mapOrderLine(l, currency)),
      // Adesso serve davvero: le righe non si aggiungono piu' soltanto, chi
      // scrive cancella quelle sparite — ma solo con questo bit a `true`.
      lines_complete: linesComplete,
      ...mapOrderLogistics(o),
    };
  }

  /**
   * Gli ordini, una pagina alla volta.
   *
   * Di un ordine si prende il minimo che serve al profitto: quando, di chi, e
   * cosa conteneva. Niente indirizzi, telefoni, note — sono dati personali che
   * non servono a nessun conto e che quindi non entrano.
   */
  async getOrders(options: {
    limit?: number;
    pageInfo?: string;
    updatedAtMin?: string;
  } = {}): Promise<{ orders: ShopifyOrder[]; nextPageInfo: string | null }> {
    const data = await this.graphql<{
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: GqlOrder[];
      };
    }>(
      `query Orders($first: Int!, $after: String, $query: String) {
        orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes { ${orderNodeFields(LINE_ITEMS_FIRST_IN_LIST)} }
        }
      }`,
      {
        // Meno dei 250 dei clienti: ogni ordine si porta dietro le sue righe, e
        // una pagina da 250 ordini con cento righe l'uno supererebbe il costo
        // massimo di una query.
        first: options.limit || 50,
        after: options.pageInfo ?? null,
        query:
          !options.pageInfo && options.updatedAtMin
            ? `updated_at:>='${options.updatedAtMin}'`
            : null,
      },
    );

    const orders: ShopifyOrder[] = [];
    for (const o of data.orders.nodes) {
      orders.push(await this.mapOrderWithAllLines(o));
    }

    return {
      orders,
      nextPageInfo: data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null,
    };
  }

  /**
   * Un ordine solo, letto per intero.
   *
   * Esiste per i webhook, che dell'ordine ci mandano una ricevuta e non una
   * fotografia: il corpo REST porta `quantity` (quella ordinata, che dopo un
   * reso non cambia) e nessuno dei due campi canonici — `currentQuantity` e il
   * netto di riga — che sono proprio quelli su cui si fa il margine. Ricostruirli
   * dal payload significherebbe indovinarli, ed e' quello che si faceva.
   *
   * `null` quando l'ordine non e' piu' leggibile: cancellato fra la notifica e
   * la rilettura, oppure fuori dalla finestra che il negozio ci concede. Chi
   * chiama non deve trattarlo come "ordine vuoto" — non si e' letto niente, e su
   * un non-letto non si scrive e non si cancella.
   *
   * Qui l'ordine e' uno solo, quindi si chiede subito il massimo per pagina: le
   * code partono solo oltre le 250 righe.
   */
  async getOrderById(orderId: number): Promise<ShopifyOrder | null> {
    const data = await this.graphql<{ order: GqlOrder | null }>(
      `query Order($id: ID!) {
        order(id: $id) { ${orderNodeFields(NESTED_PAGE_SIZE)} }
      }`,
      { id: `gid://shopify/Order/${orderId}` },
    );

    if (!data.order) return null;
    return this.mapOrderWithAllLines(data.order);
  }

  async getCustomersCount(): Promise<number> {
    const data = await this.graphql<{ customersCount: { count: number } | null }>(
      '{ customersCount { count } }',
    );
    return typeof data.customersCount?.count === 'number' ? data.customersCount.count : 0;
  }

  /**
   * Canali di vendita collegati al negozio.
   *
   * Serve a sapere se qualcun altro sta gia' inviando eventi: i canali Meta,
   * Google e simili portano un tracciamento proprio, che non si puo' ne' leggere
   * ne' modificare da qui.
   */
  async getPublications(): Promise<{ name: string }[]> {
    const data = await this.graphql<{ publications: { nodes: { name: string }[] } }>(
      '{ publications(first: 50) { nodes { name } } }',
    );
    return data.publications?.nodes ?? [];
  }

  /**
   * Contenuto dei file indicati del tema pubblicato.
   *
   * Sola lettura, e solo i file richiesti: il tema del merchant e' roba sua, e
   * l'unica ragione per aprirlo e' cercarci codice di tracciamento che
   * entrerebbe in conflitto con il suo.
   */
  async getThemeFiles(filenames: string[]): Promise<{ filename: string; content: string }[]> {
    if (filenames.length === 0) return [];

    const data = await this.graphql<{
      themes: {
        nodes: {
          files: {
            nodes: { filename: string; body: { content?: string } | null }[];
          };
        }[];
      };
    }>(
      `query ThemeFiles($filenames: [String!]) {
        themes(first: 1, roles: MAIN) {
          nodes {
            files(first: 50, filenames: $filenames) {
              nodes {
                filename
                body { ... on OnlineStoreThemeFileBodyText { content } }
              }
            }
          }
        }
      }`,
      { filenames },
    );

    const files = data.themes?.nodes?.[0]?.files?.nodes ?? [];
    // I file binari (immagini, font) non hanno un corpo testuale: si scartano
    // invece di trattarli come vuoti, che nasconderebbe un errore vero.
    return files
      .filter((f) => typeof f.body?.content === 'string')
      .map((f) => ({ filename: f.filename, content: f.body!.content as string }));
  }

  /**
   * Tema pubblicato: id e nomi dei file, senza il loro contenuto.
   *
   * L'id serve a costruire il collegamento all'editor del codice: senza, si
   * potrebbe solo mandare il merchant nell'elenco dei temi a cercarselo.
   */
  async getPublishedTheme(): Promise<{ id: number | null; filenames: string[] }> {
    const data = await this.graphql<{
      themes: { nodes: { id: string; files: { nodes: { filename: string }[] } }[] };
    }>(
      `{
        themes(first: 1, roles: MAIN) {
          nodes { id files(first: 250) { nodes { filename } } }
        }
      }`,
    );
    const theme = data.themes?.nodes?.[0];
    return {
      id: gidToId(theme?.id),
      filenames: (theme?.files?.nodes ?? []).map((f) => f.filename),
    };
  }

  // Metadati del negozio. Serve iana_timezone (es. "Europe/Rome") per formattare
  // le date nel fuso del NEGOZIO: il server non puo' conoscere quello del browser,
  // e usare l'ora locale della macchina produrrebbe stringhe diverse fra render
  // server e idratazione client.
  async getShopInfo(): Promise<{
    ianaTimezone: string | null;
    /** Dominio su cui navigano i clienti: proprio se collegato, myshopify altrimenti. */
    primaryDomain: string | null;
    /**
     * La valuta con cui il negozio vende, che non e' quella di
     * `getBillingCurrency`: quella e' come il merchant paga noi, questa e' come
     * sono scritti i prezzi dei suoi prodotti. Serve al feed, dove ogni prezzo
     * viaggia con la valuta accanto.
     */
    currencyCode: string | null;
  }> {
    const data = await this.graphql<{
      shop: {
        ianaTimezone: string | null;
        primaryDomain: { host: string | null } | null;
        currencyCode: string | null;
      };
    }>('{ shop { ianaTimezone primaryDomain { host } currencyCode } }');

    const currency = data.shop?.currencyCode ?? null;
    return {
      ianaTimezone: data.shop?.ianaTimezone ?? null,
      primaryDomain: data.shop?.primaryDomain?.host ?? null,
      currencyCode: currency ? currency.trim().toUpperCase() : null,
    };
  }

  /**
   * La valuta in cui Shopify fattura QUESTO merchant.
   *
   * Non e' `shop.currencyCode`, che e' la valuta con cui il negozio vende ai
   * suoi clienti: qui interessa quella dei conti del merchant, che e' anche
   * quella in cui gli arriva la fattura dell'app.
   *
   * Query a se' e non in coda a getShopInfo: e' una domanda che l'API puo'
   * rifiutare (versione, permessi), e un rifiuto non deve portarsi via anche il
   * dominio e il fuso orario, che servono a cose ben piu' visibili.
   */
  async getBillingCurrency(): Promise<string | null> {
    const data = await this.graphql<{
      shopBillingPreferences: { currency: string | null } | null;
    }>('{ shopBillingPreferences { currency } }');

    const currency = data.shopBillingPreferences?.currency ?? null;
    return currency ? currency.trim().toUpperCase() : null;
  }
}
