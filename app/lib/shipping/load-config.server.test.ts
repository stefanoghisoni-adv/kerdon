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

const { loadLogisticsConfig, loadLogisticsConfigStrict } = await import('./load-config.server');

/** L'errore che Prisma solleva quando la tabella non c'e' ancora. */
function tabellaMancante(): Error {
  return new Prisma.PrismaClientKnownRequestError('table does not exist', {
    code: 'P2021',
    clientVersion: 'test',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('loadLogisticsConfig', () => {
  it('ritorna null quando non ci sono zone ne packaging', async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue(null);

    const result = await loadLogisticsConfig('shop-1');

    expect(result).toBeNull();
  });

  it('converte Decimal in number per zone e rates', async () => {
    findMany.mockResolvedValue([
      {
        zoneName: 'Europa',
        countries: ['IT', 'FR'],
        restOfWorld: false,
        rateType: 'linear',
        rates: [
          {
            weightFrom: new Prisma.Decimal(0),
            weightTo: new Prisma.Decimal(5),
            cost: new Prisma.Decimal(10.5),
          },
        ],
        options: [],
      },
    ]);
    findUnique.mockResolvedValue(null);

    const result = await loadLogisticsConfig('shop-1');

    expect(result).toEqual({
      zones: [
        {
          zoneName: 'Europa',
          countries: ['IT', 'FR'],
          restOfWorld: false,
          rateType: 'linear',
          rates: [
            {
              weightFromKg: 0,
              weightToKg: 5,
              cost: 10.5,
            },
          ],
          options: [],
        },
      ],
      categories: [],
      fallbackRules: [],
      defaultWeightPerItemKg: null,
      returnCost: null,
    });
  });

  it('converte Decimal in number per packaging config', async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue({
      categories: [{ name: 'Scatola', cost: 2.5 }],
      fallbackRules: [{ weightMaxKg: 10, category: 'Scatola' }],
      defaultWeightPerItem: new Prisma.Decimal(0.5),
      returnCost: new Prisma.Decimal(5),
    });

    const result = await loadLogisticsConfig('shop-1');

    expect(result).toEqual({
      zones: [],
      categories: [{ name: 'Scatola', cost: 2.5, origin: 'manual' }],
      fallbackRules: [{ weightMaxKg: 10, category: 'Scatola' }],
      defaultWeightPerItemKg: 0.5,
      returnCost: 5,
    });
  });

  it('ritorna null su P2021 senza rumore', async () => {
    findMany.mockRejectedValue(tabellaMancante());

    const result = await loadLogisticsConfig('shop-1');

    expect(result).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it('difende contro JSON malformato nelle categorie', async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue({
      categories: [
        { name: 'Scatola', cost: 2.5 },
        { name: 'Rotta' }, // manca cost
        'non un oggetto',
      ],
      fallbackRules: [],
      defaultWeightPerItem: null,
      returnCost: null,
    });

    const result = await loadLogisticsConfig('shop-1');

    expect(result?.categories).toEqual([{ name: 'Scatola', cost: 2.5, origin: 'manual' }]);
  });

  it("legge l'origine delle categorie: 'shopify' resta, assente o sconosciuta vale 'manual'", async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue({
      categories: [
        { name: 'Da Shopify', cost: 0, origin: 'shopify' },
        { name: 'Vecchia', cost: 1 },
        { name: 'Strana', cost: 2, origin: 42 },
        { name: 'Creata', cost: 3, origin: 'manual' },
      ],
      fallbackRules: [],
      defaultWeightPerItem: null,
      returnCost: null,
    });

    const result = await loadLogisticsConfig('shop-1');

    expect(result?.categories).toEqual([
      { name: 'Da Shopify', cost: 0, origin: 'shopify' },
      { name: 'Vecchia', cost: 1, origin: 'manual' },
      { name: 'Strana', cost: 2, origin: 'manual' },
      { name: 'Creata', cost: 3, origin: 'manual' },
    ]);
  });

  it('difende contro JSON malformato nelle fallback rules', async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue({
      categories: [],
      fallbackRules: [
        { weightMaxKg: 10, category: 'Scatola' },
        { weightMaxKg: 5 }, // manca category
        'non un oggetto',
      ],
      defaultWeightPerItem: null,
      returnCost: null,
    });

    const result = await loadLogisticsConfig('shop-1');

    expect(result?.fallbackRules).toEqual([{ weightMaxKg: 10, category: 'Scatola' }]);
  });

  it('regole salvate fuori ordine: il calcolo le applica per peso crescente, come le mostra la pagina', async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue({
      categories: [],
      fallbackRules: [
        { weightMaxKg: 5, category: 'A' },
        { weightMaxKg: 1, category: 'B' },
        { weightMaxKg: null, category: 'C' },
      ],
      defaultWeightPerItem: null,
      returnCost: null,
    });

    const result = await loadLogisticsConfig('shop-1');

    expect(result?.fallbackRules).toEqual([
      { weightMaxKg: 1, category: 'B' },
      { weightMaxKg: 5, category: 'A' },
      { weightMaxKg: null, category: 'C' },
    ]);
  });

  it('gestisce zone senza tariffe', async () => {
    findMany.mockResolvedValue([
      {
        zoneName: 'Europa',
        countries: ['IT'],
        restOfWorld: false,
        rateType: 'linear',
        rates: [],
        options: [],
      },
    ]);
    findUnique.mockResolvedValue(null);

    const result = await loadLogisticsConfig('shop-1');

    expect(result?.zones[0].rates).toEqual([]);
  });

  it('gestisce weightFrom/weightTo null', async () => {
    findMany.mockResolvedValue([
      {
        zoneName: 'Europa',
        countries: ['IT'],
        restOfWorld: false,
        rateType: 'linear',
        rates: [
          {
            weightFrom: null,
            weightTo: null,
            cost: new Prisma.Decimal(10),
          },
        ],
        options: [],
      },
    ]);
    findUnique.mockResolvedValue(null);

    const result = await loadLogisticsConfig('shop-1');

    expect(result?.zones[0].rates[0]).toEqual({
      weightFromKg: null,
      weightToKg: null,
      cost: 10,
    });
  });

  it('carica le opzioni di spedizione e converte i Decimal', async () => {
    findMany.mockResolvedValue([
      {
        zoneName: 'Italia',
        countries: ['IT'],
        restOfWorld: false,
        rateType: 'linear',
        rates: [],
        options: [
          {
            name: 'Standard',
            costType: 'flat',
            confirmed: true,
            rates: [
              {
                rangeFrom: null,
                rangeTo: null,
                cost: new Prisma.Decimal(5.5),
              },
            ],
          },
          {
            name: 'Express',
            costType: 'weight_brackets',
            rates: [
              {
                rangeFrom: new Prisma.Decimal(0),
                rangeTo: new Prisma.Decimal(2),
                cost: new Prisma.Decimal(8),
              },
              {
                rangeFrom: new Prisma.Decimal(2),
                rangeTo: null,
                cost: new Prisma.Decimal(12),
              },
            ],
          },
        ],
      },
    ]);
    findUnique.mockResolvedValue(null);

    const result = await loadLogisticsConfig('shop-1');

    expect(result?.zones[0].options).toEqual([
      {
        name: 'Standard',
        costType: 'flat',
        confirmed: true,
        brackets: [
          {
            from: null,
            to: null,
            cost: 5.5,
          },
        ],
      },
      {
        name: 'Express',
        costType: 'weight_brackets',
        // Nessun valore da Prisma: non confermata, vale la tariffa della zona.
        confirmed: false,
        brackets: [
          {
            from: 0,
            to: 2,
            cost: 8,
          },
          {
            from: 2,
            to: null,
            cost: 12,
          },
        ],
      },
    ]);
  });

  it('scarta opzioni con costType sconosciuto', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    findMany.mockResolvedValue([
      {
        zoneName: 'Italia',
        countries: ['IT'],
        restOfWorld: false,
        rateType: 'linear',
        rates: [],
        options: [
          {
            name: 'Standard',
            costType: 'flat',
            rates: [{ rangeFrom: null, rangeTo: null, cost: new Prisma.Decimal(5) }],
          },
          {
            name: 'Invalid',
            costType: 'invalid_type',
            rates: [{ rangeFrom: null, rangeTo: null, cost: new Prisma.Decimal(10) }],
          },
        ],
      },
    ]);
    findUnique.mockResolvedValue(null);

    const result = await loadLogisticsConfig('shop-1');

    expect(result?.zones[0].options).toHaveLength(1);
    expect(result?.zones[0].options[0].name).toBe('Standard');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('costType sconosciuto'),
      'invalid_type',
      'Invalid',
    );
  });
});

