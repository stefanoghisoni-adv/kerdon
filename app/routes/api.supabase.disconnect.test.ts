import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const shopUpdate = vi.fn();
const configDeleteMany = vi.fn();
const tokenDeleteMany = vi.fn();
const deleteMerchantData = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'test-shop.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      findUnique: (...a: unknown[]) => findUniqueShop(...a),
      update: (...a: unknown[]) => shopUpdate(...a),
    },
    supabaseConfig: { deleteMany: (...a: unknown[]) => configDeleteMany(...a) },
    supabaseOAuthToken: { deleteMany: (...a: unknown[]) => tokenDeleteMany(...a) },
  },
}));
vi.mock('~/lib/supabase/delete-merchant-data.server', () => ({
  deleteMerchantData: (...a: unknown[]) => deleteMerchantData(...a),
}));

import { action } from './api.supabase.disconnect';

const SHOP = {
  id: 'shop-1',
  shopDomain: 'test-shop.myshopify.com',
  authorization: 'ENABLED',
  locale: 'it',
  detectedLocale: null,
  supabaseConfig: { supabaseProjectRef: 'abcdefgh' },
};

function call(deleteData: boolean) {
  const request = new Request('https://app.example.com/api/supabase/disconnect', {
    method: 'POST',
    body: JSON.stringify({ deleteData }),
    headers: { 'Content-Type': 'application/json' },
  });
  return action({ request, params: {}, context: {} } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueShop.mockResolvedValue({ ...SHOP });
  shopUpdate.mockResolvedValue({});
  configDeleteMany.mockResolvedValue({ count: 1 });
  tokenDeleteMany.mockResolvedValue({ count: 1 });
  deleteMerchantData.mockResolvedValue({
    status: 'completed',
    attempted: ['"public"."products"'],
    remaining: [],
    retryable: false,
  });
});

describe('scollegare mantenendo i dati', () => {
  it('non tocca nessuna tabella: revoca e basta', async () => {
    // E' il default, ed e' anche cio' che succede alla disinstallazione e a
    // shop/redact — che infatti non passano da qui.
    const res = await call(false);

    expect(await res.json()).toEqual({ ok: true });
    expect(deleteMerchantData).not.toHaveBeenCalled();
    expect(tokenDeleteMany).toHaveBeenCalledWith({ where: { shopId: 'shop-1' } });
    expect(configDeleteMany).toHaveBeenCalledWith({ where: { shopId: 'shop-1' } });
    expect(shopUpdate).toHaveBeenCalledWith({
      where: { id: 'shop-1' },
      data: { setupCompletedAt: null },
    });
  });

  it('anche un corpo senza deleteData mantiene i dati', async () => {
    const request = new Request('https://app.example.com/api/supabase/disconnect', {
      method: 'POST',
      body: 'non e json',
      headers: { 'Content-Type': 'application/json' },
    });

    const res = await action({ request, params: {}, context: {} } as never);

    expect(await res.json()).toEqual({ ok: true });
    expect(deleteMerchantData).not.toHaveBeenCalled();
  });
});

describe('scollegare eliminando i dati', () => {
  it('riuscito: la revoca l ha gia fatta l eliminazione', async () => {
    const res = await call(true);

    expect(await res.json()).toMatchObject({ ok: true });
    expect(deleteMerchantData).toHaveBeenCalledWith('shop-1');
    // Nessuna seconda cancellazione: token e configurazione sono gia' andati,
    // dopo la verifica.
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(configDeleteMany).not.toHaveBeenCalled();
  });

  it('fallito: niente ok, e le credenziali restano', async () => {
    // Un errore vero non deve mai diventare `ok: true`. Le credenziali sono
    // l'unica cosa con cui l'eliminazione si puo' ancora portare a termine.
    deleteMerchantData.mockResolvedValue({
      status: 'failed',
      attempted: ['"public"."orders"'],
      remaining: ['"public"."orders"'],
      retryable: true,
      error: 'eliminazione incompleta',
    });

    const res = await call(true);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.retryable).toBe(true);
    expect(body.code).toBe('delete_data_failed');
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(configDeleteMany).not.toHaveBeenCalled();
    expect(shopUpdate).not.toHaveBeenCalled();
  });

  it('fallito e non ritentabile: 422, e sempre niente ok', async () => {
    deleteMerchantData.mockResolvedValue({
      status: 'failed',
      attempted: [],
      remaining: [],
      retryable: false,
      error: 'identificatore non valido',
    });

    const res = await call(true);

    expect(res.status).toBe(422);
    expect((await res.json()).ok).toBe(false);
    expect(configDeleteMany).not.toHaveBeenCalled();
  });

  it('gia in corso: la seconda richiesta non ripete niente', async () => {
    deleteMerchantData.mockResolvedValue({
      status: 'already_running',
      attempted: [],
      remaining: [],
      retryable: true,
    });

    const res = await call(true);
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body.code).toBe('deletion_in_progress');
    expect(configDeleteMany).not.toHaveBeenCalled();
  });

  it('niente di nostro da eliminare: si scollega lo stesso', async () => {
    deleteMerchantData.mockResolvedValue({
      status: 'nothing_owned',
      attempted: [],
      remaining: [],
      retryable: false,
    });

    const res = await call(true);

    expect(await res.json()).toEqual({ ok: true });
    expect(configDeleteMany).toHaveBeenCalledWith({ where: { shopId: 'shop-1' } });
  });

  it('senza database collegato non si prova nemmeno', async () => {
    findUniqueShop.mockResolvedValue({ ...SHOP, supabaseConfig: null });

    const res = await call(true);

    expect(await res.json()).toEqual({ ok: true });
    expect(deleteMerchantData).not.toHaveBeenCalled();
  });
});

describe('chi non puo chiedere', () => {
  // E' la via d'uscita, e resta aperta anche a chi e' sospeso o non paga piu':
  // restare chiusi dentro con i propri dati ancora da noi non e' un esito
  // ammissibile. Cio' che deve restare impedito — due cancellazioni insieme —
  // lo impedisce il lucchetto dentro `deleteMerchantData`, che e' il posto dove
  // si sa se ce n'e' gia' una in corso.
  it('negozio sospeso: l eliminazione si fa lo stesso', async () => {
    findUniqueShop.mockResolvedValue({ ...SHOP, authorization: 'DISABLED' });

    const res = await call(true);

    expect(res.status).toBe(200);
    expect(deleteMerchantData).toHaveBeenCalled();
  });

  it('negozio sconosciuto: 404', async () => {
    findUniqueShop.mockResolvedValue(null);

    const res = await call(true);

    expect(res.status).toBe(404);
    expect(deleteMerchantData).not.toHaveBeenCalled();
  });
});
