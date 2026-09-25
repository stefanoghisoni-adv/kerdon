import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
const upsert = vi.fn();
const updateMany = vi.fn();
const optionFindMany = vi.fn();
const optionCreate = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    shippingZone: { findMany, upsert, updateMany },
    shippingOption: { findMany: optionFindMany, create: optionCreate },
  },
}));

const { syncShippingZones } = await import('./sync-zones.server');
const { computeLogisticsCost } = await import('./logistics-cost');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  findMany.mockResolvedValue([]);
  upsert.mockImplementation(async ({ where }) => ({
    id: `zone:${where.shopId_zoneName.zoneName}`,
  }));
  optionFindMany.mockResolvedValue([]);
  optionCreate.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// Risposte finte di Shopify
// ---------------------------------------------------------------------------

type Country = { code: { countryCode: string; restOfWorld: boolean } };

interface FakeMethod {
  name: string;
  active?: boolean;
  rateProvider:
    | { __typename: 'DeliveryRateDefinition'; price: { amount: string } }
    | { __typename: 'DeliveryParticipant'; id: string };
  methodConditions?: Array<{
    field: 'TOTAL_WEIGHT' | 'TOTAL_PRICE';
    operator: 'GREATER_THAN_OR_EQUAL_TO' | 'LESS_THAN_OR_EQUAL_TO';
    conditionCriteria:
      | { __typename: 'Weight'; unit: string; value: number }
      | { __typename: 'MoneyV2'; amount: string };
  }>;
}

interface FakeZone {
  name: string;
  countries: Country[];
  methods?: FakeMethod[];
  moreMethods?: boolean;
}

const ZONE_PAGE = 5;

/**
 * admin.graphql finto: `profiles[i][j]` sono le zone del gruppo di sedi j del
 * profilo i. Risponde alla lista dei profili e, per ogni gruppo, alle zone a
 * pagine di 5 come la query vera.
 */
function fakeAdmin(profiles: FakeZone[][][], profilePageSize = Infinity) {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const graphql = vi.fn(
    async (query: string, options?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: options?.variables });
      let body: unknown;
      if (query.includes('deliveryProfiles(')) {
        const start = options?.variables?.after ? Number(options.variables.after) : 0;
        const end = start + profilePageSize;
        const hasNextPage = end < profiles.length;
        body = {
          data: {
            deliveryProfiles: {
              pageInfo: { hasNextPage, endCursor: hasNextPage ? String(end) : null },
              nodes: profiles.slice(start, end).map((groups, k) => ({ i: start + k, groups })).map(({ i, groups }) => ({
                id: `gid://shopify/DeliveryProfile/${i}`,
                profileLocationGroups: groups.map((_, j) => ({
                  locationGroup: { id: `gid://shopify/DeliveryLocationGroup/${i}-${j}` },
                })),
              })),
            },
          },
        };
      } else {
        const v = options?.variables ?? {};
        const i = Number(String(v.profileId).split('/').pop());
        const j = Number(String(v.locationGroupId).split('-').pop());
        const zones = profiles[i][j];
        const start = v.after ? Number(v.after) : 0;
        const page = zones.slice(start, start + ZONE_PAGE);
        const hasNextPage = start + ZONE_PAGE < zones.length;
        body = {
          data: {
            deliveryProfile: {
              profileLocationGroups: [
                {
                  locationGroupZones: {
                    pageInfo: {
                      hasNextPage,
                      endCursor: hasNextPage ? String(start + ZONE_PAGE) : null,
                    },
                    nodes: page.map((z) => ({
                      zone: { name: z.name, countries: z.countries },
                      methodDefinitions: {
                        pageInfo: { hasNextPage: z.moreMethods ?? false },
                        nodes: (z.methods ?? []).map((m) => ({
                          active: true,
                          methodConditions: [],
                          ...m,
                        })),
                      },
                    })),
                  },
                },
              ],
            },
          },
        };
      }
      return { json: async () => body } as Response;
    }
  );
  return { admin: { graphql }, calls };
}

/** admin.graphql finto che risponde sempre lo stesso JSON (errori). */
function fixedAdmin(body: unknown) {
  return { graphql: async () => ({ json: async () => body }) as Response };
}

