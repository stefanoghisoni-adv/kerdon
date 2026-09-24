// app/lib/shipping/page-data.server.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const findMany = vi.fn();
const findUnique = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    shippingZone: { findMany },
    packagingConfig: { findUnique },
  },
}));

const { loadShippingPageData, EMPTY_PACKAGING } = await import('./page-data.server');

function erroreDiPrisma(code: string): Error {
  return new Prisma.PrismaClientKnownRequestError('table does not exist', { code, clientVersion: 'test' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadShippingPageData', () => {
  it('converte zone e packaging per la pagina', async () => {
    findMany.mockResolvedValue([
      {
        id: 'z1',
        zoneName: 'Italia',
        countries: ['IT'],
        restOfWorld: false,
        rateType: 'linear',
        rates: [{ id: 'r1', weightFrom: null, weightTo: null, cost: new Prisma.Decimal('2.50') }],
        options: [],
      },
    ]);
    findUnique.mockResolvedValue({
      categories: [{ name: 'Busta', cost: 1 }],
      fallbackRules: [{ weightMaxKg: null, category: 'Busta' }],
      defaultWeightPerItem: new Prisma.Decimal('0.5'),
      returnCost: null,
      updatedAt: new Date('2026-09-23T10:00:00Z'),
    });

    const dati = await loadShippingPageData('shop-1');

    expect(dati.zones).toEqual([
      {
        id: 'z1',
        zoneName: 'Italia',
        countries: ['IT'],
        restOfWorld: false,
        rateType: 'linear',
        rates: [{ id: 'r1', weightFromKg: null, weightToKg: null, cost: 2.5 }],
        options: [],
      },
    ]);
    expect(dati.packaging).toEqual({
      categories: [{ name: 'Busta', cost: 1 }],
      fallbackRules: [{ weightMaxKg: null, category: 'Busta' }],
      defaultWeightPerItemKg: 0.5,
      returnCost: null,
      configKey: '2026-09-23T10:00:00.000Z',
    });
  });

  it('senza packaging salvato: la configurazione vuota', async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue(null);
    expect(await loadShippingPageData('shop-1')).toEqual({ zones: [], packaging: EMPTY_PACKAGING });
  });

  it('tabelle non ancora create (P2021): pagina vuota invece di un 500', async () => {
    findMany.mockRejectedValue(erroreDiPrisma('P2021'));
    findUnique.mockRejectedValue(erroreDiPrisma('P2021'));
    expect(await loadShippingPageData('shop-1')).toEqual({ zones: [], packaging: EMPTY_PACKAGING });
  });

  it('colonna non ancora creata (P2022): pagina vuota', async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockRejectedValue(erroreDiPrisma('P2022'));
    expect(await loadShippingPageData('shop-1')).toEqual({ zones: [], packaging: EMPTY_PACKAGING });
  });

  it('un guasto vero non si nasconde', async () => {
    findMany.mockRejectedValue(new Error('connessione caduta'));
    findUnique.mockResolvedValue(null);
    await expect(loadShippingPageData('shop-1')).rejects.toThrow('connessione caduta');
  });
});
