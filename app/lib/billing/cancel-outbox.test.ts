import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();
const upsert = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    billingCharge: {
      findMany: (...a: unknown[]) => findMany(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
      update: (...a: unknown[]) => update(...a),
      upsert: (...a: unknown[]) => upsert(...a),
    },
  },
}));

const cancelAppSubscription = vi.fn();
const getActiveSubscriptions = vi.fn();
vi.mock('./subscription.server', async () => {
  const actual = await vi.importActual<typeof import('./subscription.server')>(
    './subscription.server',
  );
  return {
    parseGidId: actual.parseGidId,
    cancelAppSubscription: (...a: unknown[]) => cancelAppSubscription(...a),
    getActiveSubscriptions: (...a: unknown[]) => getActiveSubscriptions(...a),
  };
});

import {
  drainPendingCancellations,
  drainSupersededCharges,
  enqueueUnknownActiveSubscriptions,
  markSupersededCharges,
  SUPERSEDED,
} from './cancel-outbox.server';

/**
 * La chiusura degli abbonamenti sostituiti.
 *
 * Prima era un try/catch in coda alla callback: se la chiamata a Shopify
 * falliva, si scriveva una riga di log e il lavoro spariva li'. Nessuno ci
 * tornava sopra, e il merchant continuava a pagare due abbonamenti senza che da
 * nessuna parte risultasse qualcosa da fare. Quel che questi test difendono e'
 * una cosa sola: che l'intenzione resti scritta finche' non e' stata eseguita.
 */

const admin = { graphql: vi.fn() };

beforeEach(() => {
  // resetAllMocks e non clearAllMocks: le implementazioni che un test infila
  // (una cancellazione che fallisce, per dire) resterebbero addosso a quelli
  // dopo, e li farebbero fallire per un motivo che non e' il loro.
  vi.resetAllMocks();
  updateMany.mockResolvedValue({ count: 0 });
  findMany.mockResolvedValue([]);
  cancelAppSubscription.mockResolvedValue(undefined);
  getActiveSubscriptions.mockResolvedValue([]);
});

describe('markSupersededCharges', () => {
  it("segna gli addebiti del negozio diversi da quello appena confermato", async () => {
    updateMany.mockResolvedValue({ count: 2 });
    const tx = { billingCharge: { updateMany: (...a: unknown[]) => updateMany(...a) } };

    const count = await markSupersededCharges(tx as never, 'shop-1', '1234');

    expect(count).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        shopId: 'shop-1',
        status: { in: ['active', 'pending'] },
        shopifyChargeId: { not: null },
        NOT: { shopifyChargeId: 1234n },
      },
      data: { status: SUPERSEDED },
    });
  });

  it("prende anche i tentativi ancora in attesa", async () => {
    // Una scheda rimasta aperta su una pagina di approvazione e' un abbonamento
    // che il merchant potrebbe ancora accettare: non deve poter diventare un
    // secondo addebito vivo.
    const tx = { billingCharge: { updateMany: (...a: unknown[]) => updateMany(...a) } };
    await markSupersededCharges(tx as never, 'shop-1', '1234');
    expect((updateMany.mock.calls[0][0] as any).where.status).toEqual({
      in: ['active', 'pending'],
    });
  });
});