const c = (countryCode: string, restOfWorld = false): Country => ({
  code: { countryCode, restOfWorld },
});

const flatRate = (amount: string) =>
  ({ __typename: 'DeliveryRateDefinition', price: { amount } }) as const;

const weight = (
  operator: 'GREATER_THAN_OR_EQUAL_TO' | 'LESS_THAN_OR_EQUAL_TO',
  value: number,
  unit = 'KILOGRAMS'
) => ({
  field: 'TOTAL_WEIGHT' as const,
  operator,
  conditionCriteria: { __typename: 'Weight' as const, unit, value },
});

const price = (operator: 'GREATER_THAN_OR_EQUAL_TO' | 'LESS_THAN_OR_EQUAL_TO', amount: string) => ({
  field: 'TOTAL_PRICE' as const,
  operator,
  conditionCriteria: { __typename: 'MoneyV2' as const, amount },
});

function createdOption(name: string) {
  const call = optionCreate.mock.calls.find(([arg]) => arg.data.name === name);
  return call?.[0].data;
}

// ---------------------------------------------------------------------------
// Zone (comportamento esistente)
// ---------------------------------------------------------------------------

describe('syncShippingZones — zone', () => {
  it('crea una zona nuova con rateType linear e nessuna tariffa', async () => {
    const { admin } = fakeAdmin([[[{ name: 'Europa', countries: [c('IT'), c('FR')] }]]]);

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result).toEqual({ added: 1, updated: 0, optionsAdded: 0 });
    expect(upsert).toHaveBeenCalledWith({
      where: { shopId_zoneName: { shopId: 'shop-1', zoneName: 'Europa' } },
      create: {
        shopId: 'shop-1',
        zoneName: 'Europa',
        countries: ['FR', 'IT'],
        restOfWorld: false,
        rateType: 'linear',
        syncedAt: expect.any(Date),
      },
      update: {
        countries: ['FR', 'IT'],
        restOfWorld: false,
        syncedAt: expect.any(Date),
      },
    });
  });

  it('aggiorna una zona esistente senza toccare rateType', async () => {
    const { admin } = fakeAdmin([[[{ name: 'Europa', countries: [c('IT'), c('DE')] }]]]);
    findMany.mockResolvedValue([{ zoneName: 'Europa' }]);

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result).toEqual({ added: 0, updated: 1, optionsAdded: 0 });
    const arg = upsert.mock.calls[0][0];
    expect(arg.update).toEqual({
      countries: ['DE', 'IT'],
      restOfWorld: false,
      syncedAt: expect.any(Date),
    });
    expect(arg.update).not.toHaveProperty('rateType');
  });

  it('unisce i paesi quando lo stesso nome appare su piu profili', async () => {
    const { admin } = fakeAdmin([
      [[{ name: 'Europa', countries: [c('IT'), c('FR')] }]],
      [[{ name: 'Europa', countries: [c('FR'), c('DE')] }]],
    ]);

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result).toEqual({ added: 1, updated: 0, optionsAdded: 0 });
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].create.countries).toEqual(['DE', 'FR', 'IT']);
  });

  it('restOfWorld true su un paese rende restOfWorld della zona true', async () => {
    const { admin } = fakeAdmin([
      [[{ name: 'Resto del mondo', countries: [c('US'), c('XX', true)] }]],
    ]);

    await syncShippingZones(admin, 'shop-1');

    expect(upsert.mock.calls[0][0].create).toMatchObject({
      countries: ['US'],
      restOfWorld: true,
    });
  });

  it('solleva un errore chiaro se manca lo scope', async () => {
    const admin = fixedAdmin({
      errors: [
        {
          message: 'Access denied for deliveryProfiles field.',
          extensions: { code: 'ACCESS_DENIED' },
        },
      ],
    });

    await expect(syncShippingZones(admin, 'shop-1')).rejects.toThrow(
      'Manca lo scope read_shipping'
    );
  });

  it('riconosce lo scope mancante anche sulla seconda query (zone del gruppo)', async () => {
    const graphql = vi.fn(async (query: string) => {
      const body = query.includes('deliveryProfiles(')
        ? {
            data: {
              deliveryProfiles: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'gid://shopify/DeliveryProfile/1',
                    profileLocationGroups: [{ locationGroup: { id: 'gid://shopify/DeliveryLocationGroup/1' } }],
                  },
                ],
              },
            },
          }
        : {
            errors: [
              {
                message: 'Access denied for methodDefinitions field.',
                extensions: { code: 'ACCESS_DENIED' },
              },
            ],
          };
      return { json: async () => body } as Response;
    });

    await expect(syncShippingZones({ graphql }, 'shop-1')).rejects.toThrow(
      'Manca lo scope read_shipping'
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('riconosce lo scope mancante quando il client admin SOLLEVA (GraphqlQueryError)', async () => {
    // Forma di GraphqlQueryError di @shopify/shopify-api: il messaggio e' il
    // primo errore, i dettagli stanno in body.errors.graphQLErrors.
    const thrown = Object.assign(new Error('Access denied for deliveryProfiles field.'), {
      body: {
        errors: {
          graphQLErrors: [
            { message: 'Access denied for deliveryProfiles field.', extensions: { code: 'ACCESS_DENIED' } },
          ],
        },
      },
    });
    const graphql = vi.fn(async () => {
      throw thrown;
    });

    await expect(syncShippingZones({ graphql }, 'shop-1')).rejects.toThrow(
      'Manca lo scope read_shipping'
    );
  });

  it('un errore sollevato dal client che non riguarda i permessi resta com e', async () => {
    const graphql = vi.fn(async () => {
      throw new Error('rete giu');
    });

    await expect(syncShippingZones({ graphql }, 'shop-1')).rejects.toThrow('rete giu');
  });

  it('propaga gli altri errori GraphQL senza scrivere nulla', async () => {
    const admin = fixedAdmin({ errors: [{ message: 'Query cost exceeded' }] });

    await expect(syncShippingZones(admin, 'shop-1')).rejects.toThrow(
      'GraphQL error: Query cost exceeded'
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('gestisce profili senza zone', async () => {
    const { admin } = fakeAdmin([[]]);

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result).toEqual({ added: 0, updated: 0, optionsAdded: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('legge tutte le pagine di zone di un gruppo di sedi', async () => {
    const zones = Array.from({ length: 7 }, (_, k) => ({
      name: `Zona ${k}`,
      countries: [c(`C${k}`)],
    }));
    const { admin, calls } = fakeAdmin([[zones]]);

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result.added).toBe(7);
    const zoneCalls = calls.filter((call) => !call.query.includes('deliveryProfiles('));
    expect(zoneCalls.map((call) => call.variables?.after ?? null)).toEqual([null, '5']);
  });
});

// ---------------------------------------------------------------------------
// Opzioni di spedizione
// ---------------------------------------------------------------------------

describe('syncShippingZones — opzioni', () => {
  it('forfettaria: opzione flat con una riga a costo 0', async () => {
    const { admin } = fakeAdmin([
      [[{ name: 'Italia', countries: [c('IT')], methods: [{ name: 'Standard', rateProvider: flatRate('4.90') }] }]],
    ]);

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result.optionsAdded).toBe(1);
    expect(optionCreate).toHaveBeenCalledWith({
      data: {
        zoneId: 'zone:Italia',
        name: 'Standard',
        costType: 'flat',
        shopifyKind: 'DeliveryRateDefinition',
        // Da confermare: finche' il merchant non salva il costo vale la
        // tariffa della zona, non lo zero proposto.
        confirmed: false,
        rates: { create: [{ rangeFrom: null, rangeTo: null, cost: 0 }] },
      },
    });
  });

  it('fasce di peso con lo stesso nome diventano una opzione con piu fasce, in kg', async () => {
    const { admin } = fakeAdmin([
      [
        [
          {
            name: 'Italia',
            countries: [c('IT')],
            methods: [
              {
                name: 'Corriere espresso',
                rateProvider: flatRate('12.00'),
                methodConditions: [
                  weight('GREATER_THAN_OR_EQUAL_TO', 2),
                  weight('LESS_THAN_OR_EQUAL_TO', 5000, 'GRAMS'),
                ],
              },
              {
                name: 'Corriere espresso',
                rateProvider: flatRate('8.00'),
                methodConditions: [weight('LESS_THAN_OR_EQUAL_TO', 2)],
              },
              {
                name: 'Corriere espresso',
                rateProvider: flatRate('20.00'),
                methodConditions: [weight('GREATER_THAN_OR_EQUAL_TO', 5)],
              },
            ],
          },
        ],
      ],
    ]);

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result.optionsAdded).toBe(1);
    expect(optionCreate).toHaveBeenCalledTimes(1);
    const arg = createdOption('Corriere espresso');
    expect(arg.costType).toBe('weight_brackets');
    expect(arg.shopifyKind).toBe('DeliveryRateDefinition:TOTAL_WEIGHT');
    // Senza soglia minima la prima fascia parte da 0.
    expect(arg.rates.create).toEqual([
      { rangeFrom: 0, rangeTo: 2, cost: 0 },
      { rangeFrom: 2, rangeTo: 5, cost: 0 },
      { rangeFrom: 5, rangeTo: null, cost: 0 },
    ]);
  });

  it('converte libbre e once in kg', async () => {
    const { admin } = fakeAdmin([
      [
        [
          {
            name: 'USA',
            countries: [c('US')],
            methods: [
              {
                name: 'Ground',
                rateProvider: flatRate('5.00'),
                methodConditions: [
                  weight('GREATER_THAN_OR_EQUAL_TO', 8, 'OUNCES'),
                  weight('LESS_THAN_OR_EQUAL_TO', 2, 'POUNDS'),
                ],
              },
            ],
          },
        ],
      ],
    ]);

    await syncShippingZones(admin, 'shop-1');

    // L'ultima fascia resta aperta verso l'alto (vedi la prova sotto).
    expect(createdOption('Ground').rates.create).toEqual([
      { rangeFrom: 0.227, rangeTo: null, cost: 0 },
    ]);
  });

  it("fasce d'importo: opzione value_brackets con le soglie nella valuta del negozio", async () => {
    const { admin } = fakeAdmin([
      [
        [
          {
            name: 'Italia',
            countries: [c('IT')],
            methods: [
              {
                name: 'Standard',
                rateProvider: flatRate('0.00'),
                methodConditions: [price('GREATER_THAN_OR_EQUAL_TO', '50.0')],
              },
              {
                name: 'Standard',
                rateProvider: flatRate('5.90'),
                methodConditions: [
                  price('GREATER_THAN_OR_EQUAL_TO', '0.0'),
                  price('LESS_THAN_OR_EQUAL_TO', '49.99'),
                ],
              },
            ],
          },
        ],
      ],
    ]);

    await syncShippingZones(admin, 'shop-1');

    const arg = createdOption('Standard');
    expect(arg.costType).toBe('value_brackets');
    expect(arg.shopifyKind).toBe('DeliveryRateDefinition:TOTAL_PRICE');
    expect(arg.rates.create).toEqual([
      // Contigue: 49,99 < 50 lasciava scoperti gli ordini da 49,99 a 50.
      { rangeFrom: 0, rangeTo: 50, cost: 0 },
      { rangeFrom: 50, rangeTo: null, cost: 0 },
    ]);
  });

  it('calcolata dal corriere: opzione linear con una riga a costo 0', async () => {
    const { admin } = fakeAdmin([
      [
        [
          {
            name: 'Europa',
            countries: [c('FR')],
            methods: [
              {
                name: 'UPS',
                rateProvider: { __typename: 'DeliveryParticipant', id: 'gid://shopify/DeliveryParticipant/1' },
              },
            ],
          },
        ],
      ],
    ]);

    await syncShippingZones(admin, 'shop-1');

    const arg = createdOption('UPS');
    expect(arg.costType).toBe('linear');
    expect(arg.shopifyKind).toBe('DeliveryParticipant');
    expect(arg.rates.create).toEqual([{ rangeFrom: null, rangeTo: null, cost: 0 }]);
  });

  it('importa anche i metodi disattivati', async () => {
    const { admin } = fakeAdmin([
      [
        [
          {
            name: 'Italia',
            countries: [c('IT')],
            methods: [{ name: 'Ritiro vecchio', active: false, rateProvider: flatRate('3.00') }],
          },
        ],
      ],
    ]);

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result.optionsAdded).toBe(1);
    expect(createdOption('Ritiro vecchio')).toBeDefined();
  });

  it("re-import: l'opzione esistente conserva tipo e costi del merchant", async () => {
    const { admin } = fakeAdmin([
      [
        [
          {
            name: 'Italia',
            countries: [c('IT')],
            methods: [
              {
                name: 'standard ',
                rateProvider: flatRate('0.00'),
                methodConditions: [price('GREATER_THAN_OR_EQUAL_TO', '50.0')],
              },
              { name: 'Express', rateProvider: flatRate('9.90') },
            ],
          },
        ],
      ],
    ]);
    findMany.mockResolvedValue([{ zoneName: 'Italia' }]);
    // Il merchant aveva gia' "Standard" (flat a 4,90): confronto senza
    // maiuscole e spazi ai bordi come l'abbinamento degli ordini.
    optionFindMany.mockResolvedValue([{ name: 'Standard' }]);

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result).toEqual({ added: 0, updated: 1, optionsAdded: 1 });
    expect(optionFindMany).toHaveBeenCalledWith({
      where: { zoneId: 'zone:Italia' },
      select: { name: true },
    });
    expect(optionCreate).toHaveBeenCalledTimes(1);
    expect(createdOption('Express')).toBeDefined();
    expect(createdOption('standard')).toBeUndefined();
  });

  it('le opzioni di una zona su piu profili si uniscono per nome', async () => {
    const { admin } = fakeAdmin([
      [[{ name: 'Italia', countries: [c('IT')], methods: [{ name: 'Standard', rateProvider: flatRate('4.90') }] }]],
      [[{ name: 'Italia', countries: [c('IT')], methods: [{ name: 'Standard', rateProvider: flatRate('5.90') }] }]],
    ]);

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result.optionsAdded).toBe(1);
    expect(optionCreate).toHaveBeenCalledTimes(1);
  });

  it('avvisa quando una zona ha piu metodi di quelli letti', async () => {
    const { admin } = fakeAdmin([
      [
        [
          {
            name: 'Italia',
            countries: [c('IT')],
            methods: [{ name: 'Standard', rateProvider: flatRate('4.90') }],
            moreMethods: true,
          },
        ],
      ],
    ]);

    await syncShippingZones(admin, 'shop-1');

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Italia'));
  });

  it("un ordine sulla soglia inclusiva di Shopify trova la sua fascia (49,99 e 49,995)", async () => {
    const { admin } = fakeAdmin([
      [
        [
          {
            name: 'Italia',
            countries: [c('IT')],
            methods: [
              {
                name: 'Standard',
                rateProvider: flatRate('5.90'),
                methodConditions: [
                  price('GREATER_THAN_OR_EQUAL_TO', '0.0'),
                  price('LESS_THAN_OR_EQUAL_TO', '49.99'),
                ],
              },
              {
                name: 'Standard',
                rateProvider: flatRate('0.00'),
                methodConditions: [price('GREATER_THAN_OR_EQUAL_TO', '50.0')],
              },
            ],
          },
        ],
      ],
    ]);

    await syncShippingZones(admin, 'shop-1');

    // Il merchant scrive i costi reali sulle fasce importate.
    const imported = createdOption('Standard').rates.create as Array<{
      rangeFrom: number | null;
      rangeTo: number | null;
    }>;
    const brackets = imported.map((r, k) => ({ from: r.rangeFrom, to: r.rangeTo, cost: k === 0 ? 4 : 6 }));
    const config = {
      zones: [
        {
          zoneName: 'Italia',
          countries: ['IT'],
          restOfWorld: false,
          rateType: 'linear' as const,
          rates: [],
          options: [{ name: 'Standard', costType: 'value_brackets' as const, confirmed: true, brackets }],
        },
      ],
      categories: [],
      fallbackRules: [],
      defaultWeightPerItemKg: null,
      returnCost: null,
    };
    const order = (total_price: number) => ({
      fulfillment_status: 'FULFILLED',
      shipping_country_code: 'IT',
      total_weight_grams: 1000,
      item_count: 1,
      returned_at: null,
      packaging_category: null,
      shipping_method: 'Standard',
      total_price,
    });

    expect(computeLogisticsCost(order(49.99), config).shipping).toBe(4);
    expect(computeLogisticsCost(order(49.995), config).shipping).toBe(4);
    expect(computeLogisticsCost(order(50), config).shipping).toBe(6);
  });

  it('la prima fascia senza soglia minima parte da 0', async () => {
    const { admin } = fakeAdmin([
      [
        [
          {
            name: 'Italia',
            countries: [c('IT')],
            methods: [
              {
                name: 'Standard',
                rateProvider: flatRate('5.90'),
                methodConditions: [price('LESS_THAN_OR_EQUAL_TO', '29.99')],
              },
              {
                name: 'Standard',
                rateProvider: flatRate('0.00'),
                methodConditions: [price('GREATER_THAN_OR_EQUAL_TO', '30.0')],
              },
            ],
          },
        ],
      ],
    ]);

    await syncShippingZones(admin, 'shop-1');

    expect(createdOption('Standard').rates.create).toEqual([
      { rangeFrom: 0, rangeTo: 30, cost: 0 },
      { rangeFrom: 30, rangeTo: null, cost: 0 },
    ]);
  });

  it('avvisa e ignora la soglia con unita di peso sconosciuta', async () => {
    const { admin } = fakeAdmin([
      [
        [
          {
            name: 'Italia',
            countries: [c('IT')],
            methods: [
              {
                name: 'Pesante',
                rateProvider: flatRate('9.00'),
                methodConditions: [
                  weight('GREATER_THAN_OR_EQUAL_TO', 1),
                  weight('LESS_THAN_OR_EQUAL_TO', 3, 'STONES'),
                ],
              },
            ],
          },
        ],
      ],
    ]);

    await syncShippingZones(admin, 'shop-1');

    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/STONES.*Pesante.*Italia/));
    expect(createdOption('Pesante').rates.create).toEqual([{ rangeFrom: 1, rangeTo: null, cost: 0 }]);
  });

  it('opzione creata da un import concorrente (P2002): non conta e il sync prosegue', async () => {
    const { admin } = fakeAdmin([
      [
        [
          {
            name: 'Italia',
            countries: [c('IT')],
            methods: [
              { name: 'Standard', rateProvider: flatRate('4.90') },
              { name: 'Express', rateProvider: flatRate('9.90') },
            ],
          },
        ],
      ],
    ]);
    optionCreate.mockImplementation(async ({ data }) => {
      if (data.name === 'Standard') {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      return {};
    });

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result.optionsAdded).toBe(1);
    expect(optionCreate).toHaveBeenCalledTimes(2);
  });

  it("l'ultima fascia importata resta senza limite: un ordine piu pesante la trova", async () => {
    const { admin } = fakeAdmin([
      [
        [
          {
            name: 'Italia',
            countries: [c('IT')],
            methods: [
              { name: 'Corriere', rateProvider: flatRate('6.00'), methodConditions: [weight('LESS_THAN_OR_EQUAL_TO', 2)] },
              {
                name: 'Corriere',
                rateProvider: flatRate('9.00'),
                methodConditions: [weight('GREATER_THAN_OR_EQUAL_TO', 2), weight('LESS_THAN_OR_EQUAL_TO', 5)],
              },
            ],
          },
        ],
      ],
    ]);

    await syncShippingZones(admin, 'shop-1');

    const imported = createdOption('Corriere').rates.create as Array<{ rangeFrom: number | null; rangeTo: number | null }>;
    expect(imported).toEqual([
      { rangeFrom: 0, rangeTo: 2, cost: 0 },
      { rangeFrom: 2, rangeTo: null, cost: 0 },
    ]);

    // Il merchant compila e conferma: un pacco da 7 kg prende l'ultima fascia, non zero.
    const config = {
      zones: [
        {
          zoneName: 'Italia',
          countries: ['IT'],
          restOfWorld: false,
          rateType: 'linear' as const,
          rates: [],
          options: [
            {
              name: 'Corriere',
              costType: 'weight_brackets' as const,
              confirmed: true,
              brackets: imported.map((r, k) => ({ from: r.rangeFrom, to: r.rangeTo, cost: k === 0 ? 5 : 8 })),
            },
          ],
        },
      ],
      categories: [],
      fallbackRules: [],
      defaultWeightPerItemKg: null,
      returnCost: null,
    };
    const cost = computeLogisticsCost(
      {
        fulfillment_status: 'FULFILLED',
        shipping_country_code: 'IT',
        total_weight_grams: 7000,
        item_count: 1,
        returned_at: null,
        packaging_category: null,
        shipping_method: 'Corriere',
        total_price: 100,
      },
      config,
    );
    expect(cost.shipping).toBe(8);
  });

  it.each(['P2021', 'P2022'])(
    'tabelle delle opzioni non ancora create (%s): le zone si importano e il sync riesce',
    async (code) => {
      const { Prisma } = await import('@prisma/client');
      const { admin } = fakeAdmin([
        [
          [
            { name: 'Italia', countries: [c('IT')], methods: [{ name: 'Standard', rateProvider: flatRate('4.90') }] },
            { name: 'Europa', countries: [c('FR')], methods: [{ name: 'Express', rateProvider: flatRate('9.90') }] },
          ],
        ],
      ]);
      optionFindMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('missing', { code, clientVersion: 'test' }),
      );

      const result = await syncShippingZones(admin, 'shop-1');

      expect(result).toEqual({ added: 2, updated: 0, optionsAdded: 0 });
      expect(upsert).toHaveBeenCalledTimes(2);
      // Dopo il primo errore le opzioni non si ritentano zona per zona.
      expect(optionFindMany).toHaveBeenCalledTimes(1);
      expect(optionCreate).not.toHaveBeenCalled();
    },
  );

  it('colonna delle opzioni non ancora creata alla scrittura (P2022): il sync riesce', async () => {
    const { Prisma } = await import('@prisma/client');
    const { admin } = fakeAdmin([
      [[{ name: 'Italia', countries: [c('IT')], methods: [{ name: 'Standard', rateProvider: flatRate('4.90') }] }]],
    ]);
    optionCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('missing column', { code: 'P2022', clientVersion: 'test' }),
    );

    await expect(syncShippingZones(admin, 'shop-1')).resolves.toEqual({ added: 1, updated: 0, optionsAdded: 0 });
  });

  it("ogni altro errore nella creazione dell'opzione interrompe il sync", async () => {
    const { admin } = fakeAdmin([
      [[{ name: 'Italia', countries: [c('IT')], methods: [{ name: 'Standard', rateProvider: flatRate('4.90') }] }]],
    ]);
    optionCreate.mockRejectedValue(new Error('connessione persa'));

    await expect(syncShippingZones(admin, 'shop-1')).rejects.toThrow('connessione persa');
  });
});

