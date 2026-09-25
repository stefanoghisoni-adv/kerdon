import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/lib/billing/apply-plan.server', () => ({ applyPlanToShop: vi.fn() }));
// Le due ricerche di piano restano distinte di proposito: il piano
// dell'abbonamento passa da findPlanByName (confronto per nome, insensibile a
// maiuscole), quello gratuito da una query per prezzo. Mockarle insieme
// renderebbe impossibile distinguerle.
vi.mock('~/lib/billing/find-plan.server', () => ({
  findPlanByName: vi.fn(),
  findFreePlan: vi.fn(),
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: vi.fn() },
    billingCharge: { updateMany: vi.fn() },
    webhookEvent: { updateMany: vi.fn() },
  },
}));

import { handleSubscriptionUpdate } from './handle-subscription-update.server';
import { applyPlanToShop } from '~/lib/billing/apply-plan.server';
import { findFreePlan, findPlanByName } from '~/lib/billing/find-plan.server';
import { prisma } from '~/db.server';
import type { ClaimedWebhookEvent } from './inbox.server';

const DOMINIO = 'negozio.myshopify.com';
const ORA = new Date('2026-09-05T12:00:00.000Z');

function evento(payload: unknown): ClaimedWebhookEvent {
  return {
    id: 'evento-1',
    topic: 'app_subscriptions/update',
    shopDomain: DOMINIO,
    payload,
    attempts: 1,
  };
}

function abbonamento(status: string, over: Record<string, unknown> = {}) {
  return {
    app_subscription: {
      admin_graphql_api_id: 'gid://shopify/AppSubscription/123',
      name: 'growth',
      status,
      ...over,
    },
  };
}

function negozio(over: Record<string, unknown> = {}) {
  return {
    id: 'shop-1',
    shopDomain: DOMINIO,
    currentPlan: 'growth',
    activeChargeId: '123',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.webhookEvent.updateMany as never as ReturnType<typeof vi.fn>).mockResolvedValue({
    count: 1,
  });
  (prisma.billingCharge.updateMany as never as ReturnType<typeof vi.fn>).mockResolvedValue({
    count: 1,
  });
});

describe('cosa si chiude senza fare niente', () => {
  it('negozio sconosciuto → concluso, non fallito', async () => {
    (prisma.shop.findUnique as never as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    expect(await handleSubscriptionUpdate(evento(abbonamento('ACTIVE')), ORA)).toBe('done');
    expect(applyPlanToShop).not.toHaveBeenCalled();
  });

  it('stato transitorio (PENDING) → concluso: arrivera un altra consegna', async () => {
    (prisma.shop.findUnique as never as ReturnType<typeof vi.fn>).mockResolvedValue(negozio());

    expect(await handleSubscriptionUpdate(evento(abbonamento('PENDING')), ORA)).toBe('done');
    expect(applyPlanToShop).not.toHaveBeenCalled();
  });

  it('corpo senza i campi minimi → lettera morta, non cinque ritentativi', async () => {
    // Lo stesso corpo darebbe lo stesso esito per cinque giri, e l'unica cosa
    // che cambierebbe sarebbe il momento in cui qualcuno se ne accorge.
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await handleSubscriptionUpdate(evento({ app_subscription: {} }), ORA)).toBe(
      'dead_letter',
    );
    allarme.mockRestore();
  });
});

