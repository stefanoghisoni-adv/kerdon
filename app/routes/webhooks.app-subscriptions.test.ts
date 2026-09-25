import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creaFakeWebhookStore } from '~/lib/webhooks/inbox-fake-store';

/**
 * La rotta per intero: dalla firma all'effetto sul piano del negozio.
 *
 * COSA E' CAMBIATO RISPETTO A PRIMA. Ogni ramo di questa rotta finiva con un
 * 200, compreso quello in cui non si era fatto niente perche' qualcosa era
 * andato storto. Il caso peggiore era il listino senza piano gratuito: si
 * scriveva "impossibile retrocedere", si rispondeva riuscito, e da li' in poi
 * non ci tornava sopra nessuno — il negozio restava su un piano a pagamento
 * senza abbonamento che lo sostenesse.
 *
 * Adesso il 200 dice solo "ricevuto". Cosa e' successo davvero si legge sullo
 * stato della riga, ed e' li' che questi test guardano.
 */

const store = creaFakeWebhookStore();
const verifyWebhook = vi.fn(() => true);
const shopFindUnique = vi.fn();
const chargeUpdateMany = vi.fn();

vi.mock('~/lib/webhooks/verify.server', () => ({
  verifyWebhook: (...a: unknown[]) => verifyWebhook(...(a as [])),
}));
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
    get webhookEvent() {
      return store;
    },
    shop: { findUnique: (...a: unknown[]) => shopFindUnique(...a) },
    billingCharge: { updateMany: (...a: unknown[]) => chargeUpdateMany(...a) },
    // La posta in arrivo conosce adesso TUTTI i processori, compresi quelli
    // che passano dal client Shopify: il magazzino delle sessioni si costruisce
    // all'import e pretende di trovare questa tabella.
    session: { count: async () => 0, findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
  },
}));

import { action as rotta } from './webhooks.app-subscriptions.update';
import { settleWebhookWork } from '~/lib/webhooks/receive.server';

/**
 * La rotta piu' il lavoro che parte dopo la risposta.
 *
 * L'elaborazione non e' piu' attesa dentro la richiesta — il budget di
 * risposta e' quello della sola ricevuta — quindi chi deve osservare l'effetto
 * aspetta qui. Shopify no, ed e' esattamente il punto.
 */
async function action(args: { request: Request }) {
  const res = await rotta(args as never);
  await settleWebhookWork();
  return res;
}

import { applyPlanToShop } from '~/lib/billing/apply-plan.server';
import { findFreePlan, findPlanByName } from '~/lib/billing/find-plan.server';

const DOMINIO = 'test-shop.myshopify.com';

function req(payload: object, over: { webhookId?: string } = {}): Request {
  return new Request('https://app/webhooks/app-subscriptions/update', {
    method: 'POST',
    headers: {
      'X-Shopify-Hmac-Sha256': 'valid-sig',
      'X-Shopify-Shop-Domain': DOMINIO,
      'X-Shopify-Webhook-Id': over.webhookId ?? 'consegna-1',
    },
    body: JSON.stringify(payload),
  });
}

