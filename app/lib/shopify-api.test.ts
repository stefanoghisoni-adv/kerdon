import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ShopifyAPIClient,
  ShopifyRequestError,
  isMutation,
  resolveApiVersion,
  retryDelay,
  DEFAULT_API_VERSION,
  MAX_ATTEMPTS,
} from './shopify-api.server';

global.fetch = vi.fn();

// Il client si procura il token dalla libreria Shopify: qui non serve, i test
// costruiscono l'istanza direttamente con un token finto.
vi.mock('~/shopify.server', () => ({ unauthenticated: { admin: vi.fn() } }));

/** Risposta GraphQL riuscita. */
function ok(
  data: unknown,
  throttle?: { maximumAvailable: number; currentlyAvailable: number },
  apiVersion: string = '2026-07',
) {
  return {
    ok: true,
    // Shopify dichiara sempre in risposta la versione che ha davvero servito:
    // il client la confronta con quella richiesta, quindi il finto deve averla.
    headers: new Headers({ 'X-Shopify-API-Version': apiVersion }),
    json: async () => ({ data, extensions: throttle ? { cost: { throttleStatus: throttle } } : undefined }),
  };
}

/** Corpo della richiesta effettivamente inviata. */
function sentBody(call: number = 0) {
  const mockFetch = global.fetch as any;
  return JSON.parse(mockFetch.mock.calls[call][1].body);
}

const client = () => new ShopifyAPIClient('test.myshopify.com', 'token');