describe('loadLogisticsConfig: costo per pacco', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tiene le opzioni e le zone per pacco', async () => {
    findMany.mockResolvedValue([
      {
        zoneName: 'Italia',
        countries: ['IT'],
        restOfWorld: false,
        rateType: 'per_package',
        rates: [{ weightFrom: null, weightTo: null, cost: new Prisma.Decimal(5) }],
        options: [
          {
            name: 'Corriere',
            costType: 'per_package',
            confirmed: true,
            rates: [{ rangeFrom: null, rangeTo: null, cost: new Prisma.Decimal('4.9') }],
          },
        ],
      },
    ]);
    findUnique.mockResolvedValue(null);

    const result = await loadLogisticsConfig('shop-1');

    expect(result?.zones[0].rateType).toBe('per_package');
    expect(result?.zones[0].options).toEqual([
      { name: 'Corriere', costType: 'per_package', confirmed: true, brackets: [{ from: null, to: null, cost: 4.9 }] },
    ]);
  });
});

/**
 * La variante severa serve al ricalcolo in background: li' "nessuna tariffa" e
 * "tariffe illeggibili" portano a scritture opposte (zero su tutti gli ordini
 * contro nessuna scrittura), quindi i due casi non possono confondersi.
 */
describe('loadLogisticsConfigStrict', () => {
  it('ritorna null quando la configurazione non esiste', async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue(null);

    await expect(loadLogisticsConfigStrict('shop-1')).resolves.toBeNull();
  });

  it('ritorna null su P2021: tabelle owner non ancora create vuol dire nessuna tariffa', async () => {
    findMany.mockRejectedValue(tabellaMancante());
    findUnique.mockResolvedValue(null);

    await expect(loadLogisticsConfigStrict('shop-1')).resolves.toBeNull();
  });

  it('solleva su un guasto transitorio invece di fingere che non ci siano tariffe', async () => {
    findMany.mockRejectedValue(new Error('connection reset'));
    findUnique.mockResolvedValue(null);

    await expect(loadLogisticsConfigStrict('shop-1')).rejects.toThrow('connection reset');
  });

  it('la variante tollerante resta tollerante sullo stesso guasto', async () => {
    findMany.mockRejectedValue(new Error('connection reset'));
    findUnique.mockResolvedValue(null);

    await expect(loadLogisticsConfig('shop-1')).resolves.toBeNull();
  });
});

