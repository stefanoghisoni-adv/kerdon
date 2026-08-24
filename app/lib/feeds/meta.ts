/**
 * Il catalogo, come lo vuole Meta.
 *
 * Meta non si collega a niente: scarica un file da un indirizzo, ogni giorno, e
 * di quel file decide riga per riga. Una riga a cui manca un campo obbligatorio
 * non viene corretta ne' segnalata: viene scartata, e il prodotto semplicemente
 * non esiste nelle inserzioni. Il merchant lo scopre settimane dopo, guardando
 * un catalogo piu' corto del suo negozio.
 *
 * Da qui la divisione che regge tutto il resto: c'e' cio' che fa scartare la
 * riga, e c'e' cio' che la fa passare male. Le due cose non si possono mostrare
 * con lo stesso colore.
 */

/** Una riga del catalogo del merchant, come sta nel suo database. */
export interface FeedProduct {
  shopify_product_id: number | string;
  shopify_variant_id: number | string | null;
  product_title: string | null;
  product_description: string | null;
  vendor: string | null;
  product_type: string | null;
  handle: string | null;
  product_status: string | null;
  variant_title: string | null;
  sku: string | null;
  barcode: string | null;
  price: number | string | null;
  compare_at_price: number | string | null;
  inventory_quantity: number | null;
  inventory_tracked: boolean | null;
  inventory_policy: string | null;
  image_url: string | null;
}

/**
 * Perche' una riga non va bene.
 *
 * I codici restano codici: la frase da mostrare la sceglie il dizionario, in
 * una lingua che qui non si conosce.
 */
export type IssueCode =
  // Scartata da Meta.
  | 'no_title'
  | 'no_price'
  | 'no_image'
  | 'no_link'
  | 'not_active'
  // Accettata, ma peggio.
  | 'no_description'
  | 'no_brand'
  | 'no_gtin'
  | 'title_too_long'
  | 'out_of_stock';

/**
 * `blocking` = Meta scarta la riga. `warning` = la accetta, ma il prodotto
 * rende meno: senza marca e senza codice a barre non entra nelle
 * corrispondenze automatiche, senza descrizione perde le inserzioni dinamiche.
 */
export type Severity = 'blocking' | 'warning';

const SEVERITY: Record<IssueCode, Severity> = {
  no_title: 'blocking',
  no_price: 'blocking',
  no_image: 'blocking',
  no_link: 'blocking',
  not_active: 'blocking',
  no_description: 'warning',
  no_brand: 'warning',
  no_gtin: 'warning',
  title_too_long: 'warning',
  out_of_stock: 'warning',
};

export function severityOf(code: IssueCode): Severity {
  return SEVERITY[code];
}

/** Meta taglia i titoli oltre questa lunghezza. */
export const TITLE_MAX = 200;

