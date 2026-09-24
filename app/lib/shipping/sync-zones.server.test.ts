import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const findMany = vi.fn();
const upsert = vi.fn();
const updateMany = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    shippingZone: { findMany, upsert, updateMany },
    $transaction: vi.fn((callback) => callback({ shippingZone: { findMany, upsert, updateMany } })),
  },
}));

const { syncShippingZones } = await import('./sync-zones.server');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** Crea un admin.graphql finto che ritorna una risposta JSON. */
function fakeGraphql(responseData: any) {
  return async () => {
    return {
      json: async () => responseData,
    } as Response;
  };
}

describe('syncShippingZones', () => {
  it('crea una zona nuova con rateType linear e nessuna tariffa', async () => {
    const admin = {
      graphql: fakeGraphql({
        data: {
          deliveryProfiles: {
            nodes: [
              {
                profileLocationGroups: [
                  {
                    locationGroupZones: {
                      nodes: [
                        {
                          zone: {
                            name: 'Europa',
                            countries: [
                              { code: { countryCode: 'IT', restOfWorld: false } },
                              { code: { countryCode: 'FR', restOfWorld: false } },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      }),
    };

    findMany.mockResolvedValue([]);
    upsert.mockResolvedValue({});

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result).toEqual({ added: 1, updated: 0 });
    expect(upsert).toHaveBeenCalledWith({
      where: { shopId_zoneName: { shopId: 'shop-1', zoneName: 'Europa' } },
      create: {
        shopId: 'shop-1',
        zoneName: 'Europa',
        countries: ['FR', 'IT'], // sorted
        restOfWorld: false,
        rateType: 'linear',
        syncedAt: expect.any(Date),
      },
      update: {
        countries: ['FR', 'IT'], // sorted
        restOfWorld: false,
        syncedAt: expect.any(Date),
      },
    });
  });

  it('aggiorna una zona esistente senza toccare rateType', async () => {
    const admin = {
      graphql: fakeGraphql({
        data: {
          deliveryProfiles: {
            nodes: [
              {
                profileLocationGroups: [
                  {
                    locationGroupZones: {
                      nodes: [
                        {
                          zone: {
                            name: 'Europa',
                            countries: [
                              { code: { countryCode: 'IT', restOfWorld: false } },
                              { code: { countryCode: 'DE', restOfWorld: false } },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      }),
    };

    findMany.mockResolvedValue([
      { id: 'zone-1', shopId: 'shop-1', zoneName: 'Europa', rateType: 'brackets' },
    ]);
    upsert.mockResolvedValue({});

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result).toEqual({ added: 0, updated: 1 });
    expect(upsert).toHaveBeenCalledWith({
      where: { shopId_zoneName: { shopId: 'shop-1', zoneName: 'Europa' } },
      create: {
        shopId: 'shop-1',
        zoneName: 'Europa',
        countries: ['DE', 'IT'], // sorted
        restOfWorld: false,
        rateType: 'linear',
        syncedAt: expect.any(Date),
      },
      update: {
        countries: ['DE', 'IT'], // sorted
        restOfWorld: false,
        syncedAt: expect.any(Date),
      },
    });
  });

  it('unisce i paesi quando lo stesso nome appare su piu profili', async () => {
    const admin = {
      graphql: fakeGraphql({
        data: {
          deliveryProfiles: {
            nodes: [
              {
                profileLocationGroups: [
                  {
                    locationGroupZones: {
                      nodes: [
                        {
                          zone: {
                            name: 'Europa',
                            countries: [
                              { code: { countryCode: 'IT', restOfWorld: false } },
                              { code: { countryCode: 'FR', restOfWorld: false } },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                profileLocationGroups: [
                  {
                    locationGroupZones: {
                      nodes: [
                        {
                          zone: {
                            name: 'Europa',
                            countries: [
                              { code: { countryCode: 'FR', restOfWorld: false } },
                              { code: { countryCode: 'DE', restOfWorld: false } },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      }),
    };

    findMany.mockResolvedValue([]);
    upsert.mockResolvedValue({});

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result).toEqual({ added: 1, updated: 0 });
    expect(upsert).toHaveBeenCalledWith({
      where: { shopId_zoneName: { shopId: 'shop-1', zoneName: 'Europa' } },
      create: {
        shopId: 'shop-1',
        zoneName: 'Europa',
        countries: ['DE', 'FR', 'IT'], // sorted
        restOfWorld: false,
        rateType: 'linear',
        syncedAt: expect.any(Date),
      },
      update: {
        countries: ['DE', 'FR', 'IT'], // sorted
        restOfWorld: false,
        syncedAt: expect.any(Date),
      },
    });
  });

  it('restOfWorld true su un paese rende restOfWorld della zona true', async () => {
    const admin = {
      graphql: fakeGraphql({
        data: {
          deliveryProfiles: {
            nodes: [
              {
                profileLocationGroups: [
                  {
                    locationGroupZones: {
                      nodes: [
                        {
                          zone: {
                            name: 'Resto del mondo',
                            countries: [
                              { code: { countryCode: 'US', restOfWorld: false } },
                              { code: { countryCode: 'XX', restOfWorld: true } },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      }),
    };

    findMany.mockResolvedValue([]);
    upsert.mockResolvedValue({});

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result).toEqual({ added: 1, updated: 0 });
    expect(upsert).toHaveBeenCalledWith({
      where: { shopId_zoneName: { shopId: 'shop-1', zoneName: 'Resto del mondo' } },
      create: {
        shopId: 'shop-1',
        zoneName: 'Resto del mondo',
        countries: ['US'],
        restOfWorld: true,
        rateType: 'linear',
        syncedAt: expect.any(Date),
      },
      update: {
        countries: ['US'],
        restOfWorld: true,
        syncedAt: expect.any(Date),
      },
    });
  });

  it('solleva un errore chiaro se manca lo scope', async () => {
    const admin = {
      graphql: fakeGraphql({
        errors: [
          {
            message: 'Access denied for deliveryProfiles field.',
            extensions: { code: 'ACCESS_DENIED' },
          },
        ],
      }),
    };

    await expect(syncShippingZones(admin, 'shop-1')).rejects.toThrow(
      'Manca lo scope read_shipping'
    );
  });

  it('gestisce profili senza zone', async () => {
    const admin = {
      graphql: fakeGraphql({
        data: {
          deliveryProfiles: {
            nodes: [
              {
                profileLocationGroups: [],
              },
            ],
          },
        },
      }),
    };

    findMany.mockResolvedValue([]);

    const result = await syncShippingZones(admin, 'shop-1');

    expect(result).toEqual({ added: 0, updated: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });
});
