import { loadFeedSource } from './feed.server';
import { feedTitle, issuesFor, severityOf, type IssueCode } from './meta';

/**
 * Il catalogo come lo vede il merchant: una riga per prodotto, e accanto cosa
 * non va.
 *
 * E' la stessa lettura che alimenta il file, guardata dall'altro lato. Il feed
 * scarta in silenzio le righe che Meta rifiuterebbe; questa tabella e' il posto
 * dove quel silenzio viene rotto — altrimenti il merchant scopre il buco
 * contando i prodotti dentro Commerce Manager.
 */

export interface CatalogRow {
  /** L'id che finisce nel feed: la variante, o il prodotto se non ne ha. */
  id: string;
  productId: string;
  title: string;
  imageUrl: string | null;
  price: number | null;
  status: string | null;
  issues: IssueCode[];
  /** Se true, questa riga non entra nel file. */
  blocked: boolean;
}

export interface CatalogReport {
  rows: CatalogRow[];
  /** Quante righe entrano nel feed. */
  included: number;
  /** Quante Meta scarterebbe. */
  blocked: number;
  /** Quante entrano, ma con qualcosa da sistemare. */
  warned: number;
  currency: string;
  domain: string;
  /** null quando il database non e' collegato: la tabella non ha da dove nascere. */
  unavailable: 'not_connected' | null;
}

const EMPTY: CatalogReport = {
  rows: [],
  included: 0,
  blocked: 0,
  warned: 0,
  currency: 'EUR',
  domain: '',
  unavailable: 'not_connected',
};

function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function loadCatalogReport(shopId: string): Promise<CatalogReport> {
  const source = await loadFeedSource(shopId);
  if (!source) return EMPTY;

  let included = 0;
  let blocked = 0;
  let warned = 0;

  const rows: CatalogRow[] = source.products.map((product) => {
    const issues = issuesFor(product);
    const isBlocked = issues.some((code) => severityOf(code) === 'blocking');

    if (isBlocked) blocked += 1;
    else {
      included += 1;
      if (issues.length > 0) warned += 1;
    }

    return {
      id: String(product.shopify_variant_id ?? product.shopify_product_id),
      productId: String(product.shopify_product_id),
      title: feedTitle(product) || '—',
      imageUrl: product.image_url,
      price: num(product.price),
      status: product.product_status,
      issues,
      blocked: isBlocked,
    };
  });

  // Prima quelle da sistemare: una tabella che si apre sui prodotti a posto
  // nasconde il lavoro da fare sotto lo scorrimento, ed e' l'unico motivo per
  // cui questa pagina esiste.
  rows.sort((a, b) => {
    const weight = (row: CatalogRow) => (row.blocked ? 0 : row.issues.length > 0 ? 1 : 2);
    return weight(a) - weight(b) || a.title.localeCompare(b.title);
  });

  return {
    rows,
    included,
    blocked,
    warned,
    currency: source.currency,
    domain: source.domain,
    unavailable: null,
  };
}