describe('un abbonamento attivo', () => {
  beforeEach(() => {
    (prisma.shop.findUnique as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      negozio({ currentPlan: 'basic', activeChargeId: null }),
    );
    (findPlanByName as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      planName: 'Growth',
      trialDays: 14,
    });
  });

  it('porta il negozio sul piano, e segna l addebito', async () => {
    expect(await handleSubscriptionUpdate(evento(abbonamento('ACTIVE')), ORA)).toBe('done');

    expect(applyPlanToShop).toHaveBeenCalledWith(
      expect.objectContaining({ shopId: 'shop-1', planName: 'Growth', chargeId: '123' }),
    );
    expect(prisma.billingCharge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'active' }) }),
    );
  });

  it('gia allineato → non riscrive, cosi la prova non riparte da capo', async () => {
    // Shopify puo' rimandare lo stesso ACTIVE piu' volte: riapplicare il piano
    // ricalcolerebbe `trialEndsAt` da adesso, regalando giorni gratis a ogni
    // consegna ripetuta.
    (prisma.shop.findUnique as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      negozio({ currentPlan: 'Growth', activeChargeId: '123' }),
    );

    expect(await handleSubscriptionUpdate(evento(abbonamento('ACTIVE')), ORA)).toBe('done');
    expect(applyPlanToShop).not.toHaveBeenCalled();
  });

  it('abbonamento gia attivo col nome di prima ("Core" da 29) → non riscrive e non promuove', async () => {
    (prisma.shop.findUnique as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      negozio({ currentPlan: 'Growth', activeChargeId: '123' }),
    );

    expect(
      await handleSubscriptionUpdate(evento(abbonamento('ACTIVE', { name: 'Core' })), ORA),
    ).toBe('done');
    expect(findPlanByName).not.toHaveBeenCalled();
    expect(applyPlanToShop).not.toHaveBeenCalled();
  });

  it('abbonamento nuovo col nome di prima → cercato col nome di oggi', async () => {
    expect(
      await handleSubscriptionUpdate(evento(abbonamento('ACTIVE', { name: 'Enterprise' })), ORA),
    ).toBe('done');
    expect(findPlanByName).toHaveBeenCalledWith('Core');
  });

  it('abbonamento nuovo "Core" con importo da 29 → e il Growth di oggi', async () => {
    expect(
      await handleSubscriptionUpdate(
        evento(abbonamento('ACTIVE', { name: 'Core', price: '29.00' })),
        ORA,
      ),
    ).toBe('done');
    expect(findPlanByName).toHaveBeenCalledWith('Growth');
  });

  it('nome fuori dal listino → concluso: non e un abbonamento nostro', async () => {
    (findPlanByName as never as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    expect(await handleSubscriptionUpdate(evento(abbonamento('ACTIVE')), ORA)).toBe('done');
    expect(applyPlanToShop).not.toHaveBeenCalled();
  });
});

describe('un abbonamento finito', () => {
  beforeEach(() => {
    (prisma.shop.findUnique as never as ReturnType<typeof vi.fn>).mockResolvedValue(negozio());
    (findFreePlan as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      planName: 'Basic',
      trialDays: 14,
    });
  });

  for (const stato of ['CANCELLED', 'DECLINED', 'EXPIRED', 'FROZEN']) {
    it(`${stato} → retrocessione al piano gratuito`, async () => {
      expect(await handleSubscriptionUpdate(evento(abbonamento(stato)), ORA)).toBe('done');

      expect(applyPlanToShop).toHaveBeenCalledWith(
        expect.objectContaining({ planName: 'Basic', chargeId: null }),
      );
    });
  }

  it('non fa ripartire la prova mentre retrocede', async () => {
    // Una prova che riparte alla disdetta e' un regalo che nessuno ha deciso di
    // fare: `trialDays: null` lascia `isInTrial` falso e `trialEndsAt` vuoto.
    await handleSubscriptionUpdate(evento(abbonamento('CANCELLED')), ORA);

    expect(applyPlanToShop).toHaveBeenCalledWith(
      expect.objectContaining({ trialDays: null }),
    );
  });

  it('e idempotente: la seconda consegna non lo riconosce piu come l attivo', async () => {
    // La prima lavorazione azzera `activeChargeId`. E' quello — e non un
    // controllo a parte — a rendere innocua la consegna ripetuta.
    (prisma.shop.findUnique as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      negozio({ currentPlan: 'Basic', activeChargeId: null }),
    );

    expect(await handleSubscriptionUpdate(evento(abbonamento('CANCELLED')), ORA)).toBe('done');
    expect(applyPlanToShop).not.toHaveBeenCalled();
  });

  it('non retrocede per l abbonamento vecchio di un cambio di piano', async () => {
    // Durante un aggiornamento la callback cancella di proposito l'abbonamento
    // precedente, e Shopify manda un CANCELLED per quello. Senza questo
    // controllo, chi ha appena pagato verrebbe retrocesso subito.
    (prisma.shop.findUnique as never as ReturnType<typeof vi.fn>).mockResolvedValue(
      negozio({ activeChargeId: '999' }),
    );

    expect(await handleSubscriptionUpdate(evento(abbonamento('CANCELLED')), ORA)).toBe('done');
    expect(applyPlanToShop).not.toHaveBeenCalled();
  });

  it('listino senza piano gratuito → lettera morta con allarme, NON completato', async () => {
    // E' il caso che prima si dichiarava riuscito: si scriveva "impossibile
    // retrocedere", si rispondeva 200, e il negozio restava su un piano a
    // pagamento senza abbonamento che lo sostenesse — per sempre, perche' non
    // ci tornava sopra nessuno.
    (findFreePlan as never as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});

    const esito = await handleSubscriptionUpdate(evento(abbonamento('CANCELLED')), ORA);

    expect(esito).toBe('dead_letter');
    expect(esito).not.toBe('done');
    expect(applyPlanToShop).not.toHaveBeenCalled();
    expect(allarme).toHaveBeenCalled();
    allarme.mockRestore();
  });
});
