// e2e/tests/spedizioni.spec.ts
//
// Le azioni della pagina Spedizioni: salvataggio tariffe e packaging.
//
// COSA COPRE. Le azioni della rotta /spedizioni (tariffe, costi opzione,
// categorie e regole di imballo una riga alla volta, peso di default e resi,
// importazione zone): validazione dei brackets, ownership delle zone,
// validazione del packaging, JSON malformato, importazione zone (con l'admin
// GraphQL finto) e il ricalcolo accodato dopo l'importazione. Non copre la voce
// di menu (vive in App Bridge, fuori dalla portata dell'harness).
//
// IL CONTRATTO CON LA PAGINA. La pagina non si puo' montare qui (il server di
// prova chiama loader e action, non renderizza le rotte embedded), quindi la
// catena "risposta del server -> toast o banner" si prova in due pezzi che si
// toccano: ogni risposta qui porta il suo `intent`, e la si passa a
// `feedbackFromActionData` — la stessa funzione che usa la pagina — per
// verificare che produca il toast o il banner giusto. E' il pezzo che mancava
// quando i toast non comparivano mai.

import { expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { test as prova } from './support/prova';
import { azzera, db, entraComeNegozio, finti, NEGOZIO, ALTRO_NEGOZIO, seminaNegozio } from './support/server';
import { it as italiano } from '~/lib/i18n/it';
import { feedbackFromActionData, type ShippingActionData } from '~/components/Shipping/feedback';

interface ZonaSeminata {
  id: string;
  shopId: string;
}

interface OpzioneSeminata {
  id: string;
  zoneId: string;
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

/** Semina un'opzione di spedizione con le sue tariffe. */
async function seminaOpzione(
  request: APIRequestContext,
  zoneId: string,
  dati: {
    name: string;
    costType: 'flat' | 'linear' | 'weight_brackets' | 'value_brackets';
    rates: Array<{ from: number | null; to: number | null; cost: number }>;
  },
): Promise<OpzioneSeminata> {
  return db<OpzioneSeminata>(request, 'shippingOption', 'create', {
    data: {
      zoneId,
      name: dati.name,
      costType: dati.costType,
      rates: {
        create: dati.rates.map((r) => ({
          rangeFrom: r.from,
          rangeTo: r.to,
          cost: r.cost,
        })),
      },
    },
    select: { id: true, zoneId: true },
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

/** Salva i costi di un'opzione di spedizione. */
async function salvaCostiOpzione(
  context: BrowserContext,
  dati: {
    optionId: string;
    costType: 'flat' | 'linear' | 'weight_brackets' | 'value_brackets';
    flatCost?: string;
    linearCost?: string;
    brackets?: Array<{ from: number | null; to: number | null; cost: number }>;
  },
): Promise<{ stato: number; corpo: Record<string, unknown> }> {
  const form = new URLSearchParams();
  form.set('intent', 'save-option-cost');
  form.set('optionId', dati.optionId);
  form.set('costType', dati.costType);

  if (dati.costType === 'flat' && dati.flatCost) {
    form.set('flatCost', dati.flatCost);
  } else if (dati.costType === 'linear' && dati.linearCost) {
    form.set('linearCost', dati.linearCost);
  } else if ((dati.costType === 'weight_brackets' || dati.costType === 'value_brackets') && dati.brackets) {
    form.set('brackets', JSON.stringify(dati.brackets));
  }

  const risposta = await context.request.post('/spedizioni', {
    data: form.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return { stato: risposta.status(), corpo: (await risposta.json()) as Record<string, unknown> };
}

/** Una richiesta grezza all'azione, per i casi che gli helper sopra non sanno scrivere. */
async function inviaForm(
  context: BrowserContext,
  campi: Record<string, string>,
): Promise<{ stato: number; corpo: Record<string, unknown> }> {
  const risposta = await context.request.post('/spedizioni', {
    data: new URLSearchParams(campi).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return { stato: risposta.status(), corpo: (await risposta.json()) as Record<string, unknown> };
}

/** Cosa vedrebbe il merchant per questa risposta, deciso dalla funzione della pagina. */
const cosaVede = (corpo: Record<string, unknown>) =>
  feedbackFromActionData(corpo as unknown as ShippingActionData, italiano);

/** Le zone come le restituisce l'admin GraphQL di Shopify. */
/**
 * L'import legge a due query (vedi sync-zones.server): prima i profili con i
 * gruppi di sedi (`DeliveryZonesProfiles`), poi le zone di ogni gruppo
 * (`DeliveryZonesByGroup`). Un profilo con un gruppo basta a queste prove.
 */
function risposteZone(zone: Array<{ name: string; countries: Array<{ countryCode: string; restOfWorld: boolean }> }>) {
  return [
    {
      match: 'DeliveryZonesProfiles',
      body: {
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
      },
    },
    {
      match: 'DeliveryZonesByGroup',
      body: {
        data: {
          deliveryProfile: {
            profileLocationGroups: [
              {
                locationGroupZones: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: zone.map((z) => ({
                    zone: { name: z.name, countries: z.countries.map((c) => ({ code: c })) },
                    methodDefinitions: { pageInfo: { hasNextPage: false }, nodes: [] },
                  })),
                },
              },
            ],
          },
        },
      },
    },
  ];
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

  prova.describe('cosa vede il merchant dopo ogni azione', () => {
    prova('tariffe salvate: la risposta porta l intento e la pagina mostra il toast di successo', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Italia',
        countries: ['IT'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 3.0 }],
      });

      const { corpo } = await salvaTariffe(context, { zoneId: zona.id, rateType: 'linear', costPerKg: '4.5' });

      expect(corpo).toMatchObject({ intent: 'save-zone-rates', success: true });
      const f = cosaVede(corpo);
      expect(f.toast).toEqual({ content: italiano.shipping.modal.saveSuccess, error: false });
      expect(f.zoneSaved).toBe(true);
    });

    prova('tariffe rifiutate: toast di errore e modale aperta con il motivo', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Francia',
        countries: ['FR'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 2.5 }],
      });

      const { corpo } = await salvaTariffe(context, {
        zoneId: zona.id,
        rateType: 'brackets',
        brackets: [
          { weightFromKg: 0, weightToKg: 5, cost: 10 },
          { weightFromKg: 7, weightToKg: null, cost: 15 },
        ],
      });

      expect(corpo).toMatchObject({ intent: 'save-zone-rates', success: false });
      const f = cosaVede(corpo);
      expect(f.toast).toEqual({ content: italiano.shipping.modal.saveError, error: true });
      expect(f.zoneSaved).toBe(false);
      expect(f.zoneError).toBe(italiano.shipping.errors.bracketsHaveGaps);
    });

    prova('permesso sulle spedizioni mancante: banner, non toast', async ({ request, context }) => {
      await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      await finti(request, {
        graphql: [
          {
            match: 'DeliveryZones',
            body: { errors: [{ message: 'Access denied for deliveryProfiles field.', extensions: { code: 'ACCESS_DENIED' } }] },
          },
        ],
      });

      const { stato, corpo } = await inviaForm(context, { intent: 'sync-zones' });

      expect(stato).toBe(200);
      expect(corpo).toEqual({ intent: 'sync-zones', success: false, error: 'scope_error' });
      const f = cosaVede(corpo);
      expect(f.scopeError).toBe(true);
      expect(f.toast).toBeNull();
    });

    prova('permesso mancante sulla seconda query (zone del gruppo): banner, non toast', async ({ request, context }) => {
      await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const [profili] = risposteZone([]);
      await finti(request, {
        graphql: [
          profili,
          {
            match: 'DeliveryZonesByGroup',
            body: { errors: [{ message: 'Access denied for methodDefinitions field.', extensions: { code: 'ACCESS_DENIED' } }] },
          },
        ],
      });

      const { stato, corpo } = await inviaForm(context, { intent: 'sync-zones' });

      expect(stato).toBe(200);
      expect(corpo).toEqual({ intent: 'sync-zones', success: false, error: 'scope_error' });
      const f = cosaVede(corpo);
      expect(f.scopeError).toBe(true);
      expect(f.toast).toBeNull();
    });

    prova('importazione riuscita: toast di successo e ricalcolo dei costi accodato', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      await finti(request, {
        graphql: risposteZone([
          { name: 'Italia', countries: [{ countryCode: 'IT', restOfWorld: false }] },
          { name: 'Mondo', countries: [{ countryCode: 'ZZ', restOfWorld: true }] },
        ]),
      });

      const { stato, corpo } = await inviaForm(context, { intent: 'sync-zones' });

      expect(stato).toBe(200);
      expect(corpo).toMatchObject({ intent: 'sync-zones', success: true });
      expect(cosaVede(corpo).toast).toEqual({ content: italiano.shipping.syncSuccess, error: false });

      // Le zone nuove cambiano i paesi e il resto del mondo: i costi gia'
      // scritti sugli ordini vanno rifatti.
      const accodati = await db<Array<{ type: string }>>(request, 'syncRequest', 'findMany', {
        where: { shopId: shop.id, type: 'logistics-recompute' },
        select: { type: true },
      });
      expect(accodati.length).toBeGreaterThan(0);
    });
  });

  prova.describe('dati malformati', () => {
    prova('fasce con JSON rotto: errore di validazione, non un 500', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Italia',
        countries: ['IT'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 3.0 }],
      });

      const { stato, corpo } = await inviaForm(context, {
        intent: 'save-zone-rates',
        zoneId: zona.id,
        rateType: 'brackets',
        brackets: '[{ rotto',
      });

      expect(stato).toBe(200);
      expect(corpo).toMatchObject({ intent: 'save-zone-rates', success: false, error: 'shipping.errors.invalidBrackets' });
    });

    prova('fasce con un costo stringa: rifiutate', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Italia',
        countries: ['IT'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 3.0 }],
      });

      const { stato, corpo } = await inviaForm(context, {
        intent: 'save-zone-rates',
        zoneId: zona.id,
        rateType: 'brackets',
        brackets: JSON.stringify([{ weightFromKg: 0, weightToKg: null, cost: '5' }]),
      });

      expect(stato).toBe(200);
      expect(corpo.error).toBe('shipping.errors.invalidBrackets');
    });

    prova('costo lineare non finito: rifiutato invece di un 500', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Italia',
        countries: ['IT'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 3.0 }],
      });

      const { stato, corpo } = await salvaTariffe(context, { zoneId: zona.id, rateType: 'linear', costPerKg: 'Infinity' });

      expect(stato).toBe(200);
      expect(corpo.error).toBe('shipping.errors.invalidLinearCost');
    });
  });

  prova.describe('save-option-cost', () => {
    prova('con costo fisso valido salva con successo', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Italia',
        countries: ['IT'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 3.0 }],
      });
      const opzione = await seminaOpzione(request, zona.id, {
        name: 'Standard',
        costType: 'flat',
        rates: [{ from: null, to: null, cost: 5.0 }],
      });

      const { stato, corpo } = await salvaCostiOpzione(context, {
        optionId: opzione.id,
        costType: 'flat',
        flatCost: '8.5',
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(true);

      // Verifica che il costo sia stato salvato
      const tariffe = await db<Array<{ rangeFrom: string | null; rangeTo: string | null; cost: string }>>(
        request,
        'shippingOptionRate',
        'findMany',
        { where: { optionId: opzione.id } },
      );

      expect(tariffe).toHaveLength(1);
      expect(tariffe[0].rangeFrom).toBeNull();
      expect(tariffe[0].rangeTo).toBeNull();
      expect(Number(tariffe[0].cost)).toBe(8.5);

      // Verifica che il costType sia aggiornato
      const opzioneAggiornata = await db<{ costType: string; confirmed: boolean } | null>(
        request,
        'shippingOption',
        'findUnique',
        { where: { id: opzione.id }, select: { costType: true, confirmed: true } },
      );
      expect(opzioneAggiornata?.costType).toBe('flat');
      // Salvare conferma l'opzione: da qui il suo costo vale sugli ordini.
      expect(opzioneAggiornata?.confirmed).toBe(true);
    });

    prova('con fasce di valore contigue salva con successo', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Francia',
        countries: ['FR'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 2.5 }],
      });
      const opzione = await seminaOpzione(request, zona.id, {
        name: 'Express',
        costType: 'flat',
        rates: [{ from: null, to: null, cost: 10.0 }],
      });

      const { stato, corpo } = await salvaCostiOpzione(context, {
        optionId: opzione.id,
        costType: 'value_brackets',
        brackets: [
          { from: 0, to: 50, cost: 5 },
          { from: 50, to: 100, cost: 3 },
          { from: 100, to: null, cost: 0 },
        ],
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(true);

      // Verifica che le fasce siano state salvate
      const tariffe = await db<Array<{ rangeFrom: string | null; rangeTo: string | null; cost: string }>>(
        request,
        'shippingOptionRate',
        'findMany',
        { where: { optionId: opzione.id }, orderBy: { rangeFrom: 'asc' } },
      );

      expect(tariffe).toHaveLength(3);
      expect(Number(tariffe[0].rangeFrom)).toBe(0);
      expect(Number(tariffe[0].rangeTo)).toBe(50);
      expect(Number(tariffe[0].cost)).toBe(5);
      expect(Number(tariffe[1].rangeFrom)).toBe(50);
      expect(Number(tariffe[1].rangeTo)).toBe(100);
      expect(Number(tariffe[1].cost)).toBe(3);
      expect(Number(tariffe[2].rangeFrom)).toBe(100);
      expect(tariffe[2].rangeTo).toBeNull();
      expect(Number(tariffe[2].cost)).toBe(0);

      // Verifica che il costType sia aggiornato
      const opzioneAggiornata = await db<{ costType: string; confirmed: boolean } | null>(
        request,
        'shippingOption',
        'findUnique',
        { where: { id: opzione.id }, select: { costType: true, confirmed: true } },
      );
      expect(opzioneAggiornata?.costType).toBe('value_brackets');
      expect(opzioneAggiornata?.confirmed).toBe(true);
    });

    prova('con fasce non contigue rifiuta con errore di validazione', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Germania',
        countries: ['DE'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 2.0 }],
      });
      const opzione = await seminaOpzione(request, zona.id, {
        name: 'Standard',
        costType: 'flat',
        rates: [{ from: null, to: null, cost: 7.0 }],
      });

      // Fasce con un buco: 0-30, poi 50-100 (manca 30-50)
      const { stato, corpo } = await salvaCostiOpzione(context, {
        optionId: opzione.id,
        costType: 'value_brackets',
        brackets: [
          { from: 0, to: 30, cost: 10 },
          { from: 50, to: 100, cost: 5 },
        ],
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('shipping.errors.bracketsHaveGaps');

      // Verifica che il database non sia cambiato
      const tariffe = await db<Array<{ rangeFrom: string | null; rangeTo: string | null; cost: string }>>(
        request,
        'shippingOptionRate',
        'findMany',
        { where: { optionId: opzione.id } },
      );

      expect(tariffe).toHaveLength(1);
      expect(Number(tariffe[0].cost)).toBe(7.0);

      const opzioneAggiornata = await db<{ costType: string; confirmed: boolean } | null>(
        request,
        'shippingOption',
        'findUnique',
        { where: { id: opzione.id }, select: { costType: true, confirmed: true } },
      );
      expect(opzioneAggiornata?.costType).toBe('flat');
      // Un salvataggio rifiutato non conferma l'opzione: resta la tariffa della zona.
      expect(opzioneAggiornata?.confirmed).toBe(false);
    });

    prova('con optionId di un altro shop rifiuta', async ({ request, context }) => {
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
      const opzioneAltrui = await seminaOpzione(request, zonaAltrui.id, {
        name: 'Express',
        costType: 'flat',
        rates: [{ from: null, to: null, cost: 12.0 }],
      });

      // Il negozio corrente (NEGOZIO) prova a modificare un'opzione di ALTRO_NEGOZIO
      const { stato, corpo } = await salvaCostiOpzione(context, {
        optionId: opzioneAltrui.id,
        costType: 'flat',
        flatCost: '15.0',
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('option_not_found');

      // Verifica che i dati dell'altro shop non siano cambiati
      const tariffe = await db<Array<{ cost: string }>>(
        request,
        'shippingOptionRate',
        'findMany',
        { where: { optionId: opzioneAltrui.id } },
      );

      expect(tariffe).toHaveLength(1);
      expect(Number(tariffe[0].cost)).toBe(12.0);
    });

    prova('con JSON malformato rifiuta con errore di validazione, non un 500', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Belgio',
        countries: ['BE'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 2.8 }],
      });
      const opzione = await seminaOpzione(request, zona.id, {
        name: 'Standard',
        costType: 'flat',
        rates: [{ from: null, to: null, cost: 6.0 }],
      });

      const { stato, corpo } = await inviaForm(context, {
        intent: 'save-option-cost',
        optionId: opzione.id,
        costType: 'weight_brackets',
        brackets: '[{ rotto',
      });

      expect(stato).toBe(200);
      expect(corpo).toMatchObject({
        intent: 'save-option-cost',
        success: false,
        error: 'shipping.errors.invalidBrackets',
      });
    });

    prova('con costo fisso negativo rifiuta', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Portogallo',
        countries: ['PT'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 3.5 }],
      });
      const opzione = await seminaOpzione(request, zona.id, {
        name: 'Standard',
        costType: 'flat',
        rates: [{ from: null, to: null, cost: 5.0 }],
      });

      const { stato, corpo } = await salvaCostiOpzione(context, {
        optionId: opzione.id,
        costType: 'flat',
        flatCost: '-2',
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('shipping.errors.invalidFlatCost');
    });

    prova('con costo al kg NaN rifiuta', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Austria',
        countries: ['AT'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 3.0 }],
      });
      const opzione = await seminaOpzione(request, zona.id, {
        name: 'Standard',
        costType: 'linear',
        rates: [{ from: null, to: null, cost: 4.0 }],
      });

      const { stato, corpo } = await salvaCostiOpzione(context, {
        optionId: opzione.id,
        costType: 'linear',
        linearCost: 'Infinity',
      });

      expect(stato).toBe(200);
      expect(corpo.success).toBe(false);
      expect(corpo.error).toBe('shipping.errors.invalidLinearCost');
    });

    prova('salvataggio riuscito accoda il ricalcolo, fallito no', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      const zona = await seminaZona(request, shop.id, {
        zoneName: 'Olanda',
        countries: ['NL'],
        rateType: 'linear',
        rates: [{ weightFrom: null, weightTo: null, cost: 2.5 }],
      });
      const opzione = await seminaOpzione(request, zona.id, {
        name: 'Standard',
        costType: 'flat',
        rates: [{ from: null, to: null, cost: 6.5 }],
      });

      // Prima del salvataggio: nessun ricalcolo accodato
      const primaDelSalvataggio = await db<Array<{ type: string }>>(request, 'syncRequest', 'findMany', {
        where: { shopId: shop.id, type: 'logistics-recompute' },
        select: { type: true },
      });

      // Salvataggio riuscito
      const { stato: statoOk, corpo: corpoOk } = await salvaCostiOpzione(context, {
        optionId: opzione.id,
        costType: 'flat',
        flatCost: '9.0',
      });

      expect(statoOk).toBe(200);
      expect(corpoOk.success).toBe(true);

      // Dopo il salvataggio riuscito: ricalcolo accodato
      const dopoSalvataggio = await db<Array<{ type: string }>>(request, 'syncRequest', 'findMany', {
        where: { shopId: shop.id, type: 'logistics-recompute' },
        select: { type: true },
      });
      expect(dopoSalvataggio.length).toBeGreaterThan(primaDelSalvataggio.length);

      // Salvataggio fallito
      const { stato: statoKo, corpo: corpoKo } = await salvaCostiOpzione(context, {
        optionId: opzione.id,
        costType: 'flat',
        flatCost: '-5',
      });

      expect(statoKo).toBe(200);
      expect(corpoKo.success).toBe(false);

      // Dopo il salvataggio fallito: nessun ricalcolo aggiunto
      const dopoFallimento = await db<Array<{ type: string }>>(request, 'syncRequest', 'findMany', {
        where: { shopId: shop.id, type: 'logistics-recompute' },
        select: { type: true },
      });
      expect(dopoFallimento.length).toBe(dopoSalvataggio.length);
    });
  });

  prova.describe('categorie e regole di imballo, una riga alla volta', () => {
    type Config = {
      categories: Array<{ name: string; cost: number; origin?: string }>;
      fallbackRules: Array<{ weightMaxKg: number | null; category: string }>;
      defaultWeightPerItem: string | null;
      returnCost: string | null;
    };

    /** Semina la configurazione packaging come la trova la pagina. */
    async function seminaPackaging(request: APIRequestContext, shopId: string, dati: Partial<Config>) {
      await db(request, 'packagingConfig', 'create', {
        data: {
          shopId,
          categories: dati.categories ?? [],
          fallbackRules: dati.fallbackRules ?? [],
          defaultWeightPerItem: dati.defaultWeightPerItem ?? null,
          returnCost: dati.returnCost ?? null,
        },
      });
    }

    const leggiPackaging = (request: APIRequestContext, shopId: string) =>
      db<Config | null>(request, 'packagingConfig', 'findUnique', {
        where: { shopId },
        select: { categories: true, fallbackRules: true, defaultWeightPerItem: true, returnCost: true },
      });

    const ricalcoli = async (request: APIRequestContext, shopId: string) =>
      (
        await db<Array<{ id: string }>>(request, 'syncRequest', 'findMany', {
          where: { shopId, type: 'logistics-recompute' },
          select: { id: true },
        })
      ).length;

    prova('aggiungi categoria: salvata come creata dal merchant, ricalcolo accodato, modale da chiudere', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });

      const { stato, corpo } = await inviaForm(context, { intent: 'save-category', name: ' Busta ', cost: '1.5' });

      expect(stato).toBe(200);
      expect(corpo).toEqual({ intent: 'save-category', success: true });
      const config = await leggiPackaging(request, shop.id);
      expect(config!.categories).toEqual([{ name: 'Busta', cost: 1.5, origin: 'manual' }]);
      expect(await ricalcoli(request, shop.id)).toBeGreaterThan(0);
      const f = cosaVede(corpo);
      expect(f.packagingSaved).toBe(true);
      expect(f.toast).toEqual({ content: italiano.shipping.packaging.categories.saved, error: false });
    });

    prova('aggiungi categoria con un nome gia in uso (maiuscole diverse): rifiutata, niente scritto', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      await seminaPackaging(request, shop.id, { categories: [{ name: 'Busta', cost: 1 }] });

      const { corpo } = await inviaForm(context, { intent: 'save-category', name: 'BUSTA', cost: '2' });

      expect(corpo).toEqual({
        intent: 'save-category',
        success: false,
        error: 'shipping.packaging.errors.categoryNameDuplicate',
      });
      expect((await leggiPackaging(request, shop.id))!.categories).toEqual([{ name: 'Busta', cost: 1 }]);
      expect(await ricalcoli(request, shop.id)).toBe(0);
      expect(cosaVede(corpo).packagingError).toBe(italiano.shipping.packaging.errors.categoryNameDuplicate);
    });

    prova('modifica categoria: nuovo nome e costo, le regole la seguono, peso e resi restano', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      await seminaPackaging(request, shop.id, {
        categories: [
          { name: 'Busta', cost: 1 },
          { name: 'Scatola', cost: 3, origin: 'shopify' },
        ],
        fallbackRules: [{ weightMaxKg: null, category: 'Scatola' }],
        defaultWeightPerItem: '0.4',
        returnCost: '5',
      });

      const { corpo } = await inviaForm(context, {
        intent: 'save-category',
        originalName: 'Scatola',
        name: 'Scatola media',
        cost: '4.25',
      });

      expect(corpo).toEqual({ intent: 'save-category', success: true });
      const config = await leggiPackaging(request, shop.id);
      expect(config!.categories).toEqual([
        { name: 'Busta', cost: 1, origin: 'manual' },
        { name: 'Scatola media', cost: 4.25, origin: 'shopify' },
      ]);
      expect(config!.fallbackRules).toEqual([{ weightMaxKg: null, category: 'Scatola media' }]);
      expect(Number(config!.defaultWeightPerItem)).toBe(0.4);
      expect(Number(config!.returnCost)).toBe(5);
    });

    prova('elimina categoria non usata: sparisce e il ricalcolo si accoda', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      await seminaPackaging(request, shop.id, {
        categories: [
          { name: 'Busta', cost: 1 },
          { name: 'Tubo', cost: 2 },
        ],
        fallbackRules: [{ weightMaxKg: null, category: 'Busta' }],
      });

      const { corpo } = await inviaForm(context, { intent: 'delete-category', name: 'Tubo' });

      expect(corpo).toEqual({ intent: 'delete-category', success: true });
      expect((await leggiPackaging(request, shop.id))!.categories).toEqual([
        { name: 'Busta', cost: 1, origin: 'manual' },
      ]);
      expect(await ricalcoli(request, shop.id)).toBeGreaterThan(0);
      expect(cosaVede(corpo).toast).toEqual({ content: italiano.shipping.packaging.categories.deleted, error: false });
    });

    prova('elimina categoria usata da una regola: bloccata con il motivo, niente cambia', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      await seminaPackaging(request, shop.id, {
        categories: [{ name: 'Busta', cost: 1 }],
        fallbackRules: [{ weightMaxKg: null, category: 'Busta' }],
      });

      const { corpo } = await inviaForm(context, { intent: 'delete-category', name: 'Busta' });

      expect(corpo).toEqual({
        intent: 'delete-category',
        success: false,
        error: 'shipping.packaging.errors.categoryStillReferenced',
      });
      expect((await leggiPackaging(request, shop.id))!.categories).toEqual([{ name: 'Busta', cost: 1 }]);
      expect(await ricalcoli(request, shop.id)).toBe(0);
      const f = cosaVede(corpo);
      expect(f.packagingSaved).toBe(false);
      expect(f.packagingError).toBe(italiano.shipping.packaging.errors.categoryStillReferenced);
    });

    prova('categoria senza nome o regola verso una categoria che non esiste: rifiutate', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      await seminaPackaging(request, shop.id, { categories: [{ name: 'Busta', cost: 1 }] });

      const senzaNome = await inviaForm(context, { intent: 'save-category', name: '   ', cost: '1' });
      expect(senzaNome.corpo.error).toBe('shipping.packaging.errors.categoryNameEmpty');

      const regola = await inviaForm(context, { intent: 'save-rule', weightMaxKg: '', category: 'Scatola' });
      expect(regola.corpo.error).toBe('shipping.packaging.errors.ruleInvalidCategory');

      const config = await leggiPackaging(request, shop.id);
      expect(config!.categories).toEqual([{ name: 'Busta', cost: 1 }]);
      expect(config!.fallbackRules).toEqual([]);
      expect(await ricalcoli(request, shop.id)).toBe(0);
    });

    prova('regole: aggiunte in ordine di peso, modificate ed eliminate per posizione', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      await seminaPackaging(request, shop.id, {
        categories: [
          { name: 'Busta', cost: 1 },
          { name: 'Scatola', cost: 3 },
        ],
        fallbackRules: [{ weightMaxKg: null, category: 'Scatola' }],
      });

      const aggiunta = await inviaForm(context, { intent: 'save-rule', weightMaxKg: '1', category: 'Busta' });
      expect(aggiunta.corpo).toEqual({ intent: 'save-rule', success: true });
      expect((await leggiPackaging(request, shop.id))!.fallbackRules).toEqual([
        { weightMaxKg: 1, category: 'Busta' },
        { weightMaxKg: null, category: 'Scatola' },
      ]);

      const seconda = await inviaForm(context, { intent: 'save-rule', weightMaxKg: '', category: 'Busta' });
      expect(seconda.corpo.error).toBe('shipping.packaging.errors.multipleUnlimitedRules');

      const modificata = await inviaForm(context, { intent: 'save-rule', index: '0', weightMaxKg: '2.5', category: 'Busta' });
      expect(modificata.corpo).toEqual({ intent: 'save-rule', success: true });

      const eliminata = await inviaForm(context, { intent: 'delete-rule', index: '1' });
      expect(eliminata.corpo).toEqual({ intent: 'delete-rule', success: true });
      expect((await leggiPackaging(request, shop.id))!.fallbackRules).toEqual([{ weightMaxKg: 2.5, category: 'Busta' }]);

      const fuori = await inviaForm(context, { intent: 'delete-rule', index: '9' });
      expect(fuori.corpo.error).toBe('shipping.packaging.errors.ruleNotFound');
    });

    prova('peso di default e resi: salvati da soli, categorie e regole restano', async ({ request, context }) => {
      const shop = await seminaNegozio(request, { setupCompletedAt: new Date().toISOString() });
      await seminaPackaging(request, shop.id, {
        categories: [{ name: 'Busta', cost: 1 }],
        fallbackRules: [{ weightMaxKg: null, category: 'Busta' }],
      });

      const { corpo } = await inviaForm(context, {
        intent: 'save-packaging-defaults',
        defaultWeightPerItemKg: '0.3',
        returnCost: '6',
      });

      expect(corpo).toEqual({ intent: 'save-packaging-defaults', success: true });
      const config = await leggiPackaging(request, shop.id);
      expect(Number(config!.defaultWeightPerItem)).toBe(0.3);
      expect(Number(config!.returnCost)).toBe(6);
      expect(config!.categories).toEqual([{ name: 'Busta', cost: 1 }]);
      expect(config!.fallbackRules).toEqual([{ weightMaxKg: null, category: 'Busta' }]);
      expect(await ricalcoli(request, shop.id)).toBeGreaterThan(0);

      const ko = await inviaForm(context, { intent: 'save-packaging-defaults', returnCost: '-1' });
      expect(ko.corpo.error).toBe('shipping.packaging.errors.invalidReturnCost');
      expect(cosaVede(ko.corpo).toast).toEqual({
        content: italiano.shipping.packaging.errors.invalidReturnCost,
        error: true,
      });
    });
  });
});
