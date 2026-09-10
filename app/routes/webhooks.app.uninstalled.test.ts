import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creaFakeWebhookStore } from '~/lib/webhooks/inbox-fake-store';

/**
 * La rotta per intero: dalla firma all'effetto sul negozio.
 *
 * COSA E' CAMBIATO RISPETTO A PRIMA. Questo file conteneva un test intitolato
 * "errore durante la scrittura → 200 comunque", e quel test descriveva
 * esattamente il difetto: il 200 e' la ricevuta di Shopify, e darlo senza aver
 * scritto niente significava dire "consegnato" per un evento che nessuno
 * avrebbe applicato e che nessuno avrebbe ritentato. Un negozio disinstallato
 * mentre il database non rispondeva restava attivo nei registri per sempre.
 *
 * Adesso quel caso e' due casi, e restano due test distinti perche' sono
 * davvero diversi:
 *   - la RICEVUTA non riesce   → 5xx, cosi' Shopify ritenta
 *   - l'ELABORAZIONE non riesce, dopo la ricevuta → 200, e il lavoro resta
 *     ritentabile da noi
 */

const store = creaFakeWebhookStore();
const verifyWebhook = vi.fn(() => true);
const shopFindUnique = vi.fn();
const shopUpdateMany = vi.fn();
const sessionDeleteMany = vi.fn();
const configDeleteMany = vi.fn();
const tokenDeleteMany = vi.fn();
const deleteMerchantData = vi.fn();
const transaction = vi.fn(async (operazioni: unknown[]) => Promise.all(operazioni as never[]));

vi.mock('~/lib/webhooks/verify.server', () => ({
  verifyWebhook: (...a: unknown[]) => verifyWebhook(...(a as [])),
}));
vi.mock('~/db.server', () => ({
  prisma: {
    get webhookEvent() {
      return store;
    },
    shop: {
      findUnique: (...a: unknown[]) => shopFindUnique(...a),
      updateMany: (...a: unknown[]) => shopUpdateMany(...a),
    },
    session: { deleteMany: (...a: unknown[]) => sessionDeleteMany(...a) },
    supabaseConfig: { deleteMany: (...a: unknown[]) => configDeleteMany(...a) },
    supabaseOAuthToken: { deleteMany: (...a: unknown[]) => tokenDeleteMany(...a) },
    $transaction: (...a: unknown[]) => transaction(...(a as [unknown[]])),
  },
}));
vi.mock('~/lib/supabase/delete-merchant-data.server', () => ({
  deleteMerchantData: (...a: unknown[]) => deleteMerchantData(...a),
}));

import { action as rotta } from './webhooks.app.uninstalled';
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


const DOMINIO = 'test-shop.myshopify.com';

function req(over: { shopDomain?: string | null; webhookId?: string } = {}) {
  const headers: Record<string, string> = {
    'X-Shopify-Hmac-Sha256': 'valid-sig',
    'X-Shopify-Webhook-Id': over.webhookId ?? 'consegna-1',
  };
  const dominio = over.shopDomain === undefined ? DOMINIO : over.shopDomain;
  if (dominio) headers['X-Shopify-Shop-Domain'] = dominio;

  return new Request('https://app/webhooks/app/uninstalled', {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: 1 }),
  });
}

