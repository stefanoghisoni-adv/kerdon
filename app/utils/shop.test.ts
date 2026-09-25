import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsert = vi.fn();
const findUnique = vi.fn();
const update = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      upsert: (...args: unknown[]) => upsert(...args),
      findUnique: (...args: unknown[]) => findUnique(...args),
      update: (...args: unknown[]) => update(...args),
    },
  },
}));

vi.mock('~/utils/crypto.server', () => ({
  encrypt: (v: string) => `enc(${v})`,
  decrypt: (v: string) => v,
}));

const initialPlan = vi.fn(async () => ({ planName: 'Basic', trialDays: 14 }));
vi.mock('~/lib/billing/find-plan.server', () => ({
  initialPlan: () => initialPlan(),
}));

import { getOrCreateShop, shopCreateData } from './shop.server';

describe('shopCreateData', () => {
  it('costruisce i dati di creazione dalla sessione', async () => {
    const data = await shopCreateData({ shop: 'x.myshopify.com', accessToken: 'tok', scope: 'read_products' });
    expect(data.shopDomain).toBe('x.myshopify.com');
    expect(data.accessToken).toBe('enc(tok)');
    expect(data.scopes).toBe('read_products');
    expect(data.isInTrial).toBe(true);
    expect(data.trialEndsAt).toBeInstanceOf(Date);
  });

  it('la prova dura quanto dice il listino, non quanto diceva il codice', async () => {
    // Qui c'erano sette giorni scritti a mano mentre il listino ne dichiarava
    // quattordici: il negozio nasceva con una scadenza che non corrispondeva a
    // nessuna delle promesse fatte al merchant.
    initialPlan.mockResolvedValueOnce({ planName: 'Basic', trialDays: 14 });

    const data = await shopCreateData({ shop: 'x.myshopify.com', accessToken: 'tok' });

    const giorni =
      ((data.trialEndsAt as Date).getTime() - data.installedAt.getTime()) / 86_400_000;
    expect(giorni).toBe(14);
  });

  it('piano senza prova a listino: il negozio nasce gia\' fuori dalla prova', async () => {
    // Zero giorni non e' una prova che scade subito: e' nessuna prova. La
    // differenza conta, perche' una scadenza gia' passata spegnerebbe l'app
    // all'installazione.
    initialPlan.mockResolvedValueOnce({ planName: 'Basic', trialDays: 0 });

    const data = await shopCreateData({ shop: 'x.myshopify.com', accessToken: 'tok' });

    expect(data.isInTrial).toBe(false);
    expect(data.trialEndsAt).toBeNull();
  });

  it('il piano iniziale viene dal listino, non da un nome scritto qui', async () => {
    // Se il piano gratuito si chiamasse "Gratuito", un negozio nuovo deve
    // atterrare li': un nome fisso nel codice sopravvivrebbe al rinomina e la
    // foreign key su current_plan lo rifiuterebbe.
    initialPlan.mockResolvedValueOnce({ planName: 'Gratuito', trialDays: 14 });
    const data = await shopCreateData({ shop: 'x.myshopify.com', accessToken: 'tok' });
    expect(data.currentPlan).toBe('Gratuito');
  });

  it('non fallisce se accessToken/scope sono assenti', async () => {
    const data = await shopCreateData({ shop: 'y.myshopify.com' });
    expect(data.accessToken).toBe('enc()');
    expect(data.scopes).toBe('');
  });
});