describe('Shopify API Client (GraphQL)', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('parla con l endpoint graphql in POST', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ productsCount: { count: 0 } }));
    await client().getProductsCount();

    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://test.myshopify.com/admin/api/2026-07/graphql.json');
    expect(init.method).toBe('POST');
  });

  it('impagina con il cursore e lo restituisce solo se c e una pagina dopo', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        products: {
          pageInfo: { hasNextPage: true, endCursor: 'cursore-abc' },
          nodes: [
            { id: 'gid://shopify/Product/1', title: 'Uno' },
            { id: 'gid://shopify/Product/2', title: 'Due' },
          ],
        },
      }),
    );

    const result = await client().getProducts({ limit: 250 });

    expect(result.products).toHaveLength(2);
    expect(result.nextPageInfo).toBe('cursore-abc');
  });

  it('senza pagina successiva il cursore e null, cosi il ciclo di sync si ferma', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({ products: { pageInfo: { hasNextPage: false, endCursor: 'ignorato' }, nodes: [] } }),
    );

    expect((await client().getProducts({})).nextPageInfo).toBeNull();
  });

  it('il filtro updated_at vale solo alla prima pagina: dopo e gia nel cursore', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({ products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }),
    );

    await client().getProducts({ pageInfo: 'cursore123', updatedAtMin: '2026-07-10T00:00:00Z' });

    expect(sentBody().variables.after).toBe('cursore123');
    expect(sentBody().variables.query).toBeNull();
  });

  it('alla prima pagina il filtro updated_at viene inviato', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({ products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }),
    );

    await client().getProducts({ updatedAtMin: '2026-07-10T00:00:00Z' });

    expect(sentBody().variables.query).toBe("updated_at:>='2026-07-10T00:00:00Z'");
    expect(sentBody().variables.after).toBeNull();
  });

  it('con fields ristretti chiede meno campi di prodotto, ma sempre createdAt', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({ products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }),
    );

    await client().getProducts({ fields: 'id,variants' });

    const q = sentBody().query;
    expect(q).toContain('variants');
    expect(q).not.toContain('vendor');
    // createdAt non e' negoziabile: da lui dipende l'ordine di sincronizzazione,
    // e quindi quali prodotti entrano sotto il tetto del piano.
    expect(q).toContain('createdAt');
  });

  // ─── Traduzione GraphQL → forme attese dai consumatori ───

  it('traduce un prodotto completo nella forma che i transformer si aspettano', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        products: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'gid://shopify/Product/7502978383957',
              title: 'Snowboard',
              descriptionHtml: '<p>desc</p>',
              vendor: 'Acme',
              productType: 'board',
              handle: 'snowboard',
              status: 'ACTIVE',
              tags: ['VIP', 'nuovo'],
              publishedAt: '2026-08-06T14:11:08Z',
              createdAt: '2026-01-02T10:00:00Z',
              images: { nodes: [{ id: 'gid://shopify/ProductImage/99', url: 'https://cdn/img.png' }] },
              variants: {
                nodes: [
                  {
                    id: 'gid://shopify/ProductVariant/42831343124565',
                    title: 'Rosso / L',
                    sku: 'SNB-1',
                    barcode: null,
                    price: '199.00',
                    compareAtPrice: '249.00',
                    position: 1,
                    inventoryQuantity: 7,
                    inventoryPolicy: 'DENY',
                    taxable: true,
                    selectedOptions: [
                      { name: 'Colore', value: 'Rosso' },
                      { name: 'Taglia', value: 'L' },
                    ],
                    image: { id: 'gid://shopify/ProductImage/99' },
                    inventoryItem: {
                      id: 'gid://shopify/InventoryItem/44980905934933',
                      tracked: true,
                      requiresShipping: true,
                      unitCost: { amount: '80.00' },
                      measurement: { weight: { value: 2.5, unit: 'KILOGRAMS' } },
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    const { products } = await client().getProducts({});
    const p = products[0];

    // Gli id sono numerici: le tabelle dei merchant hanno colonne BIGINT, e i
    // GID le renderebbero illeggibili al tracciamento.
    expect(p.id).toBe(7502978383957);
    expect(p.body_html).toBe('<p>desc</p>');
    expect(p.product_type).toBe('board');
    // Gli enum arrivano maiuscoli da GraphQL, minuscoli dalla REST.
    expect(p.status).toBe('active');
    // I tag erano una stringa separata da virgole: il transformer fa split.
    expect(p.tags).toBe('VIP, nuovo');
    expect(p.created_at).toBe('2026-01-02T10:00:00Z');
    expect(p.images).toEqual([{ id: 99, src: 'https://cdn/img.png' }]);

    const v = p.variants[0];
    expect(v.id).toBe(42831343124565);
    expect(v.product_id).toBe(7502978383957);
    expect(v.compare_at_price).toBe('249.00');
    expect(v.inventory_policy).toBe('deny');
    // selectedOptions e' un elenco: va riappiattito in tre campi posizionali.
    expect(v.option1).toBe('Rosso');
    expect(v.option2).toBe('L');
    expect(v.option3).toBeNull();
    // Il tracciamento era espresso come "shopify" o null, non come booleano.
    expect(v.inventory_management).toBe('shopify');
    // Il peso: GraphQL nomina l'unita' per esteso, la colonna vuole la sigla.
    expect(v.weight).toBe(2.5);
    expect(v.weight_unit).toBe('kg');
    expect(v.requires_shipping).toBe(true);
    expect(v.inventory_item_id).toBe(44980905934933);
    // Il costo arriva insieme al prodotto: la REST imponeva una seconda chiamata.
    expect(v.cost).toBe('80.00');
  });

  it('un prodotto senza costo, immagine e peso non inventa valori', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        products: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'gid://shopify/Product/1',
              title: 'Gift Card',
              tags: [],
              variants: {
                nodes: [
                  {
                    id: 'gid://shopify/ProductVariant/2',
                    title: '$10',
                    sku: null,
                    barcode: null,
                    price: '10.00',
                    compareAtPrice: null,
                    position: 1,
                    inventoryQuantity: 0,
                    inventoryPolicy: 'DENY',
                    taxable: false,
                    selectedOptions: [],
                    image: null,
                    inventoryItem: {
                      id: 'gid://shopify/InventoryItem/3',
                      tracked: false,
                      requiresShipping: false,
                      unitCost: null,
                      measurement: { weight: null },
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );

    const v = (await client().getProducts({})).products[0].variants[0];
    expect(v.cost).toBeNull();
    expect(v.image_id).toBeNull();
    expect(v.weight).toBeNull();
    expect(v.weight_unit).toBeNull();
    expect(v.inventory_management).toBeNull();
    expect(v.option1).toBeNull();
  });

  it('traduce un cliente, consenso compreso, nella forma attesa dal transformer', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        customers: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'gid://shopify/Customer/9131595071573',
              email: 'a@b.it',
              phone: '+39000',
              firstName: 'Ada',
              lastName: 'Rossi',
              emailMarketingConsent: { marketingState: 'SUBSCRIBED', marketingOptInLevel: 'SINGLE_OPT_IN' },
              amountSpent: { amount: '120.50' },
              numberOfOrders: '3',
              state: 'ENABLED',
              tags: ['VIP'],
              note: 'nota',
              verifiedEmail: true,
              taxExempt: false,
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-02-01T00:00:00Z',
              defaultAddress: {
                address1: 'Via Roma 1',
                address2: null,
                city: 'Milano',
                province: 'Lombardia',
                country: 'Italy',
                countryCodeV2: 'IT',
                zip: '20100',
              },
            },
          ],
        },
      }),
    );

    const c = (await client().getCustomers({})).customers[0];

    expect(c.id).toBe(9131595071573);
    // Il transformer confronta con 'subscribed': se restasse maiuscolo, nessun
    // cliente risulterebbe mai consenziente e la sincronizzazione clienti
    // resterebbe vuota senza errori.
    expect(c.email_marketing_consent).toEqual({ state: 'subscribed', opt_in_level: 'single_opt_in' });
    expect(c.total_spent).toBe('120.50');
    // numberOfOrders arriva come stringa, la colonna e' INTEGER.
    expect(c.orders_count).toBe(3);
    expect(c.state).toBe('enabled');
    expect(c.tags).toBe('VIP');
    // L'indirizzo esce nella forma piatta della REST, che e' quella che il
    // transformer legge anche dal payload dei webhook: una chiave diversa qui
    // vorrebbe dire colonne piene dal webhook e vuote dalla corsa periodica.
    expect(c.default_address).toEqual({
      address1: 'Via Roma 1',
      address2: null,
      city: 'Milano',
      province: 'Lombardia',
      country: 'Italy',
      // `countryCodeV2` e' il campo GraphQL che restituisce la sigla a due
      // lettere, l'unica forma che le piattaforme pubblicitarie confrontano.
      country_code: 'IT',
      zip: '20100',
    });
  });

  // ─── Conteggi, inventario, negozio ───

  it('restituisce il conteggio dei prodotti', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ productsCount: { count: 4820 } }));
    expect(await client().getProductsCount()).toBe(4820);
  });

  it('restituisce il conteggio dei clienti', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ customersCount: { count: 42 } }));
    expect(await client().getCustomersCount()).toBe(42);
  });

  it('legge i costi degli inventory item per id, saltando i nodi mancanti', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        nodes: [
          { id: 'gid://shopify/InventoryItem/111', unitCost: { amount: '3.50' } },
          { id: 'gid://shopify/InventoryItem/222', unitCost: null },
          null,
        ],
      }),
    );

    const items = await client().getInventoryItems([111, 222, 333]);

    expect(sentBody().variables.ids).toEqual([
      'gid://shopify/InventoryItem/111',
      'gid://shopify/InventoryItem/222',
      'gid://shopify/InventoryItem/333',
    ]);
    expect(items).toEqual([
      { id: 111, cost: '3.50' },
      { id: 222, cost: null },
    ]);
  });

  it('senza id non chiama nemmeno Shopify', async () => {
    expect(await client().getInventoryItems([])).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('aggiorna il costo con la mutation', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        inventoryItemUpdate: {
          inventoryItem: { id: 'gid://shopify/InventoryItem/111', unitCost: { amount: '9.99' } },
          userErrors: [],
        },
      }),
    );

    const res = await client().updateInventoryItemCost(111, '9.99');

    expect(sentBody().variables).toEqual({
      id: 'gid://shopify/InventoryItem/111',
      input: { cost: '9.99' },
    });
    expect(res).toEqual({ id: 111, cost: '9.99' });
  });

  it('scrive le date di nascita sul metafield del cliente', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({ metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } }),
    );

    const result = await client().setCustomerBirthdates([{ customerId: 7, date: '1985-04-23' }]);

    expect(result).toEqual({ written: 1, errors: [], failed: [] });
    const body = sentBody();
    expect(body.variables.metafields).toEqual([
      {
        ownerId: 'gid://shopify/Customer/7',
        namespace: 'facts',
        key: 'birth_date',
        type: 'date',
        value: '1985-04-23',
      },
    ]);
  });

  it('oltre venticinque per volta la mutation verrebbe rifiutata: si spezza', async () => {
    // Il tetto e' di Shopify, non nostro: una pagina da 250 clienti mandata in
    // blocco non scriverebbe niente, non scriverebbe "quasi tutto".
    (global.fetch as any)
      .mockResolvedValueOnce(ok({ metafieldsSet: { metafields: new Array(25).fill({ id: 'x' }), userErrors: [] } }))
      .mockResolvedValueOnce(ok({ metafieldsSet: { metafields: [{ id: 'x' }], userErrors: [] } }));

    const entries = Array.from({ length: 26 }, (_, i) => ({ customerId: i + 1, date: '1985-04-23' }));
    const result = await client().setCustomerBirthdates(entries);

    expect((global.fetch as any).mock.calls).toHaveLength(2);
    expect(sentBody(0).variables.metafields).toHaveLength(25);
    expect(sentBody(1).variables.metafields).toHaveLength(1);
    expect(result.written).toBe(26);
  });

  it('un rifiuto applicativo torna indietro invece di far saltare la sync', async () => {
    // Qui gli userErrors NON si alzano, al contrario delle altre mutation: la
    // riscrittura della data e' un di piu' che al giro dopo si ritenta, e i
    // clienti sono gia' scritti sul database del merchant.
    (global.fetch as any).mockResolvedValueOnce(
      ok({ metafieldsSet: { metafields: [], userErrors: [{ field: null, message: 'Owner does not exist' }] } }),
    );

    const result = await client().setCustomerBirthdates([{ customerId: 7, date: '1985-04-23' }]);

    expect(result).toEqual({
      written: 0,
      errors: ['Owner does not exist'],
      // Con il nome di chi: senza, chi chiama sa che qualcosa e' stato
      // rifiutato ma non cosa, quindi non puo' segnarselo e non puo'
      // ritentarlo. E ritentare "al giro dopo" non succede: la corsa
      // successiva legge il delta, e un cliente la cui scrittura NON e' andata
      // non risulta cambiato.
      failed: [{ customerId: 7, reason: 'Owner does not exist' }],
    });
  });

  it('il rifiuto porta l\'indice, e l\'indice dice quale cliente', async () => {
    // `metafieldsSet` risponde con `field: ["metafields","1","value"]`: quel
    // numero e' la posizione nel lotto mandato. E' l'unico modo di attribuire
    // il rifiuto, e senza attribuzione si finisce per ritentare tutti o
    // nessuno.
    (global.fetch as any)
      .mockResolvedValueOnce(
        ok({
          metafieldsSet: {
            metafields: null,
            userErrors: [{ field: ['metafields', '1', 'value'], message: 'Value is invalid' }],
          },
        }),
      )
      .mockResolvedValueOnce(ok({ metafieldsSet: { metafields: [{ id: 'x' }], userErrors: [] } }));

    const result = await client().setCustomerBirthdates([
      { customerId: 7, date: '1985-04-23' },
      { customerId: 8, date: 'non-una-data' },
    ]);

    expect(result.failed).toEqual([{ customerId: 8, reason: 'Value is invalid' }]);
    expect(result.written).toBe(1);
    // Il secondo lotto manda solo il cliente 7
    expect(sentBody(1).variables.metafields.map((m: any) => m.ownerId)).toEqual(['gid://shopify/Customer/7']);
  });

  it('metafieldsSet e\' atomico: un rifiuto nel lotto blocca tutti, il lotto si rimanda senza il fallito', async () => {
    // Bug fix: quando metafieldsSet torna userErrors, nessuno del lotto e'
    // stato scritto (operazione atomica). Il cliente fallito va in `failed`, ma
    // gli altri vanno ritentati — altrimenti risultano scritti mentre Shopify
    // tiene ancora il valore vecchio.
    (global.fetch as any)
      .mockResolvedValueOnce(
        ok({
          metafieldsSet: {
            metafields: null,
            userErrors: [{ field: ['metafields', '1', 'value'], message: 'Value is invalid' }],
          },
        }),
      )
      .mockResolvedValueOnce(ok({ metafieldsSet: { metafields: [{ id: 'x' }, { id: 'y' }], userErrors: [] } }));

    const result = await client().setCustomerBirthdates([
      { customerId: 7, date: '1985-04-23' },
      { customerId: 8, date: 'non-una-data' },
      { customerId: 9, date: '1990-01-01' },
    ]);

    expect(result).toEqual({
      written: 2,
      errors: ['Value is invalid'],
      failed: [{ customerId: 8, reason: 'Value is invalid' }],
    });
    expect((global.fetch as any).mock.calls).toHaveLength(2);
    // Il secondo lotto manda solo 7 e 9
    expect(sentBody(1).variables.metafields.map((m: any) => m.ownerId)).toEqual([
      'gid://shopify/Customer/7',
      'gid://shopify/Customer/9',
    ]);
  });

  it('un rifiuto senza indice in setCustomerBirthdates: tutto il lotto e\' fallito', async () => {
    // Se l'errore non porta l'indice, non si sa quale cliente e' stato
    // rifiutato, quindi meglio marcare tutti come falliti che lasciarne qualcuno
    // in uno stato inconsistente.
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        metafieldsSet: {
          metafields: null,
          userErrors: [{ field: null, message: 'Internal error', code: 'INTERNAL_ERROR' }],
        },
      }),
    );

    const result = await client().setCustomerBirthdates([
      { customerId: 7, date: '1985-04-23' },
      { customerId: 8, date: '1990-01-01' },
    ]);

    expect(result).toEqual({
      written: 0,
      errors: ['Internal error'],
      failed: [
        { customerId: 7, reason: 'Internal error' },
        { customerId: 8, reason: 'Internal error' },
      ],
    });
    // Non c'e' un secondo tentativo: non si sa chi togliere
    expect((global.fetch as any).mock.calls).toHaveLength(1);
  });

  it('riempire solo dove manca: ogni metafield parte con compareDigest null', async () => {
    // compareDigest null = "scrivi solo se il metafield non esiste". E' la
    // garanzia che l'import non copre una data che Shopify ha gia'.
    (global.fetch as any).mockResolvedValueOnce(
      ok({ metafieldsSet: { metafields: [{ id: 'x' }], userErrors: [] } }),
    );

    const result = await client().fillCustomerBirthdatesIfAbsent([{ customerId: 7, date: '1985-04-23' }]);

    expect(result).toEqual({ written: [7], present: [], failed: [] });
    expect(sentBody().variables.metafields).toEqual([
      {
        ownerId: 'gid://shopify/Customer/7',
        namespace: 'facts',
        key: 'birth_date',
        type: 'date',
        value: '1985-04-23',
        compareDigest: null,
      },
    ]);
    expect(sentBody().query).toContain('code');
  });

  it('un metafield gia\' presente torna come present; il lotto (atomico) si rimanda senza di lui', async () => {
    // metafieldsSet e' atomico: un solo rifiuto e nessuno del lotto e' stato
    // scritto. Chi e' stato rifiutato esce, gli altri si rimandano.
    (global.fetch as any)
      .mockResolvedValueOnce(
        ok({
          metafieldsSet: {
            metafields: null,
            userErrors: [
              { field: ['metafields', '1', 'compareDigest'], message: 'stale', code: 'STALE_OBJECT' },
              { field: ['metafields', '2', 'value'], message: 'Value is invalid', code: 'INVALID_VALUE' },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(ok({ metafieldsSet: { metafields: [{ id: 'x' }], userErrors: [] } }));

    const result = await client().fillCustomerBirthdatesIfAbsent([
      { customerId: 7, date: '1985-04-23' },
      { customerId: 8, date: '1990-01-01' },
      { customerId: 9, date: 'boh' },
    ]);

    expect(result).toEqual({
      written: [7],
      present: [8],
      failed: [{ customerId: 9, reason: 'Value is invalid' }],
    });
    expect((global.fetch as any).mock.calls).toHaveLength(2);
    expect(sentBody(1).variables.metafields.map((m: any) => m.ownerId)).toEqual(['gid://shopify/Customer/7']);
    expect(sentBody(1).variables.metafields[0].compareDigest).toBeNull();
  });

  it('un rifiuto senza indice vale per tutto il lotto rimasto', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({ metafieldsSet: { metafields: null, userErrors: [{ field: null, message: 'boom', code: 'INTERNAL_ERROR' }] } }),
    );

    const result = await client().fillCustomerBirthdatesIfAbsent([{ customerId: 7, date: '1985-04-23' }]);

    expect(result).toEqual({ written: [], present: [], failed: [{ customerId: 7, reason: 'boom' }] });
  });

  it('legge la data di nascita attuale di alcuni clienti', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        nodes: [
          { id: 'gid://shopify/Customer/7', metafield: { value: '1980-02-03' } },
          { id: 'gid://shopify/Customer/8', metafield: null },
          null,
        ],
      }),
    );

    const values = await client().getCustomerBirthdateValues([7, 8, 9]);

    expect(sentBody().variables).toEqual({
      ids: ['gid://shopify/Customer/7', 'gid://shopify/Customer/8', 'gid://shopify/Customer/9'],
      namespace: 'facts',
      key: 'birth_date',
    });
    expect([...values]).toEqual([
      [7, '1980-02-03'],
      [8, null],
    ]);
  });

  it('senza nessuno da riscrivere non si chiama Shopify', async () => {
    const result = await client().setCustomerBirthdates([]);
    expect(result).toEqual({ written: 0, errors: [], failed: [] });
    expect((global.fetch as any).mock.calls).toHaveLength(0);
  });

  it('getShopInfo restituisce fuso orario, dominio principale e valuta di vendita', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        shop: {
          ianaTimezone: 'Europe/Rome',
          primaryDomain: { host: 'negozio.it' },
          currencyCode: 'EUR',
        },
      }),
    );

    expect(await client().getShopInfo()).toEqual({
      ianaTimezone: 'Europe/Rome',
      primaryDomain: 'negozio.it',
      currencyCode: 'EUR',
    });
  });

  it('la sigla della valuta esce come la scrive Shopify, non come capita', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ shop: { currencyCode: ' eur ' } }));

    expect((await client().getShopInfo()).currencyCode).toBe('EUR');
  });

  it('getShopInfo senza quei campi restituisce null', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ shop: {} }));

    expect(await client().getShopInfo()).toEqual({
      ianaTimezone: null,
      primaryDomain: null,
      currencyCode: null,
    });
  });

  // ─── Errori: il punto dove GraphQL si rompe in silenzio ───

  it('un errore GraphQL arriva con HTTP 200 e deve comunque diventare un eccezione', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ errors: [{ message: 'Field does not exist' }] }),
    });

    // Senza questo controllo la chiamata risulterebbe riuscita con dati vuoti,
    // e finirebbe per svuotare le righe nel database del merchant.
    await expect(client().getProductsCount()).rejects.toThrow(/Field does not exist/);
  });

  it('gli userErrors di una mutation non passano per successo', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        inventoryItemUpdate: {
          inventoryItem: null,
          userErrors: [{ field: ['input', 'cost'], message: 'Cost is invalid' }],
        },
      }),
    );

    await expect(client().updateInventoryItemCost(111, 'boh')).rejects.toThrow(/Cost is invalid/);
  });

  it('su errore HTTP il messaggio riporta il corpo, non solo lo stato', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => '{"errors":"[API] Non-expiring access tokens are no longer accepted"}',
    });

    // E' esattamente il messaggio che era stato buttato via, facendo
    // diagnosticare un divieto sulla REST che non esisteva.
    await expect(client().getProductsCount()).rejects.toThrow(/Non-expiring access tokens/);
  });

  it('rallenta quando il serbatoio di punti e quasi esaurito', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (global.fetch as any).mockResolvedValueOnce(
      ok({ productsCount: { count: 1 } }, { maximumAvailable: 2000, currentlyAvailable: 100 }),
    );

    await client().getProductsCount();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Approaching rate limit'));
    warn.mockRestore();
  });

  // Quando una versione API viene ritirata Shopify non rifiuta la richiesta:
  // la serve con la piu' vecchia ancora supportata, e lo dice solo nell'header.
  // Senza questo controllo l'app girerebbe per mesi su una versione diversa da
  // quella per cui e' scritta senza che nessuno se ne accorga.
  it('segnala quando Shopify serve una versione API diversa da quella richiesta', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (global.fetch as any).mockResolvedValueOnce(
      ok({ productsCount: { count: 1 } }, undefined, '2026-04'),
    );

    await client().getProductsCount();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('richiesta 2026-07, ricevuta 2026-04'),
    );
    warn.mockRestore();
  });

  it('versione allineata: nessuna segnalazione', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (global.fetch as any).mockResolvedValueOnce(ok({ productsCount: { count: 1 } }));

    await client().getProductsCount();

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connessioni annidate: `variants(first: N)` non e' "le varianti del prodotto",
// e' "le prime N". Shopify ne ammette fino a 2048, e chi legge deve poter
// distinguere un elenco finito da un elenco troncato — perche' a valle quella
// differenza diventa una cancellazione.
// ─────────────────────────────────────────────────────────────────────────────

/** N varianti finte, numerate a partire da `from`. */
function variantNodes(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `gid://shopify/ProductVariant/${from + i}`,
    title: `V${from + i}`,
    sku: null,
    barcode: null,
    price: '10.00',
    compareAtPrice: null,
    position: i + 1,
    inventoryQuantity: 0,
    inventoryPolicy: 'DENY',
    taxable: true,
    selectedOptions: [],
    image: null,
    inventoryItem: null,
  }));
}

