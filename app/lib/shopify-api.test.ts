import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShopifyAPIClient } from './shopify-api.server';

global.fetch = vi.fn();

// Il client si procura il token dalla libreria Shopify: qui non serve, i test
// costruiscono l'istanza direttamente con un token finto.
vi.mock('~/shopify.server', () => ({ unauthenticated: { admin: vi.fn() } }));

/** Risposta GraphQL riuscita. */
function ok(data: unknown, throttle?: { maximumAvailable: number; currentlyAvailable: number }) {
  return {
    ok: true,
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
