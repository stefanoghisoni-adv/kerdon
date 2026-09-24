import { describe, it, expect } from 'vitest';
import {
  isVariantReady,
  computeProductReadiness,
  collectProblemVariants,
  countEligibleProducts,
} from './product-readiness';
import type { ShopifyProduct } from '~/types/shopify';

function makeProduct(
  costs: (string | null)[],
  overrides: Partial<ShopifyProduct> = {},
): ShopifyProduct {
  return {
    id: 1, title: 't', body_html: '', vendor: '', product_type: '', handle: 'h',
    status: 'active', tags: '', published_at: null,
    variants: costs.map((cost, i) => ({
      id: i + 1, product_id: 1, title: `v${i}`, sku: '', barcode: null,
      price: '10.00', compare_at_price: null, cost, position: i + 1,
      inventory_quantity: 0, weight: 0, weight_unit: 'kg',
      requires_shipping: true, taxable: true, image_id: null,
      option1: null, option2: null, option3: null,
    })),
    ...overrides,
  };
}

describe('isVariantReady', () => {
  it('is true when cost is a non-empty string (including "0.00")', () => {
    expect(isVariantReady('12.50')).toBe(true);
    expect(isVariantReady('0.00')).toBe(true);
  });
  it('is false when cost is null, undefined or blank', () => {
    expect(isVariantReady(null)).toBe(false);
    expect(isVariantReady(undefined)).toBe(false);
    expect(isVariantReady('   ')).toBe(false);
  });
});

describe('computeProductReadiness', () => {
  it('counts products and classifies each variant by cost', () => {
    const products = [makeProduct(['5.00', null]), makeProduct(['3.00'])];
    expect(computeProductReadiness(products)).toEqual({
      totalProducts: 2,
      readyCount: 2,
      problemCount: 1,
    });
  });
  it('returns zeros for an empty catalog', () => {
    expect(computeProductReadiness([])).toEqual({
      totalProducts: 0, readyCount: 0, problemCount: 0,
    });
  });
});

describe('collectProblemVariants', () => {
  it('returns one row per variant missing cost_per_item, with product/variant details', () => {
    const products = [
      makeProduct(['5.00', null], { id: 10, title: 'Maglietta' }),
    ];
    // La seconda variante (index 1) ha cost null → è quella problematica.
    products[0].variants[1].sku = 'SKU-2';
    products[0].variants[1].title = 'Rossa / M';

    products[0].variants[1].inventory_item_id = 999;

    const rows = collectProblemVariants(products);
    expect(rows).toEqual([
      {
        productId: 10,
        productTitle: 'Maglietta',
        variantId: 2,
        variantTitle: 'Rossa / M',
        sku: 'SKU-2',
        price: '10.00',
        inventoryItemId: 999,
        missingField: 'cost_per_item',
        // Nessun costo: e' la ragione per cui questa riga e' nell'elenco, ed e'
        // cio' che dice alla tab che non ha un passato da proteggere.
        previousCost: null,
      },
    ]);
  });

  it('normalizes an empty sku to null and skips ready variants', () => {
    const rows = collectProblemVariants([makeProduct(['3.00', '   '])]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sku).toBeNull();
    expect(rows[0].variantId).toBe(2);
  });

  it('returns an empty list when every variant is ready', () => {
    expect(collectProblemVariants([makeProduct(['1.00', '2.00'])])).toEqual([]);
  });

  it('collectProblemVariants riporta il prezzo della variante', () => {
    const rows = collectProblemVariants([
      {
        id: 1,
        title: 'Prodotto',
        variants: [
          { id: 11, title: 'S', sku: 'A1', price: '29.90', cost: null, inventory_item_id: 111 },
        ],
      },
    ] as any);
    expect(rows[0].price).toBe('29.90');
  });

  it('collectProblemVariants mette null se il prezzo manca', () => {
    const rows = collectProblemVariants([
      {
        id: 2,
        title: 'Senza prezzo',
        variants: [{ id: 21, title: 'M', sku: null, cost: null, inventory_item_id: 211 }],
      },
    ] as any);
    expect(rows[0].price).toBeNull();
  });
});

describe('countEligibleProducts', () => {
  it('conta 1 quando un prodotto ha 3 varianti di cui 1 con costo', () => {
    const products = [makeProduct(['5.00', null, null])];
    expect(countEligibleProducts(products)).toBe(1);
  });

  it('conta 0 quando un prodotto ha tutte le varianti senza costo', () => {
    const products = [makeProduct([null, null])];
    expect(countEligibleProducts(products)).toBe(0);
  });

  it('conta 2 quando ci sono due prodotti idonei e uno non idoneo', () => {
    const products = [
      makeProduct(['5.00'], { id: 1 }),
      makeProduct(['3.00'], { id: 2 }),
      makeProduct([null], { id: 3 }),
    ];
    expect(countEligibleProducts(products)).toBe(2);
  });

  it('conta il prodotto come idoneo quando una variante ha costo "0.00"', () => {
    const products = [makeProduct(['0.00'])];
    expect(countEligibleProducts(products)).toBe(1);
  });
});
