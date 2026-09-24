// app/lib/shipping/weight-alert.server.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const packagingConfigFindUnique = vi.fn();
const shippingAlertDismissalFindUnique = vi.fn();
const shippingAlertDismissalUpsert = vi.fn();
const shopFindUnique = vi.fn();
const runQueryRows = vi.fn();
const getValidAccessToken = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    packagingConfig: { findUnique: packagingConfigFindUnique },
    shippingAlertDismissal: {
      findUnique: shippingAlertDismissalFindUnique,
      upsert: shippingAlertDismissalUpsert,
    },
    shop: { findUnique: shopFindUnique },
  },
}));

vi.mock('~/lib/supabase-management.server', () => ({
  runQueryRows,
}));

vi.mock('~/lib/supabase-oauth.server', () => ({
  getValidAccessToken,
}));

const { shouldShowWeightAlert } = await import('./weight-alert.server');

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  // Setup predefiniti comuni
  shopFindUnique.mockResolvedValue({
    id: 'test-shop-id',
    supabaseConfig: {
      connectionVerifiedAt: new Date(),
      supabaseProjectRef: 'test-ref',
    },
  });
  getValidAccessToken.mockResolvedValue('test-token');
});

describe('shouldShowWeightAlert', () => {
  it('non mostra alert se defaultWeightPerItem è configurato', async () => {
    packagingConfigFindUnique.mockResolvedValue({
      shopId: 'test-shop',
      categories: [],
      fallbackRules: [],
      defaultWeightPerItem: new Prisma.Decimal(0.5),
      returnCost: null,
      updatedAt: new Date(),
    });

    const result = await shouldShowWeightAlert('test-shop', 'test.myshopify.com');

    expect(result).toEqual({ show: false, count: 0 });
    expect(runQueryRows).not.toHaveBeenCalled();
  });

  it('mostra alert se ci sono ordini senza peso e non è stato chiuso', async () => {
    packagingConfigFindUnique.mockResolvedValue({
      shopId: 'test-shop',
      categories: [],
      fallbackRules: [],
      defaultWeightPerItem: null,
      returnCost: null,
      updatedAt: new Date(),
    });

    shippingAlertDismissalFindUnique.mockResolvedValue(null);

    runQueryRows.mockResolvedValue([{ count: '15' }]);

    const result = await shouldShowWeightAlert('test-shop', 'test.myshopify.com');

    expect(result).toEqual({ show: true, count: 15 });
  });

  it('non mostra alert se è stato chiuso', async () => {
    packagingConfigFindUnique.mockResolvedValue({
      shopId: 'test-shop',
      categories: [],
      fallbackRules: [],
      defaultWeightPerItem: null,
      returnCost: null,
      updatedAt: new Date(),
    });

    shippingAlertDismissalFindUnique.mockResolvedValue({
      shopId: 'test-shop',
      dismissedAt: new Date(),
    });

    const result = await shouldShowWeightAlert('test-shop', 'test.myshopify.com');

    expect(result).toEqual({ show: false, count: 0 });
    expect(runQueryRows).not.toHaveBeenCalled();
  });

  it('non mostra alert se la query del DB merchant fallisce', async () => {
    packagingConfigFindUnique.mockResolvedValue({
      shopId: 'test-shop',
      categories: [],
      fallbackRules: [],
      defaultWeightPerItem: null,
      returnCost: null,
      updatedAt: new Date(),
    });

    shippingAlertDismissalFindUnique.mockResolvedValue(null);

    runQueryRows.mockRejectedValue(new Error('Database error'));

    const result = await shouldShowWeightAlert('test-shop', 'test.myshopify.com');

    expect(result).toEqual({ show: false, count: 0 });
  });

  it('non mostra alert se la tabella dismissal non esiste (P2021)', async () => {
    packagingConfigFindUnique.mockResolvedValue({
      shopId: 'test-shop',
      categories: [],
      fallbackRules: [],
      defaultWeightPerItem: null,
      returnCost: null,
      updatedAt: new Date(),
    });

    const error = new Prisma.PrismaClientKnownRequestError('table does not exist', {
      code: 'P2021',
      clientVersion: 'test',
    });
    shippingAlertDismissalFindUnique.mockRejectedValue(error);

    runQueryRows.mockResolvedValue([{ count: '0' }]);

    const result = await shouldShowWeightAlert('test-shop', 'test.myshopify.com');

    // Tabella assente → come se fosse chiuso
    expect(result).toEqual({ show: false, count: 0 });
  });

  it('conta correttamente ordini spediti con peso NULL o 0', async () => {
    packagingConfigFindUnique.mockResolvedValue({
      shopId: 'test-shop',
      categories: [],
      fallbackRules: [],
      defaultWeightPerItem: null,
      returnCost: null,
      updatedAt: new Date(),
    });

    shippingAlertDismissalFindUnique.mockResolvedValue(null);

    runQueryRows.mockResolvedValue([{ count: '42' }]);

    const result = await shouldShowWeightAlert('test-shop', 'test.myshopify.com');

    expect(result).toEqual({ show: true, count: 42 });

    // Verifica che la query SQL sia corretta
    const queryCall = runQueryRows.mock.calls[0];
    expect(queryCall[2]).toContain('fulfillment_status');
    expect(queryCall[2]).toContain('FULFILLED');
    expect(queryCall[2]).toContain('PARTIALLY_FULFILLED');
    expect(queryCall[2]).toContain('total_weight_grams');
    expect(queryCall[2]).toContain('cancelled_at IS NULL');
  });

  it('non mostra alert se il database non è collegato', async () => {
    packagingConfigFindUnique.mockResolvedValue({
      shopId: 'test-shop',
      categories: [],
      fallbackRules: [],
      defaultWeightPerItem: null,
      returnCost: null,
      updatedAt: new Date(),
    });

    shippingAlertDismissalFindUnique.mockResolvedValue(null);

    shopFindUnique.mockResolvedValue({
      id: 'test-shop-id',
      supabaseConfig: null,
    });

    const result = await shouldShowWeightAlert('test-shop', 'test.myshopify.com');

    expect(result).toEqual({ show: false, count: 0 });
    expect(runQueryRows).not.toHaveBeenCalled();
  });
});
