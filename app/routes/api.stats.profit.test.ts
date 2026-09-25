// app/routes/api.stats.profit.test.ts
//
// Quello che il merchant legge quando il profitto non c'e', e che cosa l'app
// va a chiedere a Supabase in ciascuno dei casi.
//
// Tre fallimenti diversi che si assomigliano da fuori e non vanno confusi:
// il permesso revocato (serve lui), il rinnovo del permesso in corso su
// un'altra richiesta (non serve nessuno, passa da solo) e il database che non
// risponde (li' si va a chiedere a Supabase se e' in pausa).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadShopProfit = vi.fn();
const loadShopAverages = vi.fn();
const noteDatabaseUnreachableForShop = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'test-shop.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      findUnique: async () => ({
        id: 'shop-1',
        shopDomain: 'test-shop.myshopify.com',
        currentPlan: 'growth',
        lifecycleStatus: 'active',
        uninstalledAt: null,
        authorization: 'ENABLED',
        trackingAuthorization: 'ENABLED',
        scopes: 'read_products,read_inventory,write_inventory,read_customers,write_customers,read_publications,read_themes,read_orders,read_all_orders,read_shipping,read_returns',
        isInTrial: false,
        trialEndsAt: null,
        activeChargeId: null,
        ianaTimezone: 'Europe/Rome',
      }),
    },
    plan: { findFirst: async () => ({ planName: 'growth', customersSyncEnabled: true }) },
  },
}));
vi.mock('~/lib/customers/profit.server', () => ({
  loadShopProfit: (...a: unknown[]) => loadShopProfit(...a),
  loadShopAverages: (...a: unknown[]) => loadShopAverages(...a),
}));
vi.mock('~/lib/supabase/database-pause.server', () => ({
  noteDatabaseUnreachableForShop: (...a: unknown[]) => noteDatabaseUnreachableForShop(...a),
}));

import { loader } from './api.stats.profit';
import { SupabaseTokenError } from '~/lib/supabase-management.server';
import { RinnovoPermessoInCorsoError } from '~/lib/supabase-oauth.server';

const call = () =>
  loader({
    request: new Request('https://app/api/stats/profit?from=2026-09-01&to=2026-09-20'),
    params: {},
    context: {},
  } as never);

describe('/api/stats/profit quando il profitto non si puo leggere', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadShopAverages.mockResolvedValue({ aov: null, aop: null, ltv: null, ltp: null, currency: 'EUR', unavailable: null });
  });

  it('permesso revocato: si dice ricollega e non si va a cercare una pausa', async () => {
    loadShopProfit.mockRejectedValue(new SupabaseTokenError(401));

    const body = await (await call()).json();

    expect(body.unavailable).toBe('reconnect');
    // Interrogare Supabase con un permesso che non vale piu' non direbbe
    // niente di nuovo, e il guasto da raccontare e' un altro.
    expect(noteDatabaseUnreachableForShop).not.toHaveBeenCalled();
  });

  it('rinnovo del permesso in corso: si dice che e passeggero, e non si scomoda Supabase', async () => {
    loadShopProfit.mockRejectedValue(new RinnovoPermessoInCorsoError());

    const body = await (await call()).json();

    // Non 'reconnect': il merchant non deve rifare l'autorizzazione per una
    // fila di qualche centinaio di millisecondi. E non 'not_connected', che
    // gli direbbe "dopo la prima sincronizzazione" mentre sincronizza da mesi.
    expect(body.unavailable).toBe('temporary');
    // Il database del merchant non e' stato nemmeno interrogato: non c'e'
    // nessuna pausa da sospettare.
    expect(noteDatabaseUnreachableForShop).not.toHaveBeenCalled();
  });

  it('un 404 non confermato si comporta come un guasto passeggero, pausa compresa', async () => {
    // Il 404 che arrivava alle 15:56 del 20 settembre. Adesso non e' piu' una
    // credenziale morta, quindi il negozio torna dentro la rilevazione della
    // pausa insieme a tutti gli altri fallimenti di lettura.
    loadShopProfit.mockRejectedValue(new SupabaseTokenError(404));

    const body = await (await call()).json();

    expect(body.unavailable).toBe('not_connected');
    expect(noteDatabaseUnreachableForShop).toHaveBeenCalledWith('test-shop.myshopify.com');
  });

  it('un 404 confermato dalla rilettura torna a essere ricollega', async () => {
    loadShopProfit.mockRejectedValue(new SupabaseTokenError(404, true));

    const body = await (await call()).json();

    expect(body.unavailable).toBe('reconnect');
    expect(noteDatabaseUnreachableForShop).not.toHaveBeenCalled();
  });

  it('un guasto qualunque manda a controllare se il database e in pausa', async () => {
    loadShopProfit.mockRejectedValue(new Error('connection refused'));

    const body = await (await call()).json();

    expect(body.unavailable).toBe('not_connected');
    expect(noteDatabaseUnreachableForShop).toHaveBeenCalledWith('test-shop.myshopify.com');
  });
});