function abbonamento(status: string, name = 'growth') {
  return {
    app_subscription: {
      admin_graphql_api_id: 'gid://shopify/AppSubscription/123',
      name,
      status,
      price: '29.00',
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

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

describe('webhook app_subscriptions/update', () => {
  beforeEach(() => {
    store.reset();
    vi.clearAllMocks();
    verifyWebhook.mockReturnValue(true);
    chargeUpdateMany.mockResolvedValue({ count: 1 });
    shopFindUnique.mockResolvedValue(negozio());
  });

  it('firma non valida → 401, nessuna riga', async () => {
    verifyWebhook.mockReturnValue(false);

    const res = await action({ request: req(abbonamento('ACTIVE')) } as never);

    expect(res.status).toBe(401);
    expect(store.righe).toHaveLength(0);
  });

  it('la RICEVUTA non riesce → 5xx, perche Shopify deve ritentare', async () => {
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store, 'create').mockRejectedValueOnce(new Error('database irraggiungibile'));

    const res = await action({ request: req(abbonamento('CANCELLED')) } as never);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(applyPlanToShop).not.toHaveBeenCalled();
    allarme.mockRestore();
  });

  it('l ELABORAZIONE non riesce dopo la ricevuta → 200, e il lavoro resta ritentabile', async () => {
    // Due casi distinti e per questo due test: sopra Shopify deve ritentare,
    // qui no — la riga c'e', e a riprendere il lavoro e' il drenaggio del cron.
    shopFindUnique.mockRejectedValue(new Error('database irraggiungibile'));

    const res = await action({ request: req(abbonamento('CANCELLED')) } as never);

    expect(res.status).toBe(200);
    expect(store.righe[0].status).toBe('queued');
    expect(store.righe[0].attempts).toBe(1);
    expect(store.righe[0].completedAt).toBeNull();
  });

  it('negozio sconosciuto → 200, nessuna azione, evento concluso', async () => {
    shopFindUnique.mockResolvedValue(null);

    const res = await action({ request: req(abbonamento('ACTIVE')) } as never);

    expect(res.status).toBe(200);
    expect(applyPlanToShop).not.toHaveBeenCalled();
    expect(store.righe[0].status).toBe('completed');
  });

  it('ACTIVE con piano a listino → il piano viene applicato', async () => {
    shopFindUnique.mockResolvedValue(negozio({ currentPlan: 'basic', activeChargeId: null }));
    mock(findPlanByName).mockResolvedValue({ planName: 'Growth', trialDays: 14 });

    const res = await action({ request: req(abbonamento('ACTIVE')) } as never);

    expect(res.status).toBe(200);
    expect(applyPlanToShop).toHaveBeenCalledWith(
      expect.objectContaining({ planName: 'Growth', chargeId: '123' }),
    );
    expect(store.righe[0].status).toBe('completed');
  });

  it('ACTIVE gia allineato → non riapplica, cosi la prova non riparte', async () => {
    // Shopify puo' rimandare lo stesso ACTIVE piu' volte: riapplicare il piano
    // ricalcolerebbe `trialEndsAt` da adesso, regalando giorni gratis a ogni
    // consegna ripetuta.
    shopFindUnique.mockResolvedValue(negozio({ currentPlan: 'Growth' }));
    mock(findPlanByName).mockResolvedValue({ planName: 'Growth', trialDays: 14 });

    await action({ request: req(abbonamento('ACTIVE')) } as never);

    expect(applyPlanToShop).not.toHaveBeenCalled();
  });

  it('PENDING → nessuna azione: l abbonamento non e ancora approvato', async () => {
    await action({ request: req(abbonamento('PENDING')) } as never);

    expect(applyPlanToShop).not.toHaveBeenCalled();
    expect(store.righe[0].status).toBe('completed');
  });

  for (const stato of ['CANCELLED', 'DECLINED', 'EXPIRED', 'FROZEN']) {
    it(`${stato} sull abbonamento attivo → retrocessione al piano gratuito`, async () => {
      mock(findFreePlan).mockResolvedValue({ planName: 'Basic', trialDays: 14 });

      const res = await action({ request: req(abbonamento(stato)) } as never);

      expect(res.status).toBe(200);
      expect(applyPlanToShop).toHaveBeenCalledWith(
        expect.objectContaining({ planName: 'Basic', chargeId: null, trialDays: null }),
      );
      expect(chargeUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }),
      );
    });
  }

  it('CANCELLED di un abbonamento che non e l attivo → non retrocede nessuno', async () => {
    // Durante un cambio di piano la callback cancella di proposito
    // l'abbonamento precedente, e Shopify manda un CANCELLED per quello. Senza
    // questo controllo, chi ha appena pagato un aggiornamento verrebbe
    // retrocesso subito.
    shopFindUnique.mockResolvedValue(negozio({ activeChargeId: '999' }));

    await action({ request: req(abbonamento('CANCELLED')) } as never);

    expect(applyPlanToShop).not.toHaveBeenCalled();
    expect(store.righe[0].status).toBe('completed');
  });

  it('retrocessione idempotente: la seconda consegna non fa niente', async () => {
    mock(findFreePlan).mockResolvedValue({ planName: 'Basic', trialDays: 14 });

    await action({ request: req(abbonamento('CANCELLED'), { webhookId: 'c1' }) } as never);
    // Dopo la prima, il negozio non ha piu' un addebito attivo.
    shopFindUnique.mockResolvedValue(negozio({ currentPlan: 'Basic', activeChargeId: null }));
    mock(applyPlanToShop).mockClear();

    await action({ request: req(abbonamento('CANCELLED'), { webhookId: 'c2' }) } as never);

    expect(applyPlanToShop).not.toHaveBeenCalled();
  });

  it('listino senza piano gratuito → lettera morta con allarme, NON completato', async () => {
    // E' il caso che prima si dichiarava riuscito. Il 200 resta — la ricevuta
    // c'e' — ma la riga dice che il lavoro non e' stato fatto, e c'e' un allarme
    // nel log con il comando per riprenderlo.
    mock(findFreePlan).mockResolvedValue(null);
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await action({ request: req(abbonamento('CANCELLED')) } as never);

    expect(res.status).toBe(200);
    expect(store.righe[0].status).toBe('dead_letter');
    expect(store.righe[0].status).not.toBe('completed');
    expect(applyPlanToShop).not.toHaveBeenCalled();
    expect(allarme.mock.calls.some((c) => String(c[0]).includes('ALLARME'))).toBe(true);
    allarme.mockRestore();
  });

  it('corpo senza i campi minimi → lettera morta, non cinque ritentativi', async () => {
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await action({ request: req({ app_subscription: {} }) } as never);

    expect(res.status).toBe(200);
    expect(store.righe[0].status).toBe('dead_letter');
    allarme.mockRestore();
  });

  it('lo stesso webhook id due volte → un solo effetto', async () => {
    mock(findFreePlan).mockResolvedValue({ planName: 'Basic', trialDays: 14 });

    await action({ request: req(abbonamento('CANCELLED'), { webhookId: 'c1' }) } as never);
    const seconda = await action(
      { request: req(abbonamento('CANCELLED'), { webhookId: 'c1' }) } as never,
    );

    expect(seconda.status).toBe(200);
    expect(store.righe).toHaveLength(1);
    expect(applyPlanToShop).toHaveBeenCalledTimes(1);
  });
});