/** Una pagina di prodotti con dentro un solo prodotto e le sue varianti. */
function productsPage(variants: {
  nodes: ReturnType<typeof variantNodes>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}) {
  return {
    products: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: 'gid://shopify/Product/1',
          title: 'Maglietta',
          createdAt: '2026-01-01T00:00:00Z',
          images: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          variants,
        },
      ],
    },
  };
}

describe('Paginazione delle connessioni annidate', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('101 varianti: la prima pagina si ferma a 100, la coda porta la centunesima', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(
        ok(
          productsPage({
            nodes: variantNodes(1, 100),
            pageInfo: { hasNextPage: true, endCursor: 'dopo-la-100' },
          }),
        ),
      )
      .mockResolvedValueOnce(
        ok({
          node: {
            variants: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: variantNodes(101, 1),
            },
          },
        }),
      );

    const { products } = await client().getProducts({ limit: 250 });

    expect(products[0].variants).toHaveLength(101);
    expect(products[0].variants[100].id).toBe(101);
    // Il bit che autorizza a cancellare: l'elenco e' andato fino in fondo.
    expect(products[0].variants_complete).toBe(true);
    // La coda parte dal cursore della prima pagina, non da capo.
    expect(sentBody(1).variables.after).toBe('dopo-la-100');
  });

  it('250 varianti su piu pagine: si arriva in fondo e si dichiara completo', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(
        ok(
          productsPage({
            nodes: variantNodes(1, 100),
            pageInfo: { hasNextPage: true, endCursor: 'c1' },
          }),
        ),
      )
      .mockResolvedValueOnce(
        ok({
          node: {
            variants: { pageInfo: { hasNextPage: true, endCursor: 'c2' }, nodes: variantNodes(101, 100) },
          },
        }),
      )
      .mockResolvedValueOnce(
        ok({
          node: {
            variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: variantNodes(201, 50) },
          },
        }),
      );

    const { products } = await client().getProducts({ limit: 250 });

    expect(products[0].variants).toHaveLength(250);
    expect(products[0].variants.map((v) => v.id)).toEqual(
      Array.from({ length: 250 }, (_, i) => i + 1),
    );
    expect(products[0].variants_complete).toBe(true);
    expect(sentBody(2).variables.after).toBe('c2');
  });

  it('errore sulla seconda pagina: elenco NON completo, e non si perde quel che era arrivato', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (global.fetch as any)
      .mockResolvedValueOnce(
        ok(
          productsPage({
            nodes: variantNodes(1, 100),
            pageInfo: { hasNextPage: true, endCursor: 'c1' },
          }),
        ),
      )
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'boom',
      });

    const { products } = await client().getProducts({ limit: 250 });

    // L'errore non si propaga: la sincronizzazione prosegue con quel che ha.
    expect(products[0].variants).toHaveLength(100);
    // Ma dichiara di non sapere: e' questo `false` che, a valle, blocca ogni
    // cancellazione per differenza.
    expect(products[0].variants_complete).toBe(false);
    warn.mockRestore();
  });

  it('un prodotto che sta in una pagina sola non costa nessuna richiesta in piu', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok(
        productsPage({
          nodes: variantNodes(1, 3),
          pageInfo: { hasNextPage: false, endCursor: null },
        }),
      ),
    );

    const { products } = await client().getProducts({});

    expect((global.fetch as any).mock.calls).toHaveLength(1);
    expect(products[0].variants_complete).toBe(true);
  });

  it('anche le immagini si esauriscono: la undicesima non resta fuori', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(
        ok({
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'gid://shopify/Product/1',
                title: 'Maglietta',
                createdAt: '2026-01-01T00:00:00Z',
                images: {
                  pageInfo: { hasNextPage: true, endCursor: 'img-10' },
                  nodes: Array.from({ length: 10 }, (_, i) => ({
                    id: `gid://shopify/ProductImage/${i + 1}`,
                    url: `https://cdn/${i + 1}.png`,
                  })),
                },
                variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        ok({
          node: {
            images: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: 'gid://shopify/ProductImage/11', url: 'https://cdn/11.png' }],
            },
          },
        }),
      );

    const { products } = await client().getProducts({});

    // Serve davvero: una variante che punta all'undicesima immagine, senza
    // questa coda, finirebbe nel feed senza foto.
    expect(products[0].images).toHaveLength(11);
    expect(products[0].images_complete).toBe(true);
  });

  it('getProductById esaurisce le varianti come la query di elenco', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(
        ok({
          product: {
            id: 'gid://shopify/Product/5',
            title: 'Scarpa',
            createdAt: '2026-01-01T00:00:00Z',
            images: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            variants: {
              pageInfo: { hasNextPage: true, endCursor: 'c1' },
              nodes: variantNodes(1, 250),
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        ok({
          node: {
            variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: variantNodes(251, 10) },
          },
        }),
      );

    const product = await client().getProductById(5);

    expect(product?.variants).toHaveLength(260);
    expect(product?.variants_complete).toBe(true);
  });

  it('le righe di un ordine oltre le prime cento non spariscono dal margine', async () => {
    const lineNodes = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `gid://shopify/LineItem/${from + i}`,
        title: `Riga ${from + i}`,
        quantity: 1,
        product: null,
        variant: null,
        discountedUnitPriceSet: { shopMoney: { amount: '5.00' } },
        originalUnitPriceSet: null,
        totalDiscountSet: null,
      }));

    (global.fetch as any)
      .mockResolvedValueOnce(
        ok({
          orders: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'gid://shopify/Order/900',
                name: '#1001',
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z',
                cancelledAt: null,
                displayFinancialStatus: 'PAID',
                currentTotalPriceSet: { shopMoney: { amount: '600.00', currencyCode: 'EUR' } },
                customer: null,
                lineItems: {
                  pageInfo: { hasNextPage: true, endCursor: 'l100' },
                  nodes: lineNodes(1, 100),
                },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        ok({
          node: {
            lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: lineNodes(101, 20) },
          },
        }),
      );

    const { orders } = await client().getOrders({});

    expect(orders[0].lines).toHaveLength(120);
    expect(orders[0].lines_complete).toBe(true);
  });
});

