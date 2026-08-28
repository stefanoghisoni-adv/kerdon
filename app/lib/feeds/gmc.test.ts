import { describe, it, expect } from 'vitest';
import {
  defaultMapping,
  GMC_FIELDS,
  isVariable,
  missingFields,
  toGmcItem,
  valueOf,
  type Variable,
} from './gmc';
import type { FeedProduct } from './meta';

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

const opts = { domain: 'negozio.it', currency: 'EUR' };

describe('la mappatura di partenza', () => {
  it('copre ogni campo del feed', () => {
    const mapping = defaultMapping();
    for (const field of GMC_FIELDS) expect(mapping[field.name]).toBeDefined();
  });

  it('ogni suggerimento e una variabile che esiste', () => {
    for (const field of GMC_FIELDS) expect(isVariable(field.suggested)).toBe(true);
  });

  it('nessun campo obbligatorio parte da "niente"', () => {
    // Un obbligatorio mappato su 'none' produrrebbe un feed vuoto al primo
    // salvataggio, senza che nessuno abbia scelto niente.
    for (const field of GMC_FIELDS) {
      if (field.required) expect(field.suggested).not.toBe('none');
    }
  });
});

describe('valueOf', () => {
  it('il prezzo porta la valuta e il punto decimale', () => {
    // Con la virgola Google rifiuta la riga, qualunque sia la lingua.
    expect(valueOf('price', product(), opts)).toBe('19.90 EUR');
  });

  it('prezzo assente o a zero: campo vuoto, non "0"', () => {
    expect(valueOf('price', product({ price: 0 }), opts)).toBe('');
    expect(valueOf('price', product({ price: null }), opts)).toBe('');
  });

  it('la disponibilita usa le parole di Google, non quelle di Meta', () => {
    expect(valueOf('availability_state', product(), opts)).toBe('in_stock');
    expect(valueOf('availability_state', product({ inventory_quantity: 0 }), opts)).toBe(
      'out_of_stock',
    );
  });

  it('il link si compone, e senza handle non si inventa', () => {
    expect(valueOf('product_link', product(), opts)).toContain('/products/maglietta');
    expect(valueOf('product_link', product({ handle: null }), opts)).toBe('');
  });

  it('"niente" e niente', () => {
    expect(valueOf('none', product(), opts)).toBe('');
  });
});

describe('toGmcItem', () => {
  const mapping = defaultMapping();

  it('un prodotto completo esce con tutti gli obbligatori', () => {
    const item = toGmcItem(product(), mapping, opts)!;
    for (const field of GMC_FIELDS) {
      if (field.required) expect(item[field.name]).toBeTruthy();
    }
  });

  it('manca un obbligatorio: la riga non entra', () => {
    // Google la accetterebbe segnandola "non approvata", e il merchant vedrebbe
    // il prodotto nel catalogo senza capire perche' non gira.
    expect(toGmcItem(product({ image_url: null }), mapping, opts)).toBeNull();
    expect(toGmcItem(product({ vendor: null }), mapping, opts)).toBeNull();
  });

  it('i campi vuoti non entrano nel file', () => {
    const item = toGmcItem(product({ barcode: null, sku: null }), mapping, opts)!;
    expect(item.gtin).toBeUndefined();
    expect(item.mpn).toBeUndefined();
  });

  it('senza codici lo si dichiara, invece di lasciarlo sembrare un errore', () => {
    const item = toGmcItem(product({ barcode: null, sku: null }), mapping, opts)!;
    expect(item.identifier_exists).toBe('no');
  });

  it('con un codice non si dichiara niente', () => {
    expect(toGmcItem(product(), mapping, opts)!.identifier_exists).toBeUndefined();
  });

  it('la mappatura del merchant vince sul suggerimento', () => {
    const custom: Record<string, Variable> = { ...mapping, mpn: 'barcode', gtin: 'none' };
    const item = toGmcItem(product(), custom, opts)!;
    expect(item.mpn).toBe('0123456789012');
    expect(item.gtin).toBeUndefined();
  });
});

describe('missingFields', () => {
  it('elenca solo gli obbligatori che restano vuoti', () => {
    const missing = missingFields(product({ image_url: null, barcode: null }), defaultMapping(), opts);
    expect(missing).toContain('image_link');
    // gtin non e' obbligatorio: la sua assenza non va nell'elenco.
    expect(missing).not.toContain('gtin');
  });

  it('un prodotto a posto non ha niente da elencare', () => {
    expect(missingFields(product(), defaultMapping(), opts)).toEqual([]);
  });
});

describe('i prezzi verso Google', () => {
  const prodotto = (price: string, compare: string | null) =>
    ({ price, compare_at_price: compare }) as never;
  const opts = { currency: 'EUR', domain: 'negozio.it' } as never;

  // Il caso che ha motivato le due variabili: mandare il prezzo di confronto su
  // `sale_price` metterebbe il numero piu' alto nel campo dello sconto, e
  // Google scarta l'articolo.
  it('in sconto: il pieno va sul listino, il ribassato sullo sconto', () => {
    const p = prodotto('20.00', '30.00');
    expect(valueOf('list_price', p, opts)).toBe('30.00 EUR');
    expect(valueOf('discounted_price', p, opts)).toBe('20.00 EUR');
  });

  it('senza sconto il listino resta pieno e lo sconto resta vuoto', () => {
    const p = prodotto('20.00', null);
    // Mai vuoto: per Google il prezzo e' obbligatorio, e un prodotto senza
    // prezzo di confronto verrebbe scartato.
    expect(valueOf('list_price', p, opts)).toBe('20.00 EUR');
    // Vuoto vuol dire "nessuna promozione". Uno sconto pari al prezzo sarebbe
    // una promozione dello zero per cento, cioe' finta.
    expect(valueOf('discounted_price', p, opts)).toBe('');
  });

  it.each([
    ['confronto uguale al prezzo', '20.00', '20.00'],
    ['confronto piu basso del prezzo', '20.00', '15.00'],
  ])('%s non e uno sconto', (_caso, price, compare) => {
    const p = prodotto(price, compare);
    expect(valueOf('list_price', p, opts)).toBe(`${price} EUR`);
    expect(valueOf('discounted_price', p, opts)).toBe('');
  });
});