describe('getOrCreateShop (self-heal)', () => {
  beforeEach(() => {
    upsert.mockReset();
    findUnique.mockReset();
    update.mockReset();
  });

  it('shop esistente: una sola SELECT, nessuna scrittura', async () => {
    const existing = { id: 's1', shopDomain: 'x.myshopify.com', supabaseConfig: null };
    findUnique.mockResolvedValueOnce(existing);

    const shop = await getOrCreateShop({ shop: 'x.myshopify.com', accessToken: 'tok' });

    expect(shop).toEqual(existing);
    // Il percorso caldo (ogni apertura della dashboard) non deve costare
    // una write transaction sul primario.
    expect(upsert).not.toHaveBeenCalled();
    const arg = findUnique.mock.calls[0][0] as { where: unknown; include: unknown };
    expect(arg.where).toEqual({ shopDomain: 'x.myshopify.com' });
    expect(arg.include).toEqual({ supabaseConfig: true });
  });

  it('esegue un upsert per la sessione e ritorna lo shop (creandolo se manca)', async () => {
    findUnique.mockResolvedValueOnce(null);
    upsert.mockResolvedValueOnce({ id: 's1', shopDomain: 'x.myshopify.com', supabaseConfig: null });
    const shop = await getOrCreateShop({
      shop: 'x.myshopify.com',
      accessToken: 'tok',
      scope: 'read_products',
    });
    expect(shop).toEqual({ id: 's1', shopDomain: 'x.myshopify.com', supabaseConfig: null });
    const arg = upsert.mock.calls[0][0] as {
      where: unknown;
      create: { shopDomain: string; accessToken: string };
      update: unknown;
      include: unknown;
    };
    expect(arg.where).toEqual({ shopDomain: 'x.myshopify.com' });
    expect(arg.create.shopDomain).toBe('x.myshopify.com');
    expect(arg.create.accessToken).toBe('enc(tok)');
    expect(arg.update).toEqual({});
    expect(arg.include).toEqual({ supabaseConfig: true });
  });
});

// Da `shops.scopes` si decide cosa l'app puo' fare. Si scriveva solo alla
// creazione della riga e nel callback OAuth: bastava che i permessi cambiassero
// dopo — e con l'autenticazione embedded quel giro non ripassa da `afterAuth` —
// perche' la nostra copia restasse indietro per sempre. Con gli ordini concessi
// su Shopify ma non ancora scritti qui, profitto, margine, prodotti piu'
// venduti e tab Clienti si spengono tutti insieme.
describe('i permessi si riallineano a quelli veri', () => {
  beforeEach(() => {
    upsert.mockReset();
    findUnique.mockReset();
    update.mockReset();
  });

  const negozio = (scopes: string | null) => ({
    id: 's1',
    shopDomain: 'x.myshopify.com',
    scopes,
    supabaseConfig: null,
  });

  it('permessi cambiati: si riscrivono, e il chiamante vede subito i nuovi', async () => {
    findUnique.mockResolvedValueOnce(negozio('read_products'));
    update.mockResolvedValueOnce({});

    const shop = await getOrCreateShop({
      shop: 'x.myshopify.com',
      accessToken: 'tok',
      scope: 'read_products,read_orders,read_all_orders',
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { scopes: 'read_products,read_orders,read_all_orders' },
    });
    // Non basta scriverli: chi ha chiamato deve poterli usare in questo giro,
    // altrimenti la dashboard resta spenta fino al ricaricamento successivo.
    expect(shop.scopes).toBe('read_products,read_orders,read_all_orders');
  });

  it('permessi uguali: nessuna scrittura', async () => {
    findUnique.mockResolvedValueOnce(negozio('read_products,read_orders'));

    await getOrCreateShop({
      shop: 'x.myshopify.com',
      accessToken: 'tok',
      scope: 'read_products,read_orders',
    });

    expect(update).not.toHaveBeenCalled();
  });

  // Shopify non garantisce un ordine: confrontare le stringhe avrebbe prodotto
  // una scrittura a ogni apertura della dashboard, per sempre.
  it('stessi permessi in ordine diverso: nessuna scrittura', async () => {
    findUnique.mockResolvedValueOnce(negozio('read_orders,read_products'));

    await getOrCreateShop({
      shop: 'x.myshopify.com',
      accessToken: 'tok',
      scope: 'read_products, read_orders',
    });

    expect(update).not.toHaveBeenCalled();
  });

  it('sessione senza permessi: non si cancella quello che sappiamo', async () => {
    findUnique.mockResolvedValueOnce(negozio('read_products,read_orders'));

    const shop = await getOrCreateShop({ shop: 'x.myshopify.com', accessToken: 'tok' });

    expect(update).not.toHaveBeenCalled();
    expect(shop.scopes).toBe('read_products,read_orders');
  });
});
