import type { ShopifyProduct } from '~/types/shopify';

export interface ProductReadinessCounts {
  totalProducts: number;
  readyCount: number;
  problemCount: number;
}

export function isVariantReady(cost: string | null | undefined): boolean {
  return cost !== null && cost !== undefined && String(cost).trim() !== '';
}

export function computeProductReadiness(
  products: ShopifyProduct[],
): ProductReadinessCounts {
  let readyCount = 0;
  let problemCount = 0;
  for (const product of products) {
    for (const variant of product.variants) {
      if (isVariantReady(variant.cost)) readyCount++;
      else problemCount++;
    }
  }
  return { totalProducts: products.length, readyCount, problemCount };
}

// Prodotti DISTINTI con almeno una variante idonea. Unita' diversa da
// readyCount, che conta le varianti: il tetto del piano (maxProducts) si applica
// ai prodotti, quindi e' questo il numero da confrontare con quella soglia.
export function countEligibleProducts(products: ShopifyProduct[]): number {
  return products.filter((p) => p.variants.some((v) => isVariantReady(v.cost))).length;
}

// Riga di dettaglio per la tabella "Prodotti con problemi": una variante a cui
// manca il valore richiesto (oggi cost_per_item, coerente con problemCount).
export interface ProblemVariant {
  productId: number;
  productTitle: string;
  variantId: number;
  variantTitle: string;
  sku: string | null;
  // Prezzo come stringa, cosi' come lo restituisce Shopify: serve alla ricerca e
  // alla colonna Prezzo. Convertirlo in numero non aggiungerebbe nulla e
  // introdurrebbe arrotondamenti.
  price: string | null;
  // Serve per scrivere il costo: il cost_per_item si aggiorna sull'InventoryItem.
  inventoryItemId: number | null;
  missingField: 'cost_per_item';
  /**
   * Il costo che la variante ha adesso, cioe' quello che diventerebbe il costo
   * "di prima" nel momento in cui il merchant ne scrive uno nuovo.
   *
   * Oggi e' sempre null, ed e' proprio il punto: qui entrano solo le varianti a
   * cui il costo manca. Serve alla tab per sapere che non ha niente da chiedere
   * — la domanda "questo costo vale anche per il passato?" ha senso solo se un
   * costo precedente esiste, e con quello che non c'e' le due risposte fanno la
   * stessa cosa. Sta scritto come dato invece che dato per scontato perche' il
   * giorno in cui questo elenco mostrasse anche varianti con un costo (un
   * costo assurdo, per dire) la domanda tornerebbe da sola, invece di restare
   * una condizione da ricordarsi a mano.
   */
  previousCost: string | null;
}

export function collectProblemVariants(
  products: ShopifyProduct[],
): ProblemVariant[] {
  const rows: ProblemVariant[] = [];
  for (const product of products) {
    for (const variant of product.variants) {
      if (isVariantReady(variant.cost)) continue;
      rows.push({
        productId: product.id,
        productTitle: product.title,
        variantId: variant.id,
        variantTitle: variant.title ?? '',
        sku: variant.sku ? variant.sku : null,
        price: variant.price ?? null,
        inventoryItemId: variant.inventory_item_id ?? null,
        missingField: 'cost_per_item',
        previousCost: variant.cost ?? null,
      });
    }
  }
  return rows;
}
