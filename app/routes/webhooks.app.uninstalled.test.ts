import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyWebhook = vi.fn(() => true);
const updateManyShop = vi.fn();
const deleteManySession = vi.fn();
const deleteManyConfig = vi.fn();
const deleteManyToken = vi.fn();
const deleteMerchantData = vi.fn();

vi.mock('~/lib/webhooks/verify.server', () => ({
  verifyWebhook: (...a: unknown[]) => verifyWebhook(...(a as [])),
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { updateMany: (...a: unknown[]) => updateManyShop(...a) },
    session: { deleteMany: (...a: unknown[]) => deleteManySession(...a) },
    supabaseConfig: { deleteMany: (...a: unknown[]) => deleteManyConfig(...a) },
    supabaseOAuthToken: { deleteMany: (...a: unknown[]) => deleteManyToken(...a) },
  },
}));
vi.mock('~/lib/supabase/delete-merchant-data.server', () => ({
  deleteMerchantData: (...a: unknown[]) => deleteMerchantData(...a),
}));

import { action } from './webhooks.app.uninstalled';

function req(shopDomain: string | null = 'test-shop.myshopify.com') {
  const headers: Record<string, string> = { 'X-Shopify-Hmac-Sha256': 'valid-sig' };
  if (shopDomain) headers['X-Shopify-Shop-Domain'] = shopDomain;
  return new Request('https://app/webhooks/app/uninstalled', {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: 1 }),
  });
}

describe('webhook app/uninstalled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyWebhook.mockReturnValue(true);
    updateManyShop.mockResolvedValue({ count: 1 });
    deleteManySession.mockResolvedValue({ count: 1 });
  });

  it('firma non valida → 401, nessuna scrittura', async () => {
    verifyWebhook.mockReturnValue(false);

    const res = await action({ request: req() } as never);

    expect(res.status).toBe(401);
    expect(updateManyShop).not.toHaveBeenCalled();
  });

  it('senza dominio del negozio → 400', async () => {
    const res = await action({ request: req(null) } as never);

    expect(res.status).toBe(400);
    expect(updateManyShop).not.toHaveBeenCalled();
  });

  it('segna il negozio come disinstallato', async () => {
    const res = await action({ request: req() } as never);

    expect(res.status).toBe(200);
    const arg = updateManyShop.mock.calls[0][0] as {
      where: unknown;
      data: { uninstalledAt: Date };
    };
    expect(arg.where).toEqual({ shopDomain: 'test-shop.myshopify.com' });
    expect(arg.data.uninstalledAt).toBeInstanceOf(Date);
  });

  it('cancella le sessioni: il token e gia morto lato Shopify', async () => {
    await action({ request: req() } as never);

    expect(deleteManySession).toHaveBeenCalledWith({
      where: { shop: 'test-shop.myshopify.com' },
    });
  });

  it('NON tocca il collegamento al database ne i dati del merchant', async () => {
    // E' la scelta di fondo: disinstallare l'app non cancella quello che il
    // merchant ha raccolto. Le tabelle stanno nel suo progetto e restano sue.
    await action({ request: req() } as never);

    expect(deleteManyConfig).not.toHaveBeenCalled();
    expect(deleteManyToken).not.toHaveBeenCalled();
  });

  it('non passa dall eliminazione dei dati: quella e un gesto esplicito', async () => {
    // `deleteMerchantData` esiste per una richiesta sola — "scollega ed
    // elimina", scritta a mano nel modal con il nome del progetto — e da
    // nessun'altra parte. Una disinstallazione non e' quella richiesta:
    // reinstallando il merchant deve ritrovare tutto al suo posto.
    await action({ request: req() } as never);

    expect(deleteMerchantData).not.toHaveBeenCalled();
  });

  it('negozio sconosciuto → 200 lo stesso', async () => {
    // updateMany su zero righe non lancia: il webhook non deve far ritentare
    // Shopify per un negozio che non abbiamo mai avuto.
    updateManyShop.mockResolvedValue({ count: 0 });

    expect((await action({ request: req() } as never)).status).toBe(200);
  });

  it('errore durante la scrittura → 200 comunque', async () => {
    updateManyShop.mockRejectedValue(new Error('database irraggiungibile'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await action({ request: req() } as never)).status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
