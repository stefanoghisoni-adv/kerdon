// e2e/tests/spedizioni.spec.ts
//
// Le azioni della pagina Spedizioni: salvataggio tariffe e packaging.
//
// COSA COPRE. Le azioni `save-zone-rates` e `save-packaging` della rotta
// /spedizioni: validazione dei brackets, ownership delle zone, validazione del
// packaging. Non copre l'importazione delle zone (richiederebbe Shopify GraphQL)
// né la voce di menu (vive in App Bridge, fuori dalla portata dell'harness).

import { expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { test as prova } from './support/prova';
import { azzera, db, entraComeNegozio, NEGOZIO, ALTRO_NEGOZIO, seminaNegozio } from './support/server';

interface ZonaSeminata {
  id: string;
  shopId: string;
}

/** Semina una zona di spedizione con le sue tariffe. */
async function seminaZona(
  request: APIRequestContext,
  shopId: string,
  dati: {
    zoneName: string;
    countries: string[];
    rateType: 'linear' | 'brackets';
    rates: Array<{ weightFrom: number | null; weightTo: number | null; cost: number }>;
  },
): Promise<ZonaSeminata> {
  return db<ZonaSeminata>(request, 'shippingZone', 'create', {
    data: {
      shopId,
      zoneName: dati.zoneName,
      countries: dati.countries,
      restOfWorld: false,
      rateType: dati.rateType,
      rates: {
        create: dati.rates.map((r) => ({
          weightFrom: r.weightFrom,
          weightTo: r.weightTo,
          cost: r.cost,
        })),
      },
    },
    select: { id: true, shopId: true },
  });
}

/** Salva le tariffe di una zona. */
async function salvaTariffe(
  context: BrowserContext,
  dati: {
    zoneId: string;
    rateType: 'linear' | 'brackets';
    costPerKg?: string;
    brackets?: Array<{ weightFromKg: number | null; weightToKg: number | null; cost: number }>;
  },
): Promise<{ stato: number; corpo: Record<string, unknown> }> {
  const form = new URLSearchParams();
  form.set('intent', 'save-zone-rates');
  form.set('zoneId', dati.zoneId);
  form.set('rateType', dati.rateType);

  if (dati.rateType === 'linear' && dati.costPerKg) {
    form.set('costPerKg', dati.costPerKg);
  } else if (dati.rateType === 'brackets' && dati.brackets) {
    form.set('brackets', JSON.stringify(dati.brackets));
  }

  const risposta = await context.request.post('/spedizioni', {
    data: form.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return { stato: risposta.status(), corpo: (await risposta.json()) as Record<string, unknown> };
}

/** Salva la configurazione packaging. */
async function salvaPackaging(
  context: BrowserContext,
  dati: {
    categories: Array<{ name: string; cost: number }>;
    rules: Array<{ weightMaxKg: number | null; category: string }>;
    defaultWeightPerItemKg?: number | null;
    returnCost?: number | null;
  },
): Promise<{ stato: number; corpo: Record<string, unknown> }> {
  const form = new URLSearchParams();
  form.set('intent', 'save-packaging');
  form.set('categories', JSON.stringify(dati.categories));
  form.set('rules', JSON.stringify(dati.rules));

  if (dati.defaultWeightPerItemKg !== undefined && dati.defaultWeightPerItemKg !== null) {
    form.set('defaultWeightPerItemKg', String(dati.defaultWeightPerItemKg));
  }
  if (dati.returnCost !== undefined && dati.returnCost !== null) {
    form.set('returnCost', String(dati.returnCost));
  }

  const risposta = await context.request.post('/spedizioni', {
    data: form.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return { stato: risposta.status(), corpo: (await risposta.json()) as Record<string, unknown> };
}

prova.describe('le azioni della pagina Spedizioni', () => {
  prova.beforeEach(async ({ request, context }) => {
    await azzera(request);
    await entraComeNegozio(context, NEGOZIO);
  });

  prova.describe('save-zone-rates', () => {
    prova('con brackets contigui salva con successo', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Italia',
        countries: ['IT'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 3.0 }],
      });

      const { stato, corpo } = await salvaTariffe(context, {
        zoneId: zona.id,
        rateType: 'brackets',
        brackets: [
          { weightFromKg: 0, weightToKg: 5, cost: 10 },
          { weightFromKg: 5, weightToKg: 10, cost: 15 },
          { weightFromKg: 10, weightToKg: null, cost: 20 },
        ],
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(true);

      // Verifica che i brackets siano stati salvati
      const tariffe = await db<Array<{ weightFrom: string | null; weightTo: string | null; cost: string }>>(
        request,
        'shippingRate',
        'findMany',
        { where: { zoneId: zona.id }, orderBy: { weightFrom: 'asc' } },
      );

      expect(tariffe).toHaveLength(3);
      expect(Number(tariffe[0].weightFrom)).toBe(0);
      expect(Number(tariffe[0].weightTo)).toBe(5);
      expect(Number(tariffe[0].cost)).toBe(10);
    });

    prova('con brackets non contigui rifiuta con errore di validazione', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Francia',
        countries: ['FR'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 2.5 }],
      });

      // Brackets con un buco: 0-5, poi 7-10 (manca 5-7)
      const { stato, corpo } = await salvaTariffe(context, {
        zoneId: zona.id,
        rateType: 'brackets',
        brackets: [
          { weightFromKg: 0, weightToKg: 5, cost: 10 },
          { weightFromKg: 7, weightToKg: 10, cost: 15 },
        ],
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('shipping.errors.bracketsHaveGaps');
    });

    prova('con brackets sovrapposti rifiuta con errore di validazione', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Germania',
        countries: ['DE'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 2.0 }],
      });

      // Brackets sovrapposti: 0-6 e 5-10
      const { stato, corpo } = await salvaTariffe(context, {
        zoneId: zona.id,
        rateType: 'brackets',
        brackets: [
          { weightFromKg: 0, weightToKg: 6, cost: 10 },
          { weightFromKg: 5, weightToKg: 10, cost: 15 },
        ],
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('shipping.errors.bracketsOverlap');
    });

    prova('con zoneId di un altro shop rifiuta', async ({ request, context }) => {
      // Crea sia il negozio corrente (che ha la sessione) sia quello altrui
      await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const altroShop = await seminaNegozio(request, {
        setupCompletedAt: new Date().toISOString(),
      }, ALTRO_NEGOZIO);
      const zonaAltrui = await seminaZona(request, altroShop.id, {
        zoneName: 'Spagna',
        countries: ['ES'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 4.0 }],
      });

      // Il negozio corrente (NEGOZIO) prova a modificare una zona di ALTRO_NEGOZIO
      const { stato, corpo } = await salvaTariffe(context, {
        zoneId: zonaAltrui.id,
        rateType: 'linear',
        costPerKg: '5.0',
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('zone_not_found');
    });

    prova('la prima fascia deve partire da 0', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Portogallo',
        countries: ['PT'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 3.5 }],
      });

      const { stato, corpo } = await salvaTariffe(context, {
        zoneId: zona.id,
        rateType: 'brackets',
        brackets: [
          { weightFromKg: 1, weightToKg: 5, cost: 10 }, // Parte da 1 invece di 0
          { weightFromKg: 5, weightToKg: 10, cost: 15 },
        ],
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('shipping.errors.firstBracketMustStartAtZero');
    });

    prova('solo l ultima fascia puo essere illimitata', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Belgio',
        countries: ['BE'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 2.8 }],
      });

      const { stato, corpo } = await salvaTariffe(context, {
        zoneId: zona.id,
        rateType: 'brackets',
        brackets: [
          { weightFromKg: 0, weightToKg: null, cost: 10 }, // Illimitata ma non è l'ultima
          { weightFromKg: 10, weightToKg: 20, cost: 15 },
        ],
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('shipping.errors.onlyLastBracketCanBeUnlimited');
    });
  });

  prova.describe('save-packaging', () => {
    prova('con configurazione valida salva con successo', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

      const { stato, corpo } = await salvaPackaging(context, {
        categories: [
          { name: 'Busta', cost: 1.5 },
          { name: 'Scatola piccola', cost: 3.0 },
          { name: 'Scatola grande', cost: 5.0 },
        ],
        rules: [
          { weightMaxKg: 1, category: 'Busta' },
          { weightMaxKg: 5, category: 'Scatola piccola' },
          { weightMaxKg: null, category: 'Scatola grande' },
        ],
        defaultWeightPerItemKg: 0.5,
        returnCost: 4.0,
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(true);

      // Verifica che la configurazione sia stata salvata
      const config = await db<{
        categories: unknown;
        fallbackRules: unknown;
        defaultWeightPerItem: string;
        returnCost: string;
      } | null>(request, 'packagingConfig', 'findUnique', {
        where: { shopId: shop.id },
        select: {
          categories: true,
          fallbackRules: true,
          defaultWeightPerItem: true,
          returnCost: true,
        },
      });

      expect(config).not.toBeNull();
      expect(Number(config!.defaultWeightPerItem)).toBe(0.5);
      expect(Number(config!.returnCost)).toBe(4.0);
    });

    prova('con regola che punta a categoria mancante rifiuta', async ({ request, context }) => {
      await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

      const { stato, corpo } = await salvaPackaging(context, {
        categories: [
          { name: 'Busta', cost: 1.5 },
          { name: 'Scatola', cost: 3.0 },
        ],
        rules: [
          { weightMaxKg: 1, category: 'Busta' },
          { weightMaxKg: null, category: 'CategoriaInesistente' }, // Categoria che non esiste
        ],
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('shipping.packaging.errors.ruleInvalidCategory');
    });

    prova('con nome categoria duplicato rifiuta', async ({ request, context }) => {
      await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

      const { stato, corpo } = await salvaPackaging(context, {
        categories: [
          { name: 'Scatola', cost: 1.5 },
          { name: 'Scatola', cost: 3.0 }, // Nome duplicato
        ],
        rules: [
          { weightMaxKg: null, category: 'Scatola' },
        ],
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('shipping.packaging.errors.categoryNameDuplicate');
    });

    prova('con nome categoria vuoto rifiuta', async ({ request, context }) => {
      await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

      const { stato, corpo } = await salvaPackaging(context, {
        categories: [
          { name: '', cost: 1.5 }, // Nome vuoto
        ],
        rules: [
          { weightMaxKg: null, category: '' },
        ],
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('shipping.packaging.errors.categoryNameEmpty');
    });

    prova('con più regole illimitate rifiuta', async ({ request, context }) => {
      await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

      const { stato, corpo } = await salvaPackaging(context, {
        categories: [
          { name: 'Busta', cost: 1.5 },
          { name: 'Scatola', cost: 3.0 },
        ],
        rules: [
          { weightMaxKg: null, category: 'Busta' }, // Prima illimitata
          { weightMaxKg: null, category: 'Scatola' }, // Seconda illimitata
        ],
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('shipping.packaging.errors.multipleUnlimitedRules');
    });

    prova('con regola illimitata non ultima rifiuta', async ({ request, context }) => {
      await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

      const { stato, corpo } = await salvaPackaging(context, {
        categories: [
          { name: 'Busta', cost: 1.5 },
          { name: 'Scatola', cost: 3.0 },
        ],
        rules: [
          { weightMaxKg: null, category: 'Busta' }, // Illimitata ma non ultima
          { weightMaxKg: 5, category: 'Scatola' },
        ],
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('shipping.packaging.errors.unlimitedRuleMustBeLast');
    });
  });
});
