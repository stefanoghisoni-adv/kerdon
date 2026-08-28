import { describe, it, expect } from 'vitest';

import {
  soldVariantsSQL,
  selectSoldProblemVariants,
  countSoldProblemVariants,
  countSoldWithoutCostInCatalog,
} from './sold-without-cost';
import { collectProblemVariants } from './product-readiness';
import { pageCount, pageSlice } from './problem-filter';
import type { ShopifyProduct } from '~/types/shopify';

// Un prodotto con una variante sola: `cost` a null significa costo mai
// impostato, cioe' esattamente la riga che la tab Prodotti elenca.
function product(id: number, cost: string | null): ShopifyProduct {
  return {
    id,
    title: `Prodotto ${id}`,
    body_html: '',
    vendor: '',
    product_type: '',
    handle: `p${id}`,
    status: 'active',
    tags: '',
    published_at: null,
    variants: [
      {
        id,
        product_id: id,
        title: 'Default Title',
        sku: `SKU-${id}`,
        barcode: null,
        price: '10.00',
        compare_at_price: null,
        cost,
        position: 1,
        inventory_quantity: 0,
        inventory_item_id: 1000 + id,
        weight: 0,
        weight_unit: 'kg',
        requires_shipping: true,
        taxable: true,
        image_id: null,
        option1: null,
        option2: null,
        option3: null,
      },
    ],
  };
}

describe('soldVariantsSQL — la definizione di "prodotto incluso in ordini"', () => {
  it('lascia fuori gli ordini annullati', () => {
    // E' la definizione che l'avviso annuncia al merchant ("ordini evasi e/o
    // pagati, non annullati") ed e' la stessa di countsAsSale e della tab
    // Clienti: una definizione sola per tutta l'app.
    expect(soldVariantsSQL(null)).toContain('o.cancelled_at IS NULL');
  });

  it('tiene dentro i rimborsati: il rimborso azzera l’incasso, non la vendita', () => {
    // Un ordine rimborsato ha comunque fatto uscire il prodotto, e senza costo
    // quel margine resta impossibile da calcolare. Nessun filtro su
    // financial_status, quindi.
    expect(soldVariantsSQL(null)).not.toContain('financial_status');
  });

  it('parte dalle righe d’ordine passando dagli ordini, non dalle sole righe', () => {
    // Senza la join non ci sarebbe niente su cui verificare l'annullamento: era
    // cosi' che l'elenco contava anche gli annullati mentre l'avviso no.
    const sql = soldVariantsSQL(null);
    expect(sql).toContain('FROM order_lines l');
    expect(sql).toContain('JOIN orders o ON o.shopify_order_id = l.shopify_order_id');
  });

  it('restringendo a un cliente aggiunge il suo id e il suo nome', () => {
    const sql = soldVariantsSQL(42);
    expect(sql).toContain('o.shopify_customer_id = 42');
    expect(sql).toContain('customer_first_name');
    expect(sql).toContain('o.cancelled_at IS NULL');
  });

  it('un id cliente non valido vale come "nessun cliente" e non finisce nella query', () => {
    // L'id arriva dalla URL: qui viene interpolato, quindi tutto cio' che non e'
    // un intero positivo deve sparire invece di essere scritto nell'SQL.
    expect(soldVariantsSQL(-1)).not.toContain('shopify_customer_id');
    expect(soldVariantsSQL(1.5)).not.toContain('shopify_customer_id');
  });
});

describe('l’avviso e l’elenco rispondono allo stesso numero', () => {
  it('cinque prodotti venduti senza costo: cinque annunciati, cinque elencati', () => {
    const catalog = [1, 2, 3, 4, 5].map((id) => product(id, null));
    const sold = new Set([1, 2, 3, 4, 5]);

    const rows = selectSoldProblemVariants(collectProblemVariants(catalog), sold);
    expect(rows).toHaveLength(5);
    expect(countSoldWithoutCostInCatalog(catalog, sold)).toBe(5);
  });

  it('il numero annunciato e’ il totale, non la pagina che si vede', () => {
    // Venticinque righe su pagine da venti: l'avviso deve dire venticinque, e la
    // prima pagina mostrarne venti. Le due cose non si contraddicono, ma il
    // numero dell'avviso non va mai preso dalla pagina.
    const ids = Array.from({ length: 25 }, (_, i) => i + 1);
    const catalog = ids.map((id) => product(id, null));
    const sold = new Set(ids);

    const rows = selectSoldProblemVariants(collectProblemVariants(catalog), sold);
    expect(countSoldProblemVariants(collectProblemVariants(catalog), sold)).toBe(rows.length);
    expect(rows).toHaveLength(25);
    expect(pageCount(rows.length, 20)).toBe(2);
    expect(pageSlice(rows, 1, 20)).toHaveLength(20);
    expect(pageSlice(rows, 2, 20)).toHaveLength(5);
  });

  it('un prodotto senza costo mai venduto resta fuori da entrambi', () => {
    const catalog = [product(1, null), product(2, null)];
    const sold = new Set([1]);

    expect(selectSoldProblemVariants(collectProblemVariants(catalog), sold)).toHaveLength(1);
    expect(countSoldWithoutCostInCatalog(catalog, sold)).toBe(1);
  });

  it('IL CASO DEL DIFETTO: venduti con il costo gia’ messo non si annunciano', () => {
    // Era questo a far dire "5" all'avviso e mostrare una riga sola. L'avviso
    // chiedeva al database del merchant quali varianti vendute non avessero una
    // riga in `products`; ma li' dentro finiscono solo i prodotti idonei e solo
    // fino al tetto del piano, quindi quattro prodotti venduti col loro bravo
    // costo su Shopify — fuori dal tetto, o non ancora sincronizzati — non
    // avevano riga e venivano annunciati lo stesso. L'elenco, che il costo lo
    // chiede a Shopify, non poteva mostrarli: non e' senza costo.
    //
    // Adesso anche il conteggio parte dal costo vero, quindi quei quattro non ci
    // sono ne' di qua ne' di la'.
    const catalog = [
      product(1, null),
      product(2, '4.50'),
      product(3, '4.50'),
      product(4, '4.50'),
      product(5, '4.50'),
    ];
    const sold = new Set([1, 2, 3, 4, 5]);

    expect(countSoldWithoutCostInCatalog(catalog, sold)).toBe(1);
    expect(selectSoldProblemVariants(collectProblemVariants(catalog), sold)).toHaveLength(1);
  });

  it('costo "0.00" e’ un costo dichiarato: non e’ un problema', () => {
    const catalog = [product(1, '0.00')];
    expect(countSoldWithoutCostInCatalog(catalog, new Set([1]))).toBe(0);
  });
});

describe('quando non si sa che cosa sia stato venduto', () => {
  it('l’elenco mostra tutto: nascondere righe non verificate direbbe il falso', () => {
    const rows = collectProblemVariants([product(1, null), product(2, null)]);
    expect(selectSoldProblemVariants(rows, null)).toHaveLength(2);
  });

  it('l’avviso invece tace: parla di venduti, e di venduti non ne conosce', () => {
    const rows = collectProblemVariants([product(1, null), product(2, null)]);
    expect(countSoldProblemVariants(rows, null)).toBe(0);
  });
});
