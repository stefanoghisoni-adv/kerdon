import { unauthenticated } from '~/shopify.server';

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

const LINE_ITEM_FIELDS = `
  id title quantity
  product { id }
  variant { id }
  discountedUnitPriceSet { shopMoney { amount } }
  originalUnitPriceSet { shopMoney { amount } }
  totalDiscountSet { shopMoney { amount } }
`;

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
    this.apiVersion = process.env.SHOPIFY_API_VERSION || '2025-01';
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

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
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
      throw new Error(
        `Shopify API error: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`,
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
      throw new Error(`Shopify API error: ${JSON.stringify(body.errors).slice(0, 300)}`);
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
          id title descriptionHtml vendor productType handle status tags publishedAt createdAt
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
  } = {}) {
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
        }[];
      };
    }>(
      `query Customers($first: Int!, $after: String, $query: String) {
        customers(first: $first, after: $after, query: $query) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id email phone firstName lastName
            emailMarketingConsent { marketingState marketingOptInLevel }
            amountSpent { amount }
            numberOfOrders
            state tags note verifiedEmail taxExempt createdAt updatedAt
          }
        }
      }`,
      {
        first: options.limit || 250,
        after: options.pageInfo ?? null,
        query: !options.pageInfo && options.updatedAtMin ? `updated_at:>='${options.updatedAtMin}'` : null,
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
      })),
      nextPageInfo: data.customers.pageInfo.hasNextPage ? data.customers.pageInfo.endCursor : null,
    };
  }

  /**
   * Gli ordini, una pagina alla volta.
   *
   * Di un ordine si prende il minimo che serve al profitto: quando, di chi, e
   * cosa conteneva. Niente indirizzi, telefoni, note — sono dati personali che
   * non servono a nessun conto e che quindi non entrano.
   *
   * Il prezzo di riga e' quello scontato (`discountedUnitPriceSet`): il margine
   * si fa su cio' che e' entrato in cassa, non sul listino. Se manca si ripiega
   * sull'originale, che e' comunque meglio di una riga senza prezzo.
   */
  async getOrders(options: {
    limit?: number;
    pageInfo?: string;
    updatedAtMin?: string;
  } = {}) {
    const data = await this.graphql<{
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          name: string | null;
          createdAt: string | null;
          updatedAt: string | null;
          cancelledAt: string | null;
          displayFinancialStatus: string | null;
          currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } } | null;
          customer: { id: string; firstName: string | null; lastName: string | null } | null;
          lineItems: GqlConnection<{
            id: string;
            title: string | null;
            quantity: number | null;
            product: { id: string } | null;
            variant: { id: string } | null;
            discountedUnitPriceSet: { shopMoney: { amount: string } } | null;
            originalUnitPriceSet: { shopMoney: { amount: string } } | null;
            totalDiscountSet: { shopMoney: { amount: string } } | null;
          }>;
        }[];
      };
    }>(
      `query Orders($first: Int!, $after: String, $query: String) {
        orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id name createdAt updatedAt cancelledAt displayFinancialStatus
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            customer { id firstName lastName }
            lineItems(first: ${LINE_ITEMS_FIRST_IN_LIST}) {
              pageInfo { hasNextPage endCursor }
              nodes { ${LINE_ITEM_FIELDS} }
            }
          }
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

    // Un ordine da piu' di cento righe e' raro ma esiste (ingrosso, carrelli
    // composti a mano), e le righe che restassero fuori sarebbero venduto che
    // non entra nel margine: il profitto risulterebbe piu' alto del vero, cioe'
    // l'errore che meno si nota.
    const orders = [];
    for (const o of data.orders.nodes) {
      const info = o.lineItems.pageInfo;
      let lineNodes = o.lineItems.nodes ?? [];
      let linesComplete = !!info && !info.hasNextPage;

      if (info?.hasNextPage) {
        const rest = await this.drainConnection<(typeof lineNodes)[number]>({
          parentGid: o.id,
          parentType: 'Order',
          field: 'lineItems',
          nodeFields: LINE_ITEM_FIELDS,
          after: info.endCursor,
        });
        lineNodes = [...lineNodes, ...rest.nodes];
        linesComplete = rest.complete;
      }

      orders.push({
        id: gidToId(o.id),
        order_number: o.name,
        placed_at: o.createdAt,
        updated_at: o.updatedAt,
        cancelled_at: o.cancelledAt,
        financial_status: lower(o.displayFinancialStatus),
        total_price: o.currentTotalPriceSet?.shopMoney.amount ?? null,
        currency: o.currentTotalPriceSet?.shopMoney.currencyCode ?? null,
        // null = acquisto senza account: l'ordine esiste, ma non appartiene a
        // nessun cliente da mettere in elenco.
        customer_id: o.customer ? gidToId(o.customer.id) : null,
        customer_first_name: o.customer?.firstName ?? null,
        customer_last_name: o.customer?.lastName ?? null,
        lines: lineNodes.map((l) => ({
          id: gidToId(l.id),
          title: l.title,
          quantity: l.quantity ?? 0,
          product_id: l.product ? gidToId(l.product.id) : null,
          variant_id: l.variant ? gidToId(l.variant.id) : null,
          unit_price:
            l.discountedUnitPriceSet?.shopMoney.amount ??
            l.originalUnitPriceSet?.shopMoney.amount ??
            null,
          total_discount: l.totalDiscountSet?.shopMoney.amount ?? null,
        })),
        // Le righe d'ordine oggi si aggiungono soltanto, nessuno le cancella per
        // differenza. Il bit viaggia comunque, cosi' chi un domani volesse
        // riconciliarle trova gia' la sola cosa che glielo permette.
        lines_complete: linesComplete,
      });
    }

    return {
      orders,
      nextPageInfo: data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null,
    };
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
