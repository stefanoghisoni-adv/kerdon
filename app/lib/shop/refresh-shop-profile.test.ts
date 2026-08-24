import { describe, it, expect, vi, beforeEach } from 'vitest';

const shopUpdate = vi.fn();
const getShopInfo = vi.fn();
const getBillingCurrency = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: { shop: { update: (...a: unknown[]) => shopUpdate(...a) } },
}));

vi.mock('~/lib/shopify-api.server', () => ({
  ShopifyAPIClient: Object.assign(vi.fn(() => ({ getShopInfo, getBillingCurrency })), {
    forShop: vi.fn(async () => ({ getShopInfo, getBillingCurrency })),
  }),
}));

import {
  refreshShopProfile,
  triggerShopProfileRefresh,
  clearShopProfileChecks,
} from './refresh-shop-profile.server';

const shop = (over: Record<string, unknown> = {}) => ({
  id: 'shop-1',
  shopDomain: 'negozio.myshopify.com',
  accessToken: 'token',
  ianaTimezone: 'Europe/Rome',
  primaryDomain: 'negozio.myshopify.com',
  billingCurrency: 'EUR',
  shopCurrency: 'EUR',
  ...over,
});

describe('refreshShopProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearShopProfileChecks();
    shopUpdate.mockResolvedValue({});
    // La valuta di fatturazione, di suo, non cambia mai: chi vuole provarla la
    // dichiara nel proprio test.
    getBillingCurrency.mockResolvedValue('EUR');
  });

  it('dominio collegato dopo l’installazione → si aggiorna', () => {
    getShopInfo.mockResolvedValue({ ianaTimezone: 'Europe/Rome', primaryDomain: 'negozio.it', currencyCode: 'EUR' });

    return refreshShopProfile(shop()).then(() => {
      expect(shopUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: { primaryDomain: 'negozio.it' } }),
      );
    });
  });

  it('niente di cambiato → nessuna scrittura', async () => {
    getShopInfo.mockResolvedValue({
      ianaTimezone: 'Europe/Rome',
      primaryDomain: 'negozio.myshopify.com', currencyCode: 'EUR' });

    await refreshShopProfile(shop());

    expect(shopUpdate).not.toHaveBeenCalled();
  });

  it('primo giro: riempie fuso e dominio insieme, con una sola chiamata', async () => {
    getShopInfo.mockResolvedValue({ ianaTimezone: 'Europe/Rome', primaryDomain: 'negozio.it', currencyCode: 'EUR' });

    await refreshShopProfile(shop({ ianaTimezone: null, primaryDomain: null }));

    expect(getShopInfo).toHaveBeenCalledTimes(1);
    expect(shopUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { ianaTimezone: 'Europe/Rome', primaryDomain: 'negozio.it' },
      }),
    );
  });

  it('il fuso gia’ noto non viene riscritto anche se Shopify lo ripete', async () => {
    getShopInfo.mockResolvedValue({ ianaTimezone: 'America/New_York', primaryDomain: 'negozio.it', currencyCode: 'EUR' });

    await refreshShopProfile(shop());

    expect(shopUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { primaryDomain: 'negozio.it' } }),
    );
  });
});

describe('triggerShopProfileRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearShopProfileChecks();
    shopUpdate.mockResolvedValue({});
    getShopInfo.mockResolvedValue({ ianaTimezone: 'Europe/Rome', primaryDomain: 'negozio.it', currencyCode: 'EUR' });
  });

  it('aprire e riaprire l’app non chiama Shopify ogni volta', async () => {
    triggerShopProfileRefresh(shop());
    triggerShopProfileRefresh(shop());
    triggerShopProfileRefresh(shop());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getShopInfo).toHaveBeenCalledTimes(1);
  });

  it('negozi diversi non si bloccano a vicenda', async () => {
    triggerShopProfileRefresh(shop());
    triggerShopProfileRefresh(shop({ id: 'shop-2' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getShopInfo).toHaveBeenCalledTimes(2);
  });
});

describe('valuta di fatturazione', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearShopProfileChecks();
    shopUpdate.mockResolvedValue({});
    getShopInfo.mockResolvedValue({
      ianaTimezone: 'Europe/Rome',
      primaryDomain: 'negozio.myshopify.com', currencyCode: 'EUR' });
  });

  it('il negozio cambia paese: la valuta nuova si registra', async () => {
    getBillingCurrency.mockResolvedValue('USD');

    await refreshShopProfile(shop());

    expect(shopUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { billingCurrency: 'USD' } }),
    );
  });

  it('il negozio cambia paese: la valuta di vendita lo segue', async () => {
    getShopInfo.mockResolvedValue({
      ianaTimezone: 'Europe/Rome',
      primaryDomain: 'negozio.it',
      currencyCode: 'GBP',
    });

    await refreshShopProfile(shop());

    // Non e' la valuta di fatturazione: quella dice come il merchant paga noi,
    // questa come sono scritti i prezzi che finiscono nel feed.
    expect(shopUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ shopCurrency: 'GBP' }) }),
    );
  });

  it("Shopify non risponde: si tiene l'ultima nota, il resto si aggiorna lo stesso", async () => {
    getBillingCurrency.mockRejectedValue(new Error('403'));
    getShopInfo.mockResolvedValue({ ianaTimezone: 'Europe/Rome', primaryDomain: 'negozio.it', currencyCode: 'EUR' });

    await refreshShopProfile(shop());

    expect(shopUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { primaryDomain: 'negozio.it' } }),
    );
  });
});
