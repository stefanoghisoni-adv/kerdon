import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const updateShop = vi.fn();
const queueCapCatchUp = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      findUnique: (...a: unknown[]) => findUniqueShop(...a),
      update: (...a: unknown[]) => updateShop(...a),
    },
  },
}));

// Il recupero ha le sue prove (cap-catch-up.server.test.ts): qui si guarda solo
// che il cambio di piano lo chiami, e con che cosa.
vi.mock('./cap-catch-up.server', () => ({
  queueCapCatchUp: (...a: unknown[]) => queueCapCatchUp(...a),
}));

import { applyPlanToShop, appSubscriptionGid } from './apply-plan.server';

const NOW = new Date('2026-08-04T10:00:00.000Z');

/** I campi scritti sullo shop dall'ultima chiamata. */
function writtenData(): Record<string, unknown> {
  return updateShop.mock.calls.at(-1)?.[0]?.data ?? {};
}

describe('appSubscriptionGid', () => {
  it('ricompone il gid da un id numerico', () => {
    expect(appSubscriptionGid('1234')).toBe('gid://shopify/AppSubscription/1234');
    expect(appSubscriptionGid(1234n)).toBe('gid://shopify/AppSubscription/1234');
  });
});

describe('applyPlanToShop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueShop.mockResolvedValue({
      currentPlan: 'Basic',
      authorization: 'ENABLED',
      trackingAuthorization: 'ENABLED',
    });
    queueCapCatchUp.mockResolvedValue({ status: 'not_raised', products: false, customers: false });
  });

  it('piano a pagamento senza prova: nessun trial e addebito collegato', async () => {
    await applyPlanToShop({
      shopId: 'shop-1',
      planName: 'Growth',
      chargeId: '1234',
      trialDays: 0,
      now: NOW,
    });

    expect(updateShop).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'shop-1' } }),
    );
    expect(writtenData()).toMatchObject({
      currentPlan: 'Growth',
      activeChargeId: '1234',
      billingCycle: 'monthly',
      isInTrial: false,
      trialEndsAt: null,
      planStartedAt: NOW,
    });
  });

  it('con giorni di prova calcola la scadenza dal momento indicato', async () => {
    await applyPlanToShop({
      shopId: 'shop-1',
      planName: 'Growth',
      chargeId: '1234',
      trialDays: 7,
      now: NOW,
    });

    const data = writtenData();
    expect(data.isInTrial).toBe(true);
    expect((data.trialEndsAt as Date).toISOString()).toBe('2026-08-11T10:00:00.000Z');
  });

  it('piano gratuito: nessun addebito collegato e nessuna riattivazione', async () => {
    findUniqueShop.mockResolvedValue({
      currentPlan: 'Growth',
      authorization: 'PENDING',
      trackingAuthorization: 'PENDING',
    });
    await applyPlanToShop({ shopId: 'shop-1', planName: 'Basic', chargeId: null, now: NOW });

    expect(writtenData()).toMatchObject({ currentPlan: 'Basic', activeChargeId: null });
    expect(writtenData()).not.toHaveProperty('authorization');
  });

  it('riattiva il negozio sospeso per prova scaduta quando il piano e a pagamento', async () => {
    findUniqueShop.mockResolvedValue({
      authorization: 'PENDING',
      trackingAuthorization: 'PENDING',
    });

    await applyPlanToShop({ shopId: 'shop-1', planName: 'Growth', chargeId: '1234', now: NOW });

    expect(writtenData()).toMatchObject({
      authorization: 'ENABLED',
      trackingAuthorization: 'ENABLED',
    });
  });

  it('non sblocca un negozio disabilitato dall owner', async () => {
    findUniqueShop.mockResolvedValue({
      authorization: 'DISABLED',
      trackingAuthorization: 'DISABLED',
    });

    await applyPlanToShop({ shopId: 'shop-1', planName: 'Growth', chargeId: '1234', now: NOW });

    expect(writtenData()).not.toHaveProperty('authorization');
    expect(writtenData()).not.toHaveProperty('trackingAuthorization');
  });

  it('la cadenza arriva da chi ha in mano l abbonamento, non da una costante', async () => {
    // Era fissa su 'monthly': un abbonamento annuale finiva registrato come
    // mensile sulla colonna da cui si racconta il piano al merchant.
    await applyPlanToShop({
      shopId: 'shop-1',
      planName: 'Growth',
      chargeId: '1234',
      billingCycle: 'yearly',
      now: NOW,
    });

    expect(writtenData()).toMatchObject({ billingCycle: 'yearly' });
  });

  it('senza cadenza indicata resta mensile, che e il caso comune', async () => {
    // Il webhook di stato porta solo il nome del piano: non ha una cadenza da
    // dichiarare, e non deve inventarsene una.
    await applyPlanToShop({ shopId: 'shop-1', planName: 'Growth', chargeId: '1234', now: NOW });
    expect(writtenData()).toMatchObject({ billingCycle: 'monthly' });
  });

  it('non tocca lastSyncedPlan: e il confronto che innesca il recupero', async () => {
    await applyPlanToShop({ shopId: 'shop-1', planName: 'Growth', chargeId: '1234', now: NOW });
    expect(writtenData()).not.toHaveProperty('lastSyncedPlan');
  });

  it('dopo la scrittura chiede il recupero, con il piano di prima e quello nuovo', async () => {
    await applyPlanToShop({ shopId: 'shop-1', planName: 'Growth', chargeId: '1234', now: NOW });

    expect(queueCapCatchUp).toHaveBeenCalledTimes(1);
    expect(queueCapCatchUp).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: 'shop-1',
        previousPlanName: 'Basic',
        nextPlanName: 'Growth',
        now: NOW,
      }),
    );
    // Dopo, non prima: il recupero rilegge il negozio come e' appena diventato.
    expect(updateShop.mock.invocationCallOrder[0]).toBeLessThan(
      queueCapCatchUp.mock.invocationCallOrder[0],
    );
  });

  it('il recupero legge con lo stesso client della scrittura', async () => {
    const tx = {
      shop: {
        findUnique: (...a: unknown[]) => findUniqueShop(...a),
        update: (...a: unknown[]) => updateShop(...a),
      },
    };
    await applyPlanToShop({
      shopId: 'shop-1',
      planName: 'Growth',
      chargeId: '1234',
      now: NOW,
      tx: tx as never,
    });

    expect(queueCapCatchUp.mock.calls[0][0].db).toBe(tx);
  });

  it('anche il piano gratuito passa dal recupero: e il recupero a dire che non sale', async () => {
    findUniqueShop.mockResolvedValue({
      currentPlan: 'Growth',
      authorization: 'ENABLED',
      trackingAuthorization: 'ENABLED',
    });
    await applyPlanToShop({ shopId: 'shop-1', planName: 'Basic', chargeId: null, now: NOW });

    expect(queueCapCatchUp).toHaveBeenCalledWith(
      expect.objectContaining({ previousPlanName: 'Growth', nextPlanName: 'Basic' }),
    );
  });
});