/**
 * La finestra fra il rilascio del codice e la migrazione delle opzioni: le
 * zone, le tariffe e l'imballo esistono gia', solo le tabelle delle opzioni
 * mancano. Il calcolo deve continuare con le tariffe di zona, non azzerarsi.
 */
describe('tabelle delle opzioni non ancora create', () => {
  const zonaItalia = {
    zoneName: 'Italia',
    countries: ['IT'],
    restOfWorld: false,
    rateType: 'linear',
    rates: [{ weightFrom: null, weightTo: null, cost: new Prisma.Decimal(5) }],
  };

  /** Prisma che fallisce solo quando la lettura include le opzioni. */
  function opzioniMancanti(code: 'P2021' | 'P2022') {
    findMany.mockImplementation(async (args: { include?: { options?: unknown } }) => {
      if (args?.include?.options) {
        throw new Prisma.PrismaClientKnownRequestError('missing', { code, clientVersion: 'test' });
      }
      return [zonaItalia];
    });
    findUnique.mockResolvedValue({
      categories: [{ name: 'scatola', cost: 1 }],
      fallbackRules: [],
      defaultWeightPerItem: null,
      returnCost: new Prisma.Decimal(3),
    });
  }

  it.each(['P2021', 'P2022'] as const)(
    '%s sulle opzioni: la variante severa rilegge senza opzioni e tiene zone e imballo',
    async (code) => {
      opzioniMancanti(code);

      const config = await loadLogisticsConfigStrict('shop-1');

      expect(config).not.toBeNull();
      expect(config?.zones).toHaveLength(1);
      expect(config?.zones[0].zoneName).toBe('Italia');
      expect(config?.zones[0].rates).toEqual([{ weightFromKg: null, weightToKg: null, cost: 5 }]);
      expect(config?.zones[0].options).toEqual([]);
      expect(config?.categories).toEqual([{ name: 'scatola', cost: 1, origin: 'manual' }]);
      expect(config?.returnCost).toBe(3);
    },
  );

  it('anche la variante tollerante tiene zone e imballo', async () => {
    opzioniMancanti('P2021');

    const config = await loadLogisticsConfig('shop-1');

    expect(config?.zones[0].rates[0].cost).toBe(5);
    expect(config?.categories).toHaveLength(1);
  });

  it('se manca anche la tabella delle zone resta null, come prima', async () => {
    findMany.mockRejectedValue(tabellaMancante());
    findUnique.mockResolvedValue(null);

    await expect(loadLogisticsConfigStrict('shop-1')).resolves.toBeNull();
  });
});
