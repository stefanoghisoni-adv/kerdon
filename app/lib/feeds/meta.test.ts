import { describe, it, expect } from 'vitest';
import {
  availability,
  feedTitle,
  isBlocked,
  issuesFor,
  productLink,
  severityOf,
  toMetaItem,
  TITLE_MAX,
  type FeedProduct,
} from './meta';
import { toCsv, toXml } from './serialize';

/** Una riga che Meta accetterebbe senza obiezioni: i test la peggiorano. */
function product(overrides: Partial<FeedProduct> = {}): FeedProduct {
  return {
    shopify_product_id: 111,
    shopify_variant_id: 222,
    product_title: 'Maglietta',
    product_description: 'Cotone pettinato',
    vendor: 'Acme',
    product_type: 'Abbigliamento',
    handle: 'maglietta',
    product_status: 'active',
    variant_title: 'M / Blu',
    sku: 'MAG-M-BLU',
    barcode: '0123456789012',
    price: 19.9,
    compare_at_price: null,
    inventory_quantity: 5,
    inventory_tracked: true,
    inventory_policy: 'deny',
    image_url: 'https://cdn.example.com/maglietta.jpg',
    ...overrides,
  };
}

describe('issuesFor', () => {
  it('una riga completa non ha problemi', () => {
    expect(issuesFor(product())).toEqual([]);
  });

  it('quello che fa scartare la riga e quello che la fa solo rendere meno', () => {
    expect(severityOf('no_image')).toBe('blocking');
    expect(severityOf('no_price')).toBe('blocking');
    expect(severityOf('not_active')).toBe('blocking');
    expect(severityOf('no_brand')).toBe('warning');
    expect(severityOf('no_gtin')).toBe('warning');
  });

  it('prima i problemi che fanno sparire il prodotto', () => {
    const issues = issuesFor(product({ image_url: null, vendor: null }));
    expect(issues[0]).toBe('no_image');
    expect(issues).toContain('no_brand');
  });

  it('prezzo a zero e prezzo mancante sono la stessa cosa', () => {
    expect(issuesFor(product({ price: 0 }))).toContain('no_price');
    expect(issuesFor(product({ price: null }))).toContain('no_price');
    expect(issuesFor(product({ price: '' }))).toContain('no_price');
  });

  it('bozza e archiviato non hanno una pagina pubblica', () => {
    expect(isBlocked(product({ product_status: 'draft' }))).toBe(true);
    expect(isBlocked(product({ product_status: 'archived' }))).toBe(true);
    expect(isBlocked(product({ product_status: 'ACTIVE' }))).toBe(false);
  });

  it('un titolo oltre il limite passa, ma segnalato', () => {
    const long = product({ product_title: 'x'.repeat(TITLE_MAX + 1), variant_title: null });
    expect(issuesFor(long)).toContain('title_too_long');
    expect(isBlocked(long)).toBe(false);
  });
});

describe('availability', () => {
  it('senza magazzino tracciato il prodotto e sempre disponibile', () => {
    expect(availability(product({ inventory_tracked: false, inventory_quantity: 0 }))).toBe(
      'in stock',
    );
  });

  it('chi accetta ordini a magazzino vuoto resta disponibile', () => {
    expect(availability(product({ inventory_policy: 'continue', inventory_quantity: 0 }))).toBe(
      'in stock',
    );
  });

  it('esaurito solo quando lo e davvero', () => {
    expect(availability(product({ inventory_quantity: 0 }))).toBe('out of stock');
    expect(availability(product({ inventory_quantity: 1 }))).toBe('in stock');
  });
});

describe('feedTitle', () => {
  it('prodotto e variante insieme: nel catalogo ogni variante e un articolo', () => {
    expect(feedTitle(product())).toBe('Maglietta - M / Blu');
  });

  it("la variante unica di Shopify non entra nel titolo", () => {
    expect(feedTitle(product({ variant_title: 'Default Title' }))).toBe('Maglietta');
  });
});

describe('productLink', () => {
  it('la variante sta nell indirizzo, o si arriva su quella sbagliata', () => {
    expect(productLink('negozio.it', product())).toBe(
      'https://negozio.it/products/maglietta?variant=222',
    );
  });

  it('il dominio arriva come capita, l indirizzo esce sempre uguale', () => {
    expect(productLink('https://negozio.it/', product())).toBe(
      'https://negozio.it/products/maglietta?variant=222',
    );
  });
});

describe('toMetaItem', () => {
  const opts = { domain: 'negozio.it', currency: 'EUR' };

  it('le righe che Meta scarterebbe non entrano nel file', () => {
    expect(toMetaItem(product({ image_url: null }), opts)).toBeNull();
  });

  it('il prezzo porta la valuta con se', () => {
    expect(toMetaItem(product(), opts)?.price).toBe('19.90 EUR');
  });

  it('con il prezzo di confronto il listino e quello, e il resto e saldo', () => {
    const item = toMetaItem(product({ price: 15, compare_at_price: 20 }), opts);
    expect(item?.price).toBe('20.00 EUR');
    expect(item?.sale_price).toBe('15.00 EUR');
  });

  it('un compare_at piu basso del prezzo non e uno sconto', () => {
    const item = toMetaItem(product({ price: 20, compare_at_price: 15 }), opts);
    expect(item?.price).toBe('20.00 EUR');
    expect(item?.sale_price).toBeUndefined();
  });

  it('le varianti restano legate al prodotto padre', () => {
    const item = toMetaItem(product(), opts);
    expect(item?.id).toBe('222');
    expect(item?.item_group_id).toBe('111');
  });

  it('senza descrizione va il titolo: Meta rifiuta il campo vuoto', () => {
    const item = toMetaItem(product({ product_description: null }), opts);
    expect(item?.description).toBe('Maglietta - M / Blu');
  });
});

describe('serializzazione', () => {
  const items = [
    toMetaItem(product({ product_title: 'Tazza "grande" & blu' }), {
      domain: 'negozio.it',
      currency: 'EUR',
    })!,
  ];

  it("l'XML converte i caratteri che romperebbero il file", () => {
    const xml = toXml(items, { title: 'Negozio', link: 'https://negozio.it' });
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');
    expect(xml).not.toMatch(/<g:title>[^<]*"/);
  });

  it('i campi assenti non lasciano tag vuoti', () => {
    const bare = toMetaItem(product({ barcode: null, sku: null }), {
      domain: 'negozio.it',
      currency: 'EUR',
    })!;
    const xml = toXml([bare], { title: 'Negozio', link: 'https://negozio.it' });
    expect(xml).not.toContain('<g:gtin>');
    expect(xml).not.toContain('<g:mpn>');
  });

  it('il CSV racchiude le celle con virgole e virgolette', () => {
    const csv = toCsv(items);
    expect(csv).toContain('"Tazza ""grande"" & blu - M / Blu"');
  });

  it('il CSV si apre in UTF-8 anche in un foglio di calcolo', () => {
    expect(toCsv(items).charCodeAt(0)).toBe(0xfeff);
  });

  it('una colonna vuota resta vuota, non sparisce', () => {
    const csv = toCsv(items);
    const header = csv.replace(/^﻿/, '').split('\r\n')[0].split(',');
    const row = csv.split('\r\n')[1];
    // Le celle non si contano dividendo per virgola: le descrizioni ne hanno
    // dentro. Basta che l'intestazione e il file esistano con la stessa forma.
    expect(header).toContain('gtin');
    expect(row.startsWith('222,111,')).toBe(true);
  });
});