describe('ordini: i dati di spedizione', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  const orderNode = (over: Record<string, unknown> = {}) => ({
    id: 'gid://shopify/Order/700',
    name: '#1700',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    currentTotalPriceSet: { shopMoney: { amount: '50.00', currencyCode: 'EUR' } },
    customer: null,
    displayFulfillmentStatus: 'UNFULFILLED',
    requiresShipping: true,
    fulfillments: [],
    shippingAddress: { countryCodeV2: 'IT' },
    // UnsignedInt64: in JSON arriva come stringa.
    totalWeight: '1250',
    returns: { nodes: [] },
    metafield: { value: 'Scatola' },
    // Una connessione, non una lista: verificato sulla 2026-07.
    shippingLines: { nodes: [{ title: 'Express' }] },
    lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    ...over,
  });

  it('l opzione di spedizione e il titolo della prima shipping line', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ order: orderNode() }));
    const order = await client().getOrderById(700);
    expect(order?.shipping_method).toBe('Express');
  });

  it('senza shipping line l opzione resta vuota', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(ok({ order: orderNode({ shippingLines: { nodes: [] } }) }))
      .mockResolvedValueOnce(ok({ order: orderNode({ shippingLines: { nodes: [{ title: '' }] } }) }));
    const a = await client().getOrderById(700);
    const b = await client().getOrderById(700);
    expect(a?.shipping_method).toBeNull();
    expect(b?.shipping_method).toBeNull();
    expect(a?.logistics_unknown).toEqual([]);
    expect(b?.logistics_unknown).toEqual([]);
  });

  it('piu\' shipping line: decide la prima', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({ order: orderNode({ shippingLines: { nodes: [{ title: 'Express' }, { title: 'Standard' }] } }) }),
    );
    expect((await client().getOrderById(700))?.shipping_method).toBe('Express');
  });

  it('chiede i campi di spedizione nella stessa query dell ordine', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ order: orderNode() }));
    await client().getOrderById(700);
    const query: string = sentBody().query;
    for (const field of [
      'displayFulfillmentStatus',
      'trackingInfo { number }',
      // Lo stato di ogni spedizione: quelle annullate non sono pacchi.
      'fulfillments(first: 10) { status trackingInfo { number } }',
      'countryCodeV2',
      'totalWeight',
      // Con pageInfo: oltre la prima pagina si continua, non si tronca.
      'returns(first: 5) { pageInfo { hasNextPage endCursor } nodes { status createdAt } }',
      'key: "packaging_category"',
      'shippingLines(first: 1) { nodes { title deliveryCategory } }',
      'requiresShipping',
    ]) {
      expect(query).toContain(field);
    }
  });

  it('paese, peso e imballo arrivano nella forma che serve al costo', async () => {
    (global.fetch as any).mockResolvedValueOnce(ok({ order: orderNode() }));
    const order = await client().getOrderById(700);
    expect(order).toMatchObject({
      fulfillment_status: 'UNFULFILLED',
      shipping_country_code: 'IT',
      total_weight_grams: 1250,
      returned_at: null,
      packaging_category: 'Scatola',
    });
  });

  it('un tracking vuol dire spedito, qualunque cosa dica lo stato', async () => {
    // Un ordine reso torna RESTOCKED, ma il pacco all'andata e' partito e il
    // corriere l'ha fatturato.
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        order: orderNode({
          displayFulfillmentStatus: 'RESTOCKED',
          fulfillments: [
            { status: 'SUCCESS', trackingInfo: [] },
            { status: 'SUCCESS', trackingInfo: [{ number: 'TRK1' }] },
          ],
        }),
      }),
    );
    const order = await client().getOrderById(700);
    expect(order?.fulfillment_status).toBe('FULFILLED');
  });

  it('i pacchi: tracking distinti di ogni spedizione (qualunque stato), uno per le partite senza tracking', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        order: orderNode({
          displayFulfillmentStatus: 'FULFILLED',
          fulfillments: [
            // Multi-collo: tre tracking, uno ripetuto e uno vuoto -> 3 pacchi.
            { status: 'SUCCESS', trackingInfo: [{ number: 'A' }, { number: 'B' }, { number: 'A' }, { number: '' }, { number: 'C' }] },
            // Annullata ma col tracking: il pacco e' arrivato al corriere, 1.
            { status: 'CANCELLED', trackingInfo: [{ number: 'D' }] },
            // Senza tracking e non partite: 0.
            { status: 'ERROR', trackingInfo: [] },
            { status: 'FAILURE', trackingInfo: [] },
            // Partita senza tracking: un pacco.
            { status: 'SUCCESS', trackingInfo: [] },
          ],
        }),
      }),
    );
    const order = await client().getOrderById(700);
    expect(order?.package_count).toBe(5);
  });

  it('nessuna spedizione: zero pacchi; spedizioni nulle: sconosciuti, non zero', async () => {
    (global.fetch as any)
      .mockResolvedValueOnce(ok({ order: orderNode({ fulfillments: [] }) }))
      .mockResolvedValueOnce(ok({ order: orderNode({ fulfillments: null }) }));
    expect((await client().getOrderById(700))?.package_count).toBe(0);
    const oscurato = await client().getOrderById(700);
    expect(oscurato?.package_count).toBeNull();
    expect(oscurato?.logistics_unknown).toEqual(expect.arrayContaining(['package_count', 'fulfillment_status']));
  });

  it('il reso conta solo se OPEN o CLOSED: REQUESTED, DECLINED e CANCELED no', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        order: orderNode({
          returns: {
            nodes: [
              { status: 'REQUESTED', createdAt: '2026-08-02T00:00:00Z' },
              { status: 'CANCELED', createdAt: '2026-08-03T00:00:00Z' },
              { status: 'DECLINED', createdAt: '2026-08-04T00:00:00Z' },
              { status: 'CLOSED', createdAt: '2026-08-07T00:00:00Z' },
              { status: 'OPEN', createdAt: '2026-08-05T00:00:00Z' },
            ],
          },
        }),
      }),
    );
    const order = await client().getOrderById(700);
    // Il primo reso che qualifica, in ordine di tempo.
    expect(order?.returned_at).toBe('2026-08-05T00:00:00Z');
  });

  it('solo un reso richiesto: nessun rientro', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({ order: orderNode({ returns: { nodes: [{ status: 'REQUESTED', createdAt: '2026-08-03T00:00:00Z' }] } }) }),
    );
    expect((await client().getOrderById(700))?.returned_at).toBeNull();
  });

  it('solo resi annullati: nessun rientro', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({ order: orderNode({ returns: { nodes: [{ status: 'CANCELED', createdAt: '2026-08-03T00:00:00Z' }] } }) }),
    );
    const order = await client().getOrderById(700);
    expect(order?.returned_at).toBeNull();
  });

  it('senza indirizzo, peso o metafield i campi restano vuoti', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({ order: orderNode({ shippingAddress: null, requiresShipping: false, totalWeight: null, metafield: null }) }),
    );
    const order = await client().getOrderById(700);
    expect(order).toMatchObject({
      shipping_country_code: null,
      total_weight_grams: null,
      packaging_category: null,
      returned_at: null,
      // Niente da spedire: un indirizzo nullo e' un dato.
      logistics_unknown: [],
    });
  });

  describe('campi oscurati (200 senza errori, null dove lo schema promette un valore)', () => {
    it('resi, shipping line e spedizioni nulli: colonne segnate come non lette', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (global.fetch as any).mockResolvedValueOnce(
        ok({ order: orderNode({ fulfillments: null, returns: null, shippingLines: null }) }),
      );
      const order = await client().getOrderById(700);
      expect(new Set(order?.logistics_unknown)).toEqual(
        new Set(['package_count', 'fulfillment_status', 'returned_at', 'shipping_method']),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ordine 700'));
      warn.mockRestore();
    });

    it('indirizzo nullo su un ordine da spedire con una consegna vera: paese oscurato, anche senza tracking', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      (global.fetch as any).mockResolvedValueOnce(
        ok({ order: orderNode({ shippingAddress: null, requiresShipping: true, fulfillments: [] }) }),
      );
      const order = await client().getOrderById(700);
      expect(order?.logistics_unknown).toEqual(['shipping_country_code']);
    });

    it('indirizzo nullo con un ritiro in negozio: nessun paese, ma e\' un dato', async () => {
      (global.fetch as any).mockResolvedValueOnce(
        ok({
          order: orderNode({
            shippingAddress: null,
            requiresShipping: true,
            shippingLines: { nodes: [{ title: 'Ritiro', deliveryCategory: 'pick-up' }] },
          }),
        }),
      );
      const order = await client().getOrderById(700);
      expect(order?.shipping_country_code).toBeNull();
      expect(order?.logistics_unknown).toEqual([]);
    });

    it('il tracking fa fede: una spedizione annullata con tracking rende l ordine spedito', async () => {
      (global.fetch as any).mockResolvedValueOnce(
        ok({
          order: orderNode({
            displayFulfillmentStatus: 'UNFULFILLED',
            fulfillments: [{ status: 'CANCELLED', trackingInfo: [{ number: 'BRT9' }] }],
          }),
        }),
      );
      const order = await client().getOrderById(700);
      expect(order?.fulfillment_status).toBe('FULFILLED');
      expect(order?.package_count).toBe(1);
    });

    it('una spedizione annullata senza tracking: nessun pacco, stato di Shopify', async () => {
      (global.fetch as any).mockResolvedValueOnce(
        ok({
          order: orderNode({
            displayFulfillmentStatus: 'UNFULFILLED',
            fulfillments: [{ status: 'CANCELLED', trackingInfo: [] }],
          }),
        }),
      );
      const order = await client().getOrderById(700);
      expect(order?.fulfillment_status).toBe('UNFULFILLED');
      expect(order?.package_count).toBe(0);
    });

    it('un 200 con `errors` fallisce: niente da scrivere', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'X-Shopify-API-Version': '2026-07' }),
        json: async () => ({
          data: { order: orderNode({ fulfillments: null }) },
          errors: [{ message: 'Access denied for returns field.', extensions: { code: 'ACCESS_DENIED' } }],
        }),
      });
      await expect(client().getOrderById(700)).rejects.toThrow('ACCESS_DENIED');
    });
  });

  describe('niente troncamenti silenziosi', () => {
    const spedizioni = (n: number, stato = 'SUCCESS') =>
      Array.from({ length: n }, (_, i) => ({ status: stato, trackingInfo: [{ number: `T${i}` }] }));

    it('10 spedizioni nella prima lettura: si rileggono tutte col massimo dell API', async () => {
      (global.fetch as any)
        .mockResolvedValueOnce(ok({ order: orderNode({ fulfillments: spedizioni(10) }) }))
        .mockResolvedValueOnce(ok({ node: { fulfillments: spedizioni(14) } }));
      const order = await client().getOrderById(700);
      expect(sentBody(1).query).toContain('fulfillments(first: 250) { status trackingInfo { number } }');
      expect(sentBody(1).variables).toEqual({ id: 'gid://shopify/Order/700' });
      expect(order?.package_count).toBe(14);
    });

    it('oltre il tetto dell API (250): avviso con l id dell ordine', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (global.fetch as any)
        .mockResolvedValueOnce(ok({ order: orderNode({ fulfillments: spedizioni(10) }) }))
        .mockResolvedValueOnce(ok({ node: { fulfillments: spedizioni(250) } }));
      const order = await client().getOrderById(700);
      expect(order?.package_count).toBe(250);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/gid:\/\/shopify\/Order\/700: 250 spedizioni o piu'/));
      warn.mockRestore();
    });

    it('rilettura delle spedizioni fallita: pacchi sconosciuti, non i primi 10', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (global.fetch as any)
        .mockResolvedValueOnce(ok({ order: orderNode({ fulfillments: spedizioni(10) }) }))
        .mockResolvedValueOnce(ok({ node: null }));
      const order = await client().getOrderById(700);
      expect(order?.package_count).toBeNull();
      expect(order?.logistics_unknown).toContain('package_count');
      warn.mockRestore();
    });

    it('resi oltre la prima pagina: si continua col cursore', async () => {
      (global.fetch as any)
        .mockResolvedValueOnce(
          ok({
            order: orderNode({
              returns: {
                pageInfo: { hasNextPage: true, endCursor: 'c1' },
                nodes: Array.from({ length: 5 }, () => ({ status: 'CANCELED', createdAt: '2026-08-03T00:00:00Z' })),
              },
            }),
          }),
        )
        .mockResolvedValueOnce(
          ok({
            node: {
              returns: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ status: 'CLOSED', createdAt: '2026-08-09T00:00:00Z' }],
              },
            },
          }),
        );
      const order = await client().getOrderById(700);
      expect(sentBody(1).query).toContain('returns(first: $first, after: $after)');
      expect(sentBody(1).variables).toMatchObject({ id: 'gid://shopify/Order/700', after: 'c1' });
      expect(order?.returned_at).toBe('2026-08-09T00:00:00Z');
      expect(order?.logistics_unknown).toEqual([]);
    });

    it('resi non letti per intero: reso sconosciuto, non il parziale', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (global.fetch as any)
        .mockResolvedValueOnce(
          ok({
            order: orderNode({
              returns: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [] },
            }),
          }),
        )
        .mockResolvedValueOnce(ok({ node: null }));
      const order = await client().getOrderById(700);
      expect(order?.logistics_unknown).toEqual(['returned_at']);
      warn.mockRestore();
    });
  });
});

