import { describe, it, expect, vi, beforeEach } from 'vitest';

// La promessa che questi test tengono ferma: il costo appena inserito non
// finisce MAI sulle righe d'ordine gia' scritte spacciato per il costo di
// allora. Shopify conserva solo il costo attuale, quello del giorno della
// vendita non esiste da nessuna parte, e riempirlo sarebbe il modo piu' comodo
// di far quadrare i conti raccontando una cosa falsa.

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: vi.fn(async () => ({ session: { shop: 'test.myshopify.com' } })) },
}));

vi.mock('~/db.server', () => ({
  prisma: { shop: { findUnique: vi.fn() } },
}));

vi.mock('~/lib/authz/shop-capabilities.server', () => ({
  shopCapabilities: vi.fn(async () => ({})),
}));

vi.mock('~/lib/authz/capabilities', () => ({
  can: vi.fn(() => true),
  denialOf: vi.fn(() => null),
}));

vi.mock('~/lib/i18n/server', () => ({
  dictionaryForShop: vi.fn(async () => ({
    errors: {
      suspended: 'sospeso',
      costInvalid: 'costo non valido',
      costWriteFailed: 'scrittura fallita',
      costWritePermission: 'permesso mancante',
      costHalfSaved: 'salvato a meta',
      costScopeMissing: 'scelta mancante',
      variantInvalid: 'variante non valida',
      recheckFailed: 'ricontrollo fallito',
      productsFetchFailed: 'lettura fallita',
    },
  })),
}));

vi.mock('~/lib/shopify-api.server', () => {
  const ctor = vi.fn();
  return {
    ShopifyAPIClient: Object.assign(ctor, {
      forShop: vi.fn(async () => ({ updateInventoryItemCost: vi.fn(async () => ({})) })),
    }),
  };
});

vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn() }));

vi.mock('~/lib/stats/inventory-cost.server', () => ({
  enrichVariantCosts: vi.fn(async () => undefined),
  getMissingCostInventoryIds: vi.fn(async () => []),
}));

vi.mock('~/lib/cache/stats-cache.server', () => ({
  getReadinessCache: vi.fn(async () => null),
  setReadinessCache: vi.fn(async () => undefined),
}));

vi.mock('~/lib/setup/require-setup.server', () => ({
  requireSetupComplete: vi.fn(async () => undefined),
}));

import { action } from './products.issues';
import { prisma } from '~/db.server';
import { createSupabaseClient } from '~/lib/supabase.server';

/** Le scritture arrivate su ogni tabella, con la condizione che le accompagna. */
interface Scrittura {
  table: string;
  values: Record<string, unknown>;
  eq?: unknown[];
  isNull?: string[];
}

function supabaseFinto(costoPrecedente: unknown) {
  const scritture: Scrittura[] = [];

  (createSupabaseClient as any).mockReturnValue({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { price: 30, cost_per_item: costoPrecedente },
            error: null,
          }),
        }),
      }),
      update: (values: Record<string, unknown>) => {
        const scrittura: Scrittura = { table, values };
        scritture.push(scrittura);
        const chain = {
          eq: (...args: unknown[]) => {
            scrittura.eq = args;
            return Object.assign(Promise.resolve({ error: null }), {
              is: async (column: string) => {
                scrittura.isNull = [column];
                return { error: null };
              },
            });
          },
        };
        return chain;
      },
    }),
  });

  return scritture;
}