function text(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function amount(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Il titolo che va nel feed: prodotto e variante insieme, perche' nel catalogo
 * di Meta ogni variante e' un articolo a se' e tre righe chiamate tutte
 * "T-shirt" sono indistinguibili per chi le guarda.
 */
export function feedTitle(product: FeedProduct): string {
  const base = text(product.product_title);
  const variant = text(product.variant_title);
  // Shopify chiama cosi' la variante unica dei prodotti che non ne hanno:
  // aggiungerla al titolo direbbe "Maglietta - Default Title".
  if (!variant || variant === 'Default Title') return base;
  return base ? `${base} - ${variant}` : variant;
}

/**
 * Disponibile o no, nel vocabolario di Meta.
 *
 * Un prodotto senza magazzino tracciato e' sempre disponibile: e' cosi' che
 * Shopify tratta i servizi e i prodotti su ordinazione, e dichiararli esauriti
 * li toglierebbe dalle inserzioni senza motivo.
 */
export function availability(product: FeedProduct): 'in stock' | 'out of stock' {
  if (product.inventory_tracked === false) return 'in stock';
  if (product.inventory_policy === 'continue') return 'in stock';
  const qty = product.inventory_quantity;
  if (qty === null || qty === undefined) return 'in stock';
  return qty > 0 ? 'in stock' : 'out of stock';
}

/**
 * Tutti i problemi di una riga, nell'ordine in cui contano.
 *
 * Prima cio' che la fa sparire, poi cio' che la fa rendere meno: il tooltip si
 * legge dall'alto, e la prima riga deve essere quella che spiega perche' il
 * prodotto non c'e'.
 */
export function issuesFor(product: FeedProduct): IssueCode[] {
  const issues: IssueCode[] = [];
  const title = feedTitle(product);
  const price = amount(product.price);

  if (!title) issues.push('no_title');
  if (price === null || price <= 0) issues.push('no_price');
  if (!text(product.image_url)) issues.push('no_image');
  if (!text(product.handle)) issues.push('no_link');
  // Bozze e archiviati non hanno una pagina pubblica: il link del feed
  // porterebbe Meta su un 404, e il catalogo lo segnala come errore.
  if (text(product.product_status).toLowerCase() !== 'active') issues.push('not_active');

  if (!text(product.product_description)) issues.push('no_description');
  if (!text(product.vendor)) issues.push('no_brand');
  if (!text(product.barcode)) issues.push('no_gtin');
  if (title.length > TITLE_MAX) issues.push('title_too_long');
  if (availability(product) === 'out of stock') issues.push('out_of_stock');

  return issues;
}

export function isBlocked(product: FeedProduct): boolean {
  return issuesFor(product).some((code) => severityOf(code) === 'blocking');
}

/** Un articolo del catalogo Meta, con i nomi dei campi che Meta si aspetta. */
export interface MetaItem {
  id: string;
  item_group_id: string;
  title: string;
  description: string;
  availability: string;
  condition: string;
  price: string;
  sale_price?: string;
  link: string;
  image_link: string;
  brand: string;
  gtin?: string;
  mpn?: string;
  product_type?: string;
  quantity_to_sell_on_facebook?: string;
}

/**
 * L'indirizzo pubblico del prodotto sul negozio del merchant.
 *
 * Con la variante in coda: senza, tre articoli diversi porterebbero alla stessa
 * pagina con la stessa taglia preselezionata, e chi arriva dall'inserzione
 * trova un prodotto che non e' quello su cui ha cliccato.
 */
export function productLink(domain: string, product: FeedProduct): string {
  const base = `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  const url = `${base}/products/${text(product.handle)}`;
  return product.shopify_variant_id ? `${url}?variant=${product.shopify_variant_id}` : url;
}

/**
 * Da riga del database ad articolo del catalogo.
 *
 * Restituisce null per le righe che Meta scarterebbe: e' meglio un feed piu'
 * corto di un feed che Meta segnala come pieno di errori — un catalogo con
 * troppe righe rifiutate viene sospeso per intero.
 */
export function toMetaItem(
  product: FeedProduct,
  opts: { domain: string; currency: string },
): MetaItem | null {
  if (isBlocked(product)) return null;

  const price = amount(product.price);
  if (price === null) return null;
  const compareAt = amount(product.compare_at_price);
  const money = (value: number) => `${value.toFixed(2)} ${opts.currency}`;

  const item: MetaItem = {
    id: String(product.shopify_variant_id ?? product.shopify_product_id),
    item_group_id: String(product.shopify_product_id),
    title: feedTitle(product).slice(0, TITLE_MAX),
    // Meta rifiuta la descrizione vuota: il titolo e' il ripiego meno peggio,
    // ed e' comunque una descrizione vera del prodotto.
    description: text(product.product_description) || feedTitle(product),
    availability: availability(product),
    condition: 'new',
    // Il prezzo pieno resta il prezzo pieno: quando c'e' un compare_at, e' quello
    // il listino e il prezzo corrente diventa il saldo. Invertirli farebbe
    // sparire lo sconto dall'inserzione.
    price: money(compareAt && compareAt > price ? compareAt : price),
    link: productLink(opts.domain, product),
    image_link: text(product.image_url),
    brand: text(product.vendor),
  };

  if (compareAt && compareAt > price) item.sale_price = money(price);
  if (text(product.barcode)) item.gtin = text(product.barcode);
  if (text(product.sku)) item.mpn = text(product.sku);
  if (text(product.product_type)) item.product_type = text(product.product_type);
  if (typeof product.inventory_quantity === 'number' && product.inventory_quantity > 0) {
    item.quantity_to_sell_on_facebook = String(product.inventory_quantity);
  }

  return item;
}
