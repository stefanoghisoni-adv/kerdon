import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
const upsert = vi.fn();
const updateMany = vi.fn();
const optionFindMany = vi.fn();
const optionUpsert = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    shippingZone: { findMany, upsert, updateMany },
    shippingOption: { findMany: optionFindMany, upsert: optionUpsert },
  },
}));

const { syncShippingZones } = await import('./sync-zones.server');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  findMany.mockResolvedValue([]);
  upsert.mockImplementation(async ({ where }) => ({
    id: `zone:${where.shopId_zoneName.zoneName}`,
  }));
  optionFindMany.mockResolvedValue([]);
  optionUpsert.mockResolvedValue({});
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
function fakeAdmin(profiles: FakeZone[][][]) {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const graphql = vi.fn(
    async (query: string, options?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: options?.variables });
      let body: unknown;
      if (query.includes('deliveryProfiles(')) {
        body = {
          data: {
            deliveryProfiles: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: profiles.map((groups, i) => ({
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
  const call = optionUpsert.mock.calls.find(([arg]) => arg.create.name === name);
  return call?.[0];
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
    expect(optionUpsert).toHaveBeenCalledWith({
      where: { zoneId_name: { zoneId: 'zone:Italia', name: 'Standard' } },
      create: {
        zoneId: 'zone:Italia',
        name: 'Standard',
        costType: 'flat',
        shopifyKind: 'DeliveryRateDefinition',
        rates: { create: [{ rangeFrom: null, rangeTo: null, cost: 0 }] },
      },
      update: {},
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
    expect(optionUpsert).toHaveBeenCalledTimes(1);
    const arg = createdOption('Corriere espresso');
    expect(arg.create.costType).toBe('weight_brackets');
    expect(arg.create.shopifyKind).toBe('DeliveryRateDefinition:TOTAL_WEIGHT');
    expect(arg.create.rates.create).toEqual([
      { rangeFrom: null, rangeTo: 2, cost: 0 },
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

    expect(createdOption('Ground').create.rates.create).toEqual([
      { rangeFrom: 0.227, rangeTo: 0.907, cost: 0 },
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
    expect(arg.create.costType).toBe('value_brackets');
    expect(arg.create.shopifyKind).toBe('DeliveryRateDefinition:TOTAL_PRICE');
    expect(arg.create.rates.create).toEqual([
      { rangeFrom: 0, rangeTo: 49.99, cost: 0 },
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
    expect(arg.create.costType).toBe('linear');
    expect(arg.create.shopifyKind).toBe('DeliveryParticipant');
    expect(arg.create.rates.create).toEqual([{ rangeFrom: null, rangeTo: null, cost: 0 }]);
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
    expect(optionUpsert).toHaveBeenCalledTimes(1);
    expect(createdOption('Express').update).toEqual({});
    expect(createdOption('standard')).toBeUndefined();
  });

  it('le opzioni di una zona su piu profili si uniscono per nome', async () => {
    const { admin } = fakeAdmin([
      [[{ name: 'Italia', countries: [c('IT')], methods: [{ name: 'Standard', rateProvider: flatRate('4.90') }] }]],
      [[{ name: 'Italia', countries: [c('IT')], methods: [{ name: 'Standard', rateProvider: flatRate('5.90') }] }]],
    ]);

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result.optionsAdded).toBe(1);
    expect(optionUpsert).toHaveBeenCalledTimes(1);
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
});