describe('drainSupersededCharges', () => {
  it('chiude su Shopify e segna la riga solo dopo la conferma', async () => {
    findMany.mockResolvedValue([{ id: 'r1', shopifyChargeId: 9876n }]);

    const chiusi = await drainSupersededCharges(admin as never, 'shop-1');

    expect(chiusi).toBe(1);
    expect(cancelAppSubscription).toHaveBeenCalledWith(
      admin,
      'gid://shopify/AppSubscription/9876',
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'r1' },
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    );
  });

  it("una chiusura fallita lascia la riga dov'era: il lavoro non si perde", async () => {
    findMany.mockResolvedValue([{ id: 'r1', shopifyChargeId: 9876n }]);
    cancelAppSubscription.mockRejectedValue(new Error('rete'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const chiusi = await drainSupersededCharges(admin as never, 'shop-1');

    expect(chiusi).toBe(0);
    // Segnarla `cancelled` senza che Shopify l'abbia confermato vorrebbe dire
    // perdere di nuovo il lavoro, che e' esattamente il difetto di partenza.
    expect(update).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('un abbonamento che non si chiude non impedisce di chiudere gli altri', async () => {
    findMany.mockResolvedValue([
      { id: 'r1', shopifyChargeId: 1n },
      { id: 'r2', shopifyChargeId: 2n },
    ]);
    cancelAppSubscription.mockRejectedValueOnce(new Error('rete'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await drainSupersededCharges(admin as never, 'shop-1')).toBe(1);
    expect(update).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('non lancia mai: chi chiama ha appena incassato un pagamento', async () => {
    // Un'eccezione qui tornerebbe al merchant come "non e' andata", subito dopo
    // che ha pagato e con il piano gia' attivo.
    findMany.mockRejectedValue(new Error('database'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(drainSupersededCharges(admin as never, 'shop-1')).resolves.toBe(0);

    warnSpy.mockRestore();
  });
});

describe('enqueueUnknownActiveSubscriptions', () => {
  it('mette in coda quel che Shopify dice attivo e noi non aspettavamo', async () => {
    getActiveSubscriptions.mockResolvedValue([
      { gid: 'gid://shopify/AppSubscription/1234', name: 'Growth' },
      { gid: 'gid://shopify/AppSubscription/9876', name: 'Scale' },
    ]);

    await enqueueUnknownActiveSubscriptions(
      admin as never,
      'shop-1',
      'gid://shopify/AppSubscription/1234',
    );

    // Quello appena confermato non si tocca.
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopifyChargeId: 9876n },
        create: expect.objectContaining({ shopId: 'shop-1', status: SUPERSEDED }),
      }),
    );
    // Le righe che esistono gia' si spostano solo se sono di questo negozio.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ shopId: 'shop-1', shopifyChargeId: 9876n }),
        data: { status: SUPERSEDED },
      }),
    );
  });

  it("l'elenco non letto non e' un errore da propagare", async () => {
    getActiveSubscriptions.mockRejectedValue(new Error('rete'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      enqueueUnknownActiveSubscriptions(admin as never, 'shop-1', 'gid://x/1'),
    ).resolves.toBeUndefined();

    warnSpy.mockRestore();
  });
});

describe('drainPendingCancellations', () => {
  it('riprende quel che alla callback non era riuscito, negozio per negozio', async () => {
    // Prima chiamata: i negozi con qualcosa in sospeso. Poi, per ognuno, le sue
    // righe.
    findMany
      .mockResolvedValueOnce([
        { shopId: 'shop-1', shop: { shopDomain: 'uno.myshopify.com' } },
        { shopId: 'shop-2', shop: { shopDomain: 'due.myshopify.com' } },
      ])
      .mockResolvedValueOnce([{ id: 'r1', shopifyChargeId: 1n }])
      .mockResolvedValueOnce([{ id: 'r2', shopifyChargeId: 2n }]);

    const chiusi = await drainPendingCancellations(async () => admin as never);

    expect(chiusi).toBe(2);
    expect(cancelAppSubscription).toHaveBeenCalledTimes(2);
  });

  it('un negozio senza sessione non ferma gli altri', async () => {
    findMany
      .mockResolvedValueOnce([
        { shopId: 'shop-1', shop: { shopDomain: 'uno.myshopify.com' } },
        { shopId: 'shop-2', shop: { shopDomain: 'due.myshopify.com' } },
      ])
      .mockResolvedValueOnce([{ id: 'r2', shopifyChargeId: 2n }]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const chiusi = await drainPendingCancellations(async (dominio) => {
      if (dominio === 'uno.myshopify.com') throw new Error('nessuna sessione');
      return admin as never;
    });

    expect(chiusi).toBe(1);
    warnSpy.mockRestore();
  });
});