describe('syncShippingZones — paginazione dei profili', () => {
  it('legge tutte le pagine di profili', async () => {
    const { admin, calls } = fakeAdmin(
      [
        [[{ name: 'Italia', countries: [c('IT')] }]],
        [[{ name: 'Francia', countries: [c('FR')] }]],
        [[{ name: 'Germania', countries: [c('DE')] }]],
      ],
      2
    );

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result.added).toBe(3);
    const profileCalls = calls.filter((call) => call.query.includes('deliveryProfiles('));
    expect(profileCalls.map((call) => call.variables?.after ?? null)).toEqual([null, '2']);
  });

  it('si ferma se Shopify dice che ci sono altre pagine ma non da il cursore', async () => {
    let profileCalls = 0;
    const graphql = vi.fn(async (query: string) => {
      const body = query.includes('deliveryProfiles(')
        ? (profileCalls++,
          {
            data: {
              deliveryProfiles: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] },
            },
          })
        : { data: { deliveryProfile: null } };
      return { json: async () => body } as Response;
    });

    const result = await syncShippingZones({ graphql }, 'shop-1');

    expect(result).toEqual({ added: 0, updated: 0, optionsAdded: 0 });
    expect(profileCalls).toBe(1);
  });

  it('avvisa quando raggiunge il limite di pagine', async () => {
    let n = 0;
    const graphql = vi.fn(async () => {
      n++;
      const body = {
        data: {
          deliveryProfiles: { pageInfo: { hasNextPage: true, endCursor: `c${n}` }, nodes: [] },
        },
      };
      return { json: async () => body } as Response;
    });

    await syncShippingZones({ graphql }, 'shop-1');

    expect(n).toBe(200);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('200 pagine'));
  });
});