// Una versione storta non fallisce in modo riconoscibile: Shopify serve
// comunque qualcosa — la piu' vecchia ancora supportata — e l'app gira per mesi
// su una versione che nessuno ha scelto.
describe('la versione API configurata', () => {
  it('una versione ben formata si usa cosi com e', () => {
    expect(resolveApiVersion('2026-04')).toBe('2026-04');
    expect(resolveApiVersion('2027-01')).toBe('2027-01');
    // Gli spazi intorno capitano copiando da una guida.
    expect(resolveApiVersion('  2026-10  ')).toBe('2026-10');
  });

  it('assente: si usa quella predefinita, senza rumore', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveApiVersion(undefined)).toBe(DEFAULT_API_VERSION);
    expect(resolveApiVersion('')).toBe(DEFAULT_API_VERSION);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('storta: si dice ad alta voce e si riparte da un valore noto', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (const storta of ['latest', '2026-13', '2026', 'v2026-07', '2026-05', 'unstable']) {
      expect(resolveApiVersion(storta)).toBe(DEFAULT_API_VERSION);
    }

    expect(error).toHaveBeenCalledTimes(6);
    expect(error.mock.calls[0][0]).toContain('SHOPIFY_API_VERSION non valida');
    error.mockRestore();
  });
});

// Il 4 settembre due chiamate identiche a un secondo di distanza hanno dato una
// il catalogo e l'altra INTERNAL_SERVER_ERROR, e la dashboard ha risposto 500
// su una card che al secondo tentativo si sarebbe riempita da sola.
describe('i guasti passeggeri si ritentano', () => {
  // Il finto va rifatto qui: `global.fetch` e' condiviso, e senza azzerarlo si
  // contano anche le chiamate dei blocchi precedenti.
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('riconosce una mutazione anche dopo commenti e righe vuote', () => {
    expect(isMutation('mutation Crea($x: ID!) { ... }')).toBe(true);
    expect(isMutation('\n  # un commento\n  mutation { ... }')).toBe(true);
    expect(isMutation('query Elenco { products { id } }')).toBe(false);
    // La forma abbreviata e' una lettura: senza parola davanti, e' una query.
    expect(isMutation('{ products { id } }')).toBe(false);
    // "mutationLog" non e' "mutation": la parola dev'essere intera.
    expect(isMutation('query mutationLog { id }')).toBe(false);
  });

  it('una lettura si ritenta sui guasti dell altra parte, non sui nostri', () => {
    const interno = new ShopifyRequestError('x', null, null, 'INTERNAL_SERVER_ERROR');
    expect(retryDelay(interno, 1, false)).toBe(300);
    expect(retryDelay(interno, 2, false)).toBe(600);
    // Al terzo si smette: l'attesa totale e' gia' quasi un secondo, e chi
    // guarda la dashboard sta aspettando.
    expect(retryDelay(interno, MAX_ATTEMPTS, false)).toBeNull();

    expect(retryDelay(new ShopifyRequestError('x', 503), 1, false)).toBe(300);
    // Un token scaduto, un permesso mancante, una richiesta sbagliata: non
    // cambiano idea riprovando, e ritentarli ritarda solo l errore da mostrare.
    expect(retryDelay(new ShopifyRequestError('x', 401), 1, false)).toBeNull();
    expect(retryDelay(new ShopifyRequestError('x', 403), 1, false)).toBeNull();
    expect(retryDelay(new ShopifyRequestError('x', 422), 1, false)).toBeNull();
  });

  it('una scrittura si ritenta solo quando e certo che non sia passata', () => {
    // 429 e THROTTLED: respinta prima di essere eseguita, ripeterla e sicuro.
    expect(retryDelay(new ShopifyRequestError('x', 429), 1, true)).toBe(300);
    expect(retryDelay(new ShopifyRequestError('x', null, null, 'THROTTLED'), 1, true)).toBe(300);
    // 500 e connessione caduta: non si sa se l addebito sia stato applicato.
    expect(retryDelay(new ShopifyRequestError('x', 500), 1, true)).toBeNull();
    expect(retryDelay(new TypeError('fetch failed'), 1, true)).toBeNull();
    // La stessa connessione caduta, su una lettura, si riprova.
    expect(retryDelay(new TypeError('fetch failed'), 1, false)).toBe(300);
  });

  it('quando Shopify dice quanto aspettare, si aspetta quello', () => {
    expect(retryDelay(new ShopifyRequestError('x', 429, 2), 1, false)).toBe(2000);
    // Mai meno dell attesa nostra: un Retry-After di zero non autorizza a
    // ripartire nello stesso istante.
    expect(retryDelay(new ShopifyRequestError('x', 429, 0), 2, false)).toBe(600);
  });

  it('la lettura che fallisce una volta arriva comunque in fondo', async () => {
    vi.useFakeTimers();
    (global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'X-Shopify-API-Version': '2026-07' }),
        json: async () => ({
          errors: [{ message: 'Internal error.', extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
        }),
      })
      .mockResolvedValueOnce(ok({ productsCount: { count: 7 } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = client().getProductsCount();
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe(7);

    expect((global.fetch as any).mock.calls).toHaveLength(2);
    expect(warn.mock.calls[0][0]).toContain('tentativo 1 fallito');
    warn.mockRestore();
    vi.useRealTimers();
  });

  it('se il guasto non passa, l errore arriva a chi ha chiesto', async () => {
    vi.useFakeTimers();
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      headers: new Headers(),
      text: async () => 'niente',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = client().getProductsCount();
    const atteso = expect(pending).rejects.toThrow('503');
    await vi.advanceTimersByTimeAsync(1000);
    await atteso;

    expect((global.fetch as any).mock.calls).toHaveLength(MAX_ATTEMPTS);
    warn.mockRestore();
    vi.useRealTimers();
  });
});

// Il recupero dell'opzione sugli ordini storici (shipping-method-backfill):
// una query leggera per lotti di id, solo il titolo della prima shipping line.
describe('getOrderShippingFacts', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('chiede i campi dei fatti logistici con nodes(ids:), per gli id dati, e conta come la lettura dell ordine', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        nodes: [
          {
            id: 'gid://shopify/Order/11',
            displayFulfillmentStatus: 'FULFILLED',
            requiresShipping: true,
            shippingAddress: { countryCodeV2: 'IT' },
            shippingLines: { nodes: [{ title: 'Express' }, { title: 'Altro' }] },
            fulfillments: [
              { status: 'SUCCESS', trackingInfo: [{ number: 'A' }, { number: 'B' }, { number: 'C' }] },
              { status: 'CANCELLED', trackingInfo: [] },
            ],
            returns: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ status: 'OPEN', createdAt: '2026-08-05T00:00:00Z' }] },
          },
          {
            id: 'gid://shopify/Order/12',
            displayFulfillmentStatus: 'UNFULFILLED',
            requiresShipping: false,
            shippingAddress: null,
            shippingLines: { nodes: [] },
            fulfillments: [],
            returns: { nodes: [{ status: 'CANCELED', createdAt: '2026-08-05T00:00:00Z' }] },
          },
        ],
      }),
    );

    const fatti = await client().getOrderShippingFacts(['11', '12']);

    const corpo = sentBody();
    expect(corpo.query).toContain('nodes(ids: $ids)');
    expect(corpo.query).toContain('shippingLines(first: 1) { nodes { title deliveryCategory } }');
    expect(corpo.query).toContain('fulfillments(first: 10) { status trackingInfo { number } }');
    expect(corpo.query).toContain('requiresShipping');
    expect(corpo.query).toContain('shippingAddress { countryCodeV2 }');
    expect(corpo.query).toContain('returns(first: 5) { pageInfo { hasNextPage endCursor } nodes { status createdAt } }');
    // Niente righe, clienti o importi: il costo della query resta minimo.
    expect(corpo.query).not.toContain('lineItems');
    expect(corpo.variables.ids).toEqual(['gid://shopify/Order/11', 'gid://shopify/Order/12']);
    expect(fatti.get('11')).toEqual({
      found: true, method: 'Express', packageCount: 3, returnedAt: '2026-08-05T00:00:00Z', returnsKnown: true,
      fulfillmentStatus: 'FULFILLED', countryCode: 'IT', countryKnown: true,
    });
    expect(fatti.get('12')).toEqual({
      found: true, method: '', packageCount: 0, returnedAt: null, returnsKnown: true,
      fulfillmentStatus: 'UNFULFILLED', countryCode: null, countryKnown: true,
    });
  });

  it('campi oscurati: sconosciuti, non zero; ordine non piu\' su Shopify: non trovato', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        nodes: [
          { id: 'gid://shopify/Order/1', shippingLines: null, fulfillments: null, returns: null },
          { id: 'gid://shopify/Order/2', shippingLines: { nodes: [{ title: null }] }, fulfillments: [], returns: { nodes: [] } },
          null,
        ],
      }),
    );

    const fatti = await client().getOrderShippingFacts(['1', '2', '3']);

    expect(fatti.get('1')).toMatchObject({
      found: true, method: null, packageCount: null, returnedAt: null, returnsKnown: false,
      fulfillmentStatus: null, countryKnown: false,
    });
    expect(fatti.get('2')).toMatchObject({ found: true, method: null, packageCount: 0, returnedAt: null, returnsKnown: true });
    // Il nodo nullo e' l'ordine 3 (stessa posizione): cancellato su Shopify.
    expect(fatti.get('3')).toMatchObject({ found: false });
  });

  it('un ordine del lotto con 10 spedizioni si rilegge da solo', async () => {
    const dieci = Array.from({ length: 10 }, (_, i) => ({ status: 'SUCCESS', trackingInfo: [{ number: `T${i}` }] }));
    (global.fetch as any)
      .mockResolvedValueOnce(
        ok({ nodes: [{ id: 'gid://shopify/Order/5', shippingLines: { nodes: [] }, fulfillments: dieci, returns: { nodes: [] } }] }),
      )
      .mockResolvedValueOnce(ok({ node: { fulfillments: [...dieci, { status: 'SUCCESS', trackingInfo: [] }] } }));
    const fatti = await client().getOrderShippingFacts(['5']);
    expect(fatti.get('5')?.packageCount).toBe(11);
  });

  it('id oltre 2^53 restano esatti: si confrontano come testo', async () => {
    const grande = '9007199254740993';
    (global.fetch as any).mockResolvedValueOnce(
      ok({
        nodes: [
          {
            id: `gid://shopify/Order/${grande}`,
            shippingLines: { nodes: [{ title: 'Std' }] },
            fulfillments: [{ status: 'SUCCESS', trackingInfo: [] }],
            returns: { nodes: [] },
          },
        ],
      }),
    );
    const fatti = await client().getOrderShippingFacts([grande]);
    expect(fatti.get(grande)).toMatchObject({ method: 'Std', packageCount: 1 });
  });

  it('query oltre il costo massimo: errore riconoscibile, non ritentato uguale', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      headers: new Headers({ 'X-Shopify-API-Version': '2026-07' }),
      json: async () => ({
        errors: [{ message: 'Query cost is 1600', extensions: { code: 'MAX_COST_EXCEEDED', cost: 1600, maxCost: 1000 } }],
      }),
    });
    const errore = await client().getOrderShippingFacts(['1']).catch((e) => e);
    expect(errore).toBeInstanceOf(ShopifyRequestError);
    expect(errore.graphqlCode).toBe('MAX_COST_EXCEEDED');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('nessun id: nessuna chiamata', async () => {
    const fatti = await client().getOrderShippingFacts([]);
    expect(fatti.size).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('serbatoio di punti sotto il costo del lotto successivo: aspetta e lo dice nei log', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'X-Shopify-API-Version': '2026-07' }),
      json: async () => ({
        data: { nodes: [] },
        extensions: {
          cost: {
            requestedQueryCost: 400,
            throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 250, restoreRate: 100 },
          },
        },
      }),
    });

    let finito = false;
    const promessa = client()
      .getOrderShippingFacts(['1'])
      .then(() => {
        finito = true;
      });
    // (400 - 250) punti a 100 al secondo: un secondo e mezzo prima del
    // prossimo lotto (sotto la soglia del 90%, quindi nessun'altra attesa).
    await vi.advanceTimersByTimeAsync(1_400);
    expect(finito).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await promessa;
    expect(finito).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('limite di costo'));
    warn.mockRestore();
    vi.useRealTimers();
  });
});
