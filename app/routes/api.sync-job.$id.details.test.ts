// app/routes/api.sync-job.$id.details.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const findUniqueSyncJob = vi.fn();
const findPlanMock = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'test-shop.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) },
    syncJob: { findUnique: (...a: unknown[]) => findUniqueSyncJob(...a) },
    plan: { findFirst: (...a: unknown[]) => findPlanMock(...a) },
  },
}));

import { loader } from './api.sync-job.$id.details';

const call = (id: string, url = `https://app/api/sync-job/${id}/details`) =>
  loader({ request: new Request(url), params: { id }, context: {} } as any);

describe('/api/sync-job/:id/details', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueShop.mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      currentPlan: 'growth',
  // Le colonne da cui la policy decide: senza, il cancello di `use_app`
    // rifiuterebbe prima ancora che il test cominci — ed e' proprio quello che
    // deve fare a un negozio fermo.
    lifecycleStatus: 'active',
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products,write_products',
    isInTrial: false,
    trialEndsAt: null,
    activeChargeId: null,
    });
    findPlanMock.mockResolvedValue({ customersSyncEnabled: true });
  });

  it('404 se lo shop non esiste', async () => {
    findUniqueShop.mockResolvedValue(null);
    await expect(call('job-1')).rejects.toThrow();
  });

  it('404 se il job non esiste', async () => {
    findUniqueSyncJob.mockResolvedValue(null);
    await expect(call('job-1')).rejects.toThrow();
  });

  it('404 se il job appartiene a un altro shop', async () => {
    findUniqueSyncJob.mockResolvedValue({
      id: 'job-1',
      shopId: 'shop-999', // shop diverso
      productsAdded: 0,
      productsRemoved: 0,
      customersAdded: 0,
      customersUpdated: 0,
      customersSuspended: 0,
      events: [],
    });
    await expect(call('job-1')).rejects.toThrow();
  });

  it('restituisce la forma completa con eventi vuoti', async () => {
    findUniqueSyncJob.mockResolvedValue({
      id: 'job-1',
      shopId: 'shop-1',
      productsAdded: 0,
      productsRemoved: 0,
      customersAdded: 0,
      customersUpdated: 0,
      customersSuspended: 0,
      events: [],
    });

    const res = await call('job-1');
    const data = await res.json();

    expect(data).toMatchObject({
      products: {
        rows: [],
        added: 0,
        removed: 0,
        truncated: false,
      },
      customers: {
        added: 0,
        updated: 0,
        suspended: 0,
      },
      customersEnabled: true,
    });
  });

  it('serializza i BigInt come stringa', async () => {
    findUniqueSyncJob.mockResolvedValue({
      id: 'job-1',
      shopId: 'shop-1',
      productsAdded: 1,
      productsRemoved: 0,
      customersAdded: 0,
      customersUpdated: 0,
      customersSuspended: 0,
      events: [
        {
          id: 'evt-1',
          entity: 'product',
          action: 'added',
          label: 'Prodotto Test',
          sublabel: 'Variante Test',
          shopifyId: BigInt('9876543210'),
          variantId: BigInt('1234567890'),
          createdAt: new Date(),
        },
      ],
    });

    const res = await call('job-1');
    const data = await res.json();

    expect(data.products.rows[0]).toMatchObject({
      id: 'evt-1',
      action: 'added',
      label: 'Prodotto Test',
      sublabel: 'Variante Test',
      shopifyId: '9876543210',
      variantId: '1234567890',
    });
    // Verifica che sia stringa, non numero
    expect(typeof data.products.rows[0].shopifyId).toBe('string');
    expect(typeof data.products.rows[0].variantId).toBe('string');
  });

  it('calcola truncated correttamente per i prodotti', async () => {
    // 2 eventi ma contatori che dicono 10 added + 5 removed = 15 totali
    findUniqueSyncJob.mockResolvedValue({
      id: 'job-1',
      shopId: 'shop-1',
      productsAdded: 10,
      productsRemoved: 5,
      customersAdded: 0,
      customersUpdated: 0,
      customersSuspended: 0,
      events: [
        {
          id: 'evt-1',
          entity: 'product',
          action: 'added',
          label: 'Prodotto 1',
          sublabel: null,
          shopifyId: BigInt('1'),
          variantId: null,
          createdAt: new Date(),
        },
        {
          id: 'evt-2',
          entity: 'product',
          action: 'removed',
          label: 'Prodotto 2',
          sublabel: null,
          shopifyId: BigInt('2'),
          variantId: null,
          createdAt: new Date(),
        },
      ],
    });

    const res = await call('job-1');
    const data = await res.json();

    expect(data.products.truncated).toBe(true);
    expect(data.products.rows.length).toBe(2);
    expect(data.products.added).toBe(10);
    expect(data.products.removed).toBe(5);
  });

  it('dei clienti restituisce i totali e nessun elenco', async () => {
    // Il dettaglio per singolo cliente non viene registrato: qui si verifica che
    // nemmeno una riga rimasta da prima possa uscire dall'endpoint.
    findUniqueSyncJob.mockResolvedValue({
      id: 'job-1',
      shopId: 'shop-1',
      productsAdded: 0,
      productsRemoved: 0,
      customersAdded: 3,
      customersUpdated: 2,
      customersSuspended: 1,
      events: [
        {
          id: 'evt-1',
          entity: 'customer',
          action: 'added',
          label: 'Mario Rossi',
          sublabel: null,
          shopifyId: BigInt('100'),
          variantId: null,
          createdAt: new Date(),
        },
      ],
    });

    const res = await call('job-1');
    const data = await res.json();

    expect(data.customers).toEqual({ added: 3, updated: 2, suspended: 1 });
  });

  it('customersEnabled false quando il piano non ha la sync clienti', async () => {
    findPlanMock.mockResolvedValue({ customersSyncEnabled: false });
    findUniqueSyncJob.mockResolvedValue({
      id: 'job-1',
      shopId: 'shop-1',
      productsAdded: 0,
      productsRemoved: 0,
      customersAdded: 0,
      customersUpdated: 0,
      customersSuspended: 0,
      events: [],
    });

    const res = await call('job-1');
    const data = await res.json();

    expect(data.customersEnabled).toBe(false);
  });

  it('tiene solo gli eventi prodotto, mai quelli sui clienti', async () => {
    findUniqueSyncJob.mockResolvedValue({
      id: 'job-1',
      shopId: 'shop-1',
      productsAdded: 2,
      productsRemoved: 1,
      customersAdded: 1,
      customersUpdated: 1,
      customersSuspended: 0,
      events: [
        {
          id: 'evt-p1',
          entity: 'product',
          action: 'added',
          label: 'Prodotto A',
          sublabel: null,
          shopifyId: BigInt('1'),
          variantId: null,
          createdAt: new Date('2024-01-01'),
        },
        {
          id: 'evt-c1',
          entity: 'customer',
          action: 'added',
          label: 'Cliente A',
          sublabel: null,
          shopifyId: BigInt('100'),
          variantId: null,
          createdAt: new Date('2024-01-02'),
        },
        {
          id: 'evt-p2',
          entity: 'product',
          action: 'removed',
          label: 'Prodotto B',
          sublabel: null,
          shopifyId: BigInt('2'),
          variantId: null,
          createdAt: new Date('2024-01-03'),
        },
        {
          id: 'evt-c2',
          entity: 'customer',
          action: 'updated',
          label: 'Cliente B',
          sublabel: null,
          shopifyId: BigInt('200'),
          variantId: null,
          createdAt: new Date('2024-01-04'),
        },
        {
          id: 'evt-p3',
          entity: 'product',
          action: 'added',
          label: 'Prodotto C',
          sublabel: null,
          shopifyId: BigInt('3'),
          variantId: null,
          createdAt: new Date('2024-01-05'),
        },
      ],
    });

    const res = await call('job-1');
    const data = await res.json();

    // Prodotti: 3 eventi (2 added, 1 removed)
    expect(data.products.rows).toHaveLength(3);
    expect(data.products.rows.map((r) => r.id)).toEqual(['evt-p1', 'evt-p2', 'evt-p3']);

    // Clienti: solo i contatori, nessuna riga
    expect(data.customers).toEqual({ added: 1, updated: 1, suspended: 0 });
  });

  it('gestisce shopifyId e variantId null', async () => {
    findUniqueSyncJob.mockResolvedValue({
      id: 'job-1',
      shopId: 'shop-1',
      productsAdded: 1,
      productsRemoved: 0,
      customersAdded: 0,
      customersUpdated: 0,
      customersSuspended: 0,
      events: [
        {
          id: 'evt-1',
          entity: 'product',
          action: 'added',
          label: 'Prodotto senza ID',
          sublabel: null,
          shopifyId: null,
          variantId: null,
          createdAt: new Date(),
        },
      ],
    });

    const res = await call('job-1');
    const data = await res.json();

    expect(data.products.rows[0].shopifyId).toBe(null);
    expect(data.products.rows[0].variantId).toBe(null);
  });
});
