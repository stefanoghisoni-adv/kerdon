// app/routes/customers.loader.test.ts
//
// Test del loader della pagina Clienti: verifica che il campo integrations sia
// null quando il piano non include la sincronizzazione clienti, e presente quando
// il piano lo include.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const findPlanByName = vi.fn();
const findManyPlan = vi.fn();
const findManyPlanPrice = vi.fn();
const startCustomersPageData = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: 'test-shop.myshopify.com' },
    }),
  },
}));

vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      findUnique: (...args: unknown[]) => findUniqueShop(...args),
    },
    plan: {
      findMany: (...args: unknown[]) => findManyPlan(...args),
    },
    planPrice: {
      findMany: (...args: unknown[]) => findManyPlanPrice(...args),
    },
  },
}));

vi.mock('~/lib/billing/find-plan.server', () => ({
  findPlanByName: (...args: unknown[]) => findPlanByName(...args),
}));

vi.mock('~/lib/customers/page-data.server', () => ({
  startCustomersPageData: (...args: unknown[]) => startCustomersPageData(...args),
}));

vi.mock('~/lib/setup/require-setup.server', () => ({
  requireSetupComplete: async () => undefined,
}));

vi.mock('~/lib/authz/require-capability.server', () => ({
  requireShopCapability: async () => ({
    session: { shop: 'test-shop.myshopify.com' },
    shop: {
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      currentPlan: 'basic',
      ianaTimezone: 'Europe/Rome',
    },
  }),
}));

vi.mock('~/utils/admin-page', () => ({
  storeHandle: (shop: string) => shop.replace('.myshopify.com', ''),
}));

import { loader } from './customers';

describe('customers loader - campo integrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueShop.mockResolvedValue({
      id: 'shop-1',
      shopDomain: 'test-shop.myshopify.com',
      currentPlan: 'basic',
      ianaTimezone: 'Europe/Rome',
    });
    findManyPlan.mockResolvedValue([]);
    findManyPlanPrice.mockResolvedValue([]);
  });

  it('piano senza clienti: integrations null (startCustomersPageData non chiamato)', async () => {
    findPlanByName.mockResolvedValue({
      planName: 'basic',
      customersSyncEnabled: false,
    });

    const request = new Request('http://localhost/customers');
    const result = await loader({ request, params: {}, context: {} } as never);

    // defer() restituisce un oggetto con la proprietà data accessibile
    const loaderData = (result as any).data;

    // startCustomersPageData NON chiamato quando customersIncluded = false
    expect(startCustomersPageData).not.toHaveBeenCalled();

    // data.data è sincrono (non una Promise) quando !customersIncluded
    expect(loaderData.data).toBeDefined();
    expect(loaderData.data).not.toBeInstanceOf(Promise);

    // integrations deve essere null
    expect(loaderData.data.integrations).toBe(null);
  });

  it('piano con clienti: integrations presente (fetchato via startCustomersPageData)', async () => {
    findPlanByName.mockResolvedValue({
      planName: 'growth',
      customersSyncEnabled: true,
    });

    startCustomersPageData.mockResolvedValue({
      report: { rows: [], currency: 'EUR', lifetimeCustomers: 0, unavailable: null },
      birthdate: null,
      integrations: [
        {
          provider: 'klaviyo',
          status: 'not_connected',
          accountName: null,
          mapping: null,
          lastRun: null,
          openConflicts: 0,
        },
      ],
    });

    const request = new Request('http://localhost/customers');
    const result = await loader({ request, params: {}, context: {} } as never);

    // defer() restituisce un oggetto con la proprietà data accessibile
    const loaderData = (result as any).data;

    // startCustomersPageData chiamato con i parametri giusti
    expect(startCustomersPageData).toHaveBeenCalledWith(
      expect.objectContaining({
        shopDomain: 'test-shop.myshopify.com',
        shop: expect.objectContaining({ id: 'shop-1' }),
      }),
    );

    // data.data è una Promise quando customersIncluded = true (deferred)
    expect(loaderData.data).toBeInstanceOf(Promise);

    // Resolve della Promise per verificare che integrations sia presente
    const pageData = await loaderData.data;
    expect(pageData).toHaveProperty('integrations');
    expect(Array.isArray(pageData.integrations)).toBe(true);
    expect(pageData.integrations).toHaveLength(1);
    expect(pageData.integrations[0]).toMatchObject({
      provider: 'klaviyo',
      status: 'not_connected',
    });
  });
});
