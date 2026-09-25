import { describe, it, expect, vi, beforeEach } from 'vitest';

const shopFindMany = vi.fn();
const shopUpdateMany = vi.fn();
const getActiveSubscriptions = vi.fn();
const markShopUninstalled = vi.fn();
const applyActiveSubscription = vi.fn();
const downgradeToFreePlan = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      findMany: (...a: unknown[]) => shopFindMany(...a),
      updateMany: (...a: unknown[]) => shopUpdateMany(...a),
    },
  },
}));
vi.mock('~/lib/billing/subscription.server', async () => {
  // `parseGidId` resta quello vero: e' la funzione che decide se l'abbonamento
  // che Shopify dichiara e' lo stesso che risulta a noi, e sostituirla
  // renderebbe il confronto una tautologia.
  const vero = await vi.importActual<typeof import('~/lib/billing/subscription.server')>(
    '~/lib/billing/subscription.server',
  );
  return {
    ...vero,
    getActiveSubscriptions: (...a: unknown[]) => getActiveSubscriptions(...a),
  };
});
vi.mock('./handle-uninstall.server', () => ({
  markShopUninstalled: (...a: unknown[]) => markShopUninstalled(...a),
}));
vi.mock('./handle-subscription-update.server', () => ({
  applyActiveSubscription: (...a: unknown[]) => applyActiveSubscription(...a),
  downgradeToFreePlan: (...a: unknown[]) => downgradeToFreePlan(...a),
}));

import { isRevokedToken, reconcileShopStates } from './reconcile.server';

const ORA = new Date('2026-09-05T12:00:00.000Z');
const adminFor = vi.fn(async () => ({ graphql: vi.fn() }) as never);

function negozio(over: Record<string, unknown> = {}) {
  return {
    id: 'shop-1',
    shopDomain: 'negozio.myshopify.com',
    currentPlan: 'Growth',
    activeChargeId: '123',
    ...over,
  };
}

function abbonamento(over: Record<string, unknown> = {}) {
  return {
    gid: 'gid://shopify/AppSubscription/123',
    name: 'Growth',
    status: 'ACTIVE',
    priceAmount: 29,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  shopFindMany.mockResolvedValue([negozio()]);
  shopUpdateMany.mockResolvedValue({ count: 1 });
  getActiveSubscriptions.mockResolvedValue([abbonamento()]);
  applyActiveSubscription.mockResolvedValue('done');
  downgradeToFreePlan.mockResolvedValue('done');
});

describe('la rotazione', () => {
  it('guarda solo chi non e stato guardato di recente, i piu vecchi per primi', async () => {
    // Ogni negozio costa una chiamata a Shopify: senza la colonna del timbro,
    // il giro ripasserebbe ogni volta dai soliti primi e agli ultimi non
    // arriverebbe mai.
    await reconcileShopStates(adminFor, ORA);

    const arg = shopFindMany.mock.calls[0][0] as {
      where: { uninstalledAt: null; OR: unknown[] };
      orderBy: unknown;
      take: number;
    };
    expect(arg.where.uninstalledAt).toBeNull();
    expect(arg.orderBy).toEqual({ shopifyStateCheckedAt: { sort: 'asc', nulls: 'first' } });
    expect(arg.take).toBeGreaterThan(0);
  });

  it('timbra solo i negozi che hanno davvero risposto', async () => {
    // Rimandare in fondo alla fila un negozio che non ha risposto vorrebbe dire
    // non guardarlo per altre dodici ore proprio perche' qualcosa non andava.
    getActiveSubscriptions.mockRejectedValue(new Error('rete assente'));
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});

    const esito = await reconcileShopStates(adminFor, ORA);

    expect(esito.checked).toBe(0);
    expect(shopUpdateMany).not.toHaveBeenCalled();
    expect(esito.errors).toHaveLength(1);
    allarme.mockRestore();
  });

  it('scrive il timbro quando il giro e andato bene', async () => {
    await reconcileShopStates(adminFor, ORA);

    expect(shopUpdateMany).toHaveBeenCalledWith({
      where: { id: 'shop-1' },
      data: { shopifyStateCheckedAt: ORA },
    });
  });
});