function richiesta(body: unknown) {
  return new Request('https://app/products/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const AGGIORNAMENTO = {
  intent: 'recheck',
  inventoryItemIds: [77],
  updates: [{ variantId: 5, inventoryItemId: 77, cost: '9.00' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.shop.findUnique as any).mockResolvedValue({
    id: 'shop-1',
    shopDomain: 'test.myshopify.com',
    uninstalledAt: null,
    authorization: 'ENABLED',
    currentPlan: 'growth',
    supabaseConfig: {
      connectionVerifiedAt: new Date(),
      tableNameProducts: 'products',
    },
  });
});

describe('fin dove arriva la modifica di un costo', () => {
  it('senza una scelta non si scrive niente: non si decide al posto del merchant', async () => {
    const scritture = supabaseFinto(null);

    const res = await action({ request: richiesta(AGGIORNAMENTO) } as any);

    expect(res.status).toBe(400);
    expect(scritture).toEqual([]);
  });

  it('da adesso in avanti: le righe gia scritte chiudono il conto sul costo di PRIMA', async () => {
    // Il costo di prima era 4: e' quello con cui gli ordini gia' registrati
    // sono stati calcolati finora, ed e' l'unico che si possa fissare senza
    // inventare niente.
    const scritture = supabaseFinto(4);

    await action({ request: richiesta({ ...AGGIORNAMENTO, costScope: 'future' }) } as any);

    const righeOrdine = scritture.filter((s) => s.table === 'order_lines');
    expect(righeOrdine).toHaveLength(1);
    expect(righeOrdine[0].values.unit_cost_at_sale).toBe(4);
    expect(righeOrdine[0].values.unit_cost_frozen_at).toEqual(expect.any(String));
    // Il costo NUOVO non compare da nessuna parte fra le righe vecchie.
    expect(righeOrdine[0].values.unit_cost_at_sale).not.toBe(9);
    // E solo le righe non ancora fissate: una gia' chiusa porta il costo di
    // allora, e riscriverla le sposterebbe il passato a ogni correzione.
    expect(righeOrdine[0].isNull).toEqual(['unit_cost_frozen_at']);
  });

  // IL BUG, ed e' il caso normale di questa tab: qui il costo si inserisce la
  // prima volta, quindi un costo precedente non c'e'. Congelarne l'assenza
  // lasciava la riga senza valore ma con la data del congelamento sopra —
  // "conto chiuso" per il calcolo del profitto — e nessun costo inserito dopo
  // poteva piu' farla rientrare: il merchant compilava il costo che l'app gli
  // chiedeva e ritrovava profitto zero, per sempre.
  //
  // Niente da proteggere, niente da scrivere: le righe restano libere di
  // seguire il costo di listino, che un istante dopo e' quello appena inserito.
  it('se un costo prima non c era, sulle righe d ordine non si scrive niente', async () => {
    const scritture = supabaseFinto(null);

    await action({ request: richiesta({ ...AGGIORNAMENTO, costScope: 'future' }) } as any);

    expect(scritture.filter((s) => s.table === 'order_lines')).toEqual([]);
  });

  it('e il costo nuovo arriva lo stesso sul prodotto, che e cio che quelle righe seguono', async () => {
    const scritture = supabaseFinto(null);

    await action({ request: richiesta({ ...AGGIORNAMENTO, costScope: 'future' }) } as any);

    const prodotti = scritture.filter((s) => s.table === 'products');
    expect(prodotti).toHaveLength(1);
    expect(prodotti[0].values.cost_per_item).toBe(9);
  });

  // L'altra meta' del fix: dove un costo precedente c'e' DAVVERO, congelare
  // resta la cosa giusta. E' il caso per cui la scelta esiste — ho comprato a
  // 4, adesso compro a 9, le vendite di prima restano a 4 — e non deve essere
  // sacrificato per sistemare quello di sopra.
  it('con un costo precedente vero il congelamento resta, anche a zero', async () => {
    const scritture = supabaseFinto(0);

    await action({ request: richiesta({ ...AGGIORNAMENTO, costScope: 'future' }) } as any);

    const righeOrdine = scritture.filter((s) => s.table === 'order_lines');
    expect(righeOrdine).toHaveLength(1);
    expect(righeOrdine[0].values.unit_cost_at_sale).toBe(0);
    expect(righeOrdine[0].values.unit_cost_frozen_at).toEqual(expect.any(String));
  });

  it('tutti: il conto si riapre e lo storico torna a seguire il costo corrente', async () => {
    const scritture = supabaseFinto(4);

    await action({ request: richiesta({ ...AGGIORNAMENTO, costScope: 'all' }) } as any);

    const righeOrdine = scritture.filter((s) => s.table === 'order_lines');
    expect(righeOrdine).toHaveLength(1);
    expect(righeOrdine[0].values).toEqual({
      unit_cost_at_sale: null,
      unit_cost_frozen_at: null,
    });
    // Nessuna restrizione sulle righe gia' fissate: e' proprio quello che il
    // merchant sta chiedendo di annullare.
    expect(righeOrdine[0].isNull).toBeUndefined();
  });

  it('in tutti e due i casi il prodotto prende comunque il costo nuovo', async () => {
    const scritture = supabaseFinto(4);

    await action({ request: richiesta({ ...AGGIORNAMENTO, costScope: 'future' }) } as any);

    const prodotti = scritture.filter((s) => s.table === 'products');
    expect(prodotti).toHaveLength(1);
    expect(prodotti[0].values.cost_per_item).toBe(9);
    // Prezzo 30 meno costo 9.
    expect(prodotti[0].values.net_value).toBe(21);
  });
});