describe('webhook app/uninstalled', () => {
  beforeEach(() => {
    store.reset();
    vi.clearAllMocks();
    verifyWebhook.mockReturnValue(true);
    shopFindUnique.mockResolvedValue({ id: 'shop-1' });
    shopUpdateMany.mockResolvedValue({ count: 1 });
    sessionDeleteMany.mockResolvedValue({ count: 1 });
  });

  it('firma non valida → 401, nessuna scrittura', async () => {
    verifyWebhook.mockReturnValue(false);

    const res = await action({ request: req() } as never);

    expect(res.status).toBe(401);
    expect(store.righe).toHaveLength(0);
    expect(shopUpdateMany).not.toHaveBeenCalled();
  });

  it('senza dominio del negozio → 400', async () => {
    const res = await action({ request: req({ shopDomain: null }) } as never);

    expect(res.status).toBe(400);
    expect(store.righe).toHaveLength(0);
  });

  it('scrive la ricevuta prima di qualunque effetto', async () => {
    // E' l'ordine che rende l'evento irreperdibile: da qui in poi, qualunque
    // cosa accada, la riga c'e' e il drenaggio ci ripassa.
    const res = await action({ request: req() } as never);

    expect(res.status).toBe(200);
    expect(store.righe).toHaveLength(1);
    expect(store.righe[0].topic).toBe('app/uninstalled');
    expect(store.righe[0].shopDomain).toBe(DOMINIO);
  });

  it('segna il negozio come disinstallato', async () => {
    await action({ request: req() } as never);

    const arg = shopUpdateMany.mock.calls[0][0] as {
      where: unknown;
      data: { uninstalledAt: Date };
    };
    expect(arg.where).toEqual({ shopDomain: DOMINIO, uninstalledAt: null });
    expect(arg.data.uninstalledAt).toBeInstanceOf(Date);
  });

  it('cancella le sessioni: il token e gia morto lato Shopify', async () => {
    await action({ request: req() } as never);

    expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { shop: DOMINIO } });
  });

  it('NON tocca il collegamento al database ne i dati del merchant', async () => {
    // E' la scelta di fondo: disinstallare l'app non cancella quello che il
    // merchant ha raccolto. Le tabelle stanno nel suo progetto e restano sue.
    await action({ request: req() } as never);

    expect(configDeleteMany).not.toHaveBeenCalled();
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });

  it('non passa dall eliminazione dei dati: quella e un gesto esplicito', async () => {
    // `deleteMerchantData` esiste per una richiesta sola — "scollega ed
    // elimina", scritta a mano nel modal con il nome del progetto — e da
    // nessun'altra parte. Una disinstallazione non e' quella richiesta:
    // reinstallando il merchant deve ritrovare tutto al suo posto.
    await action({ request: req() } as never);

    expect(deleteMerchantData).not.toHaveBeenCalled();
  });

  it('negozio sconosciuto → 200 lo stesso, evento concluso', async () => {
    // Il webhook arriva anche per installazioni mai completate: updateMany su
    // zero righe non lancia, e non c'e' niente da ritentare.
    shopFindUnique.mockResolvedValue(null);
    shopUpdateMany.mockResolvedValue({ count: 0 });

    expect((await action({ request: req() } as never)).status).toBe(200);
    expect(store.righe[0].status).toBe('completed');
  });

  it('la RICEVUTA non riesce → 5xx, perche Shopify deve ritentare', async () => {
    // Il test che stava qui diceva "200 comunque", ed era il difetto: senza
    // riga e senza ritentativo, quell'evento non lo applicava piu' nessuno.
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store, 'create').mockRejectedValueOnce(new Error('database irraggiungibile'));

    const res = await action({ request: req() } as never);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(shopUpdateMany).not.toHaveBeenCalled();
    expect(allarme).toHaveBeenCalled();
    allarme.mockRestore();
  });

  it('l ELABORAZIONE non riesce dopo la ricevuta → 200, e il lavoro resta ritentabile', async () => {
    // Caso diverso dal precedente, e per questo test distinto: la ricevuta e'
    // gia' scritta, quindi far ritentare Shopify vorrebbe dire rifiutare un
    // evento gia' accettato. Ma l'evento non e' concluso, e il cron ci ripassa.
    const allarme = vi.spyOn(console, 'error').mockImplementation(() => {});
    transaction.mockRejectedValueOnce(new Error('database irraggiungibile'));

    const res = await action({ request: req() } as never);

    expect(res.status).toBe(200);
    expect(store.righe[0].status).toBe('queued');
    expect(store.righe[0].completedAt).toBeNull();
    allarme.mockRestore();
  });

  it('lo stesso webhook id due volte → un solo effetto', async () => {
    await action({ request: req({ webhookId: 'consegna-1' }) } as never);
    const seconda = await action({ request: req({ webhookId: 'consegna-1' }) } as never);

    expect(seconda.status).toBe(200);
    expect(store.righe).toHaveLength(1);
    expect(shopUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('la reinstallazione non passa di qui: si riabilita solo con un OAuth nuovo', async () => {
    // Nessun ramo di questa rotta scrive `uninstalledAt: null`. A riaccendere un
    // negozio e' `afterAuth`, cioe' un consenso nuovo del merchant — mai un
    // record vecchio che ripassa.
    await action({ request: req({ webhookId: 'vecchia-consegna' }) } as never);

    // Il negozio nel frattempo ha reinstallato: la riga risulta di nuovo attiva.
    shopUpdateMany.mockClear();

    // Shopify riconsegna il vecchio evento di disinstallazione.
    await action({ request: req({ webhookId: 'vecchia-consegna' }) } as never);

    // Non lo tocca: quell'evento e' gia' concluso, e la presa lo riconosce.
    expect(shopUpdateMany).not.toHaveBeenCalled();
    expect(store.righe).toHaveLength(1);
    expect(store.righe[0].status).toBe('completed');
  });

  it('nessuna scrittura di questa rotta riaccende un negozio', async () => {
    await action({ request: req() } as never);

    for (const chiamata of shopUpdateMany.mock.calls) {
      const data = (chiamata[0] as { data: Record<string, unknown> }).data;
      expect(data.uninstalledAt).not.toBeNull();
    }
  });
});