describe('lo stato dell installazione', () => {
  it('token revocato → disinstallazione applicata, come l avrebbe applicata il webhook', async () => {
    // E' l'evento perso fuori dalla finestra dei ritentativi: Shopify non lo
    // rimandera' mai, e l'unico modo di accorgersene e' andare a guardare.
    getActiveSubscriptions.mockRejectedValue(
      new Error('getActiveSubscriptions: [API] Invalid API key or access token'),
    );
    const avviso = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const esito = await reconcileShopStates(adminFor, ORA);

    expect(esito.uninstalled).toBe(1);
    expect(markShopUninstalled).toHaveBeenCalledWith('negozio.myshopify.com', ORA);
    avviso.mockRestore();
  });

  it('un guasto qualunque NON disinstalla niente', async () => {
    // Nel dubbio si sbaglia dalla parte del negozio che resta acceso: un
    // negozio spento per errore smette di sincronizzare, e se ne accorge il
    // merchant, non noi.
    getActiveSubscriptions.mockRejectedValue(new Error('502 Bad Gateway'));
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});

    const esito = await reconcileShopStates(adminFor, ORA);

    expect(markShopUninstalled).not.toHaveBeenCalled();
    expect(esito.uninstalled).toBe(0);
    allarme.mockRestore();
  });

  it('un negozio senza sessione non viene disinstallato per quello', async () => {
    // `unauthenticated.admin` solleva quando non trova una sessione. Puo'
    // essere un'installazione a meta', non una disinstallazione.
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});
    const senzaSessione = vi.fn(async () => {
      throw new Error('Could not find a session for shop');
    });

    await reconcileShopStates(senzaSessione as never, ORA);

    expect(markShopUninstalled).not.toHaveBeenCalled();
    allarme.mockRestore();
  });

  it('riconosce solo i messaggi che vogliono dire "token revocato"', () => {
    expect(isRevokedToken(new Error('[API] Invalid API key or access token'))).toBe(true);
    expect(isRevokedToken(new Error('unrecognized login or wrong password'))).toBe(true);
    expect(isRevokedToken(new Error('App is not installed'))).toBe(true);
    expect(isRevokedToken(new Error('fetch failed'))).toBe(false);
    expect(isRevokedToken(new Error('Throttled'))).toBe(false);
  });
});

describe('lo stato dell abbonamento', () => {
  it('niente di attivo su Shopify ma un addebito da noi → retrocessione', async () => {
    // E' il webhook di fine abbonamento che non e' mai arrivato: senza questo
    // giro, il negozio resterebbe su un piano che nessuno paga.
    getActiveSubscriptions.mockResolvedValue([]);
    const avviso = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const esito = await reconcileShopStates(adminFor, ORA);

    expect(esito.downgraded).toBe(1);
    expect(downgradeToFreePlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shop-1' }),
      123n,
      ORA,
    );
    avviso.mockRestore();
  });

  it('niente di attivo e nessun addebito da noi → niente da fare', async () => {
    getActiveSubscriptions.mockResolvedValue([]);
    shopFindMany.mockResolvedValue([negozio({ activeChargeId: null, currentPlan: 'Basic' })]);

    const esito = await reconcileShopStates(adminFor, ORA);

    expect(esito.downgraded).toBe(0);
    expect(downgradeToFreePlan).not.toHaveBeenCalled();
  });

  it('listino senza piano gratuito → il negozio non viene timbrato', async () => {
    // Non si dichiara controllato un negozio che si e' rinunciato a sistemare:
    // il giro dopo ci riprova, e intanto l'errore e' nel riepilogo del cron.
    getActiveSubscriptions.mockResolvedValue([]);
    downgradeToFreePlan.mockResolvedValue('dead_letter');
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});

    const esito = await reconcileShopStates(adminFor, ORA);

    expect(esito.downgraded).toBe(0);
    expect(shopUpdateMany).not.toHaveBeenCalled();
    expect(esito.errors[0]).toContain('nessun piano gratuito');
    allarme.mockRestore();
  });

  it('abbonamento attivo che da noi non risultava → allineato', async () => {
    shopFindMany.mockResolvedValue([negozio({ activeChargeId: null, currentPlan: 'Basic' })]);
    const avviso = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const esito = await reconcileShopStates(adminFor, ORA);

    expect(esito.aligned).toBe(1);
    expect(applyActiveSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'shop-1' }),
      'Growth',
      123n,
      ORA,
      29,
    );
    avviso.mockRestore();
  });

  it('abbonamento nato col nome di prima e gia attivo → non si tocca', async () => {
    // Nato fra il 23 e il 26 settembre 2026 come "Core" da 29: la migrazione ha
    // gia' portato il negozio su Growth. Confrontando i nomi lo si sarebbe
    // "riallineato" sul Core da 149.
    getActiveSubscriptions.mockResolvedValue([abbonamento({ name: 'Core', priceAmount: 29 })]);

    const esito = await reconcileShopStates(adminFor, ORA);

    expect(esito.aligned).toBe(0);
    expect(applyActiveSubscription).not.toHaveBeenCalled();
  });

  it('abbonamento "Pro" di prima e gia attivo → non si tocca', async () => {
    getActiveSubscriptions.mockResolvedValue([abbonamento({ name: 'Pro', priceAmount: 19 })]);

    await reconcileShopStates(adminFor, ORA);

    expect(applyActiveSubscription).not.toHaveBeenCalled();
  });

  it('gia allineato → non scrive niente: e il caso normale', async () => {
    const esito = await reconcileShopStates(adminFor, ORA);

    expect(esito.checked).toBe(1);
    expect(esito.aligned).toBe(0);
    expect(applyActiveSubscription).not.toHaveBeenCalled();
    expect(downgradeToFreePlan).not.toHaveBeenCalled();
  });

  it('un abbonamento in attesa non conta come attivo', async () => {
    // PENDING vuol dire che il merchant non ha ancora approvato: trattarlo come
    // attivo darebbe un piano a pagamento a chi non ha pagato.
    getActiveSubscriptions.mockResolvedValue([abbonamento({ status: 'PENDING' })]);
    const avviso = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const esito = await reconcileShopStates(adminFor, ORA);

    expect(esito.downgraded).toBe(1);
    avviso.mockRestore();
  });
});
