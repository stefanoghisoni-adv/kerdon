import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creaFakeWebhookStore } from '~/lib/webhooks/inbox-fake-store';

/**
 * Le cancellazioni dopo che il lavoro e' uscito dalla richiesta HTTP.
 *
 * Una cancellazione non riuscita non e' piu' un 500: la ricevuta e' gia'
 * scritta, quindi si risponde 200 e la riga torna in attesa. La differenza non
 * e' formale — prima era Shopify a ritentare, per una finestra che finisce;
 * adesso ritentiamo noi, e se dopo cinque tentativi non ci si riesce l'evento
 * finisce in lettera morta invece di sparire.
 */
const store = creaFakeWebhookStore();

vi.mock('~/lib/webhooks/verify.server', () => ({ verifyWebhook: () => true }));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn() }));
vi.mock('~/db.server', () => ({
  prisma: {
    // La posta in arrivo vera: l'indice unico e la presa condizionata sullo
    // stato sono cio' che rende un evento consegnato due volte un effetto solo.
    get webhookEvent() {
      return store;
    },
    session: { count: async () => 0, findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    shop: { findUnique: vi.fn() },
    plan: { findFirst: vi.fn() },
    syncJob: { create: vi.fn() },
    // Il registro dell'ambito: un prodotto cancellato deve uscire anche da li',
    // altrimenti continua a occupare un posto del tetto — e quel posto e' un
    // prodotto vivo tenuto fuori dalla sincronizzazione per sempre.
    productScopeEntry: { deleteMany: vi.fn(async () => ({ count: 1 })) },
  },
}));

import { action as rottaProdotto } from './webhooks.products.delete';
import { action as rottaCliente } from './webhooks.customers.delete';
import { settleWebhookWork } from '~/lib/webhooks/receive.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';

/**
 * Le cancellazioni.
 *
 * Sono passate a chiedere la stessa capacita' della scrittura, e non e' una
 * svista. Verrebbe da lasciarle passare sempre — togliere una riga sembra
 * sempre innocuo — ma la copia del merchant si ferma tutta insieme: se le
 * aggiunte sono bloccate e le rimozioni no, quel che resta non e' piu' una
 * fotografia di niente, e' un catalogo che si svuota da solo mentre nessuno lo
 * aggiorna. Un negozio sospeso deve ritrovare i suoi dati come li aveva
 * lasciati, e ricomincera' ad allinearli quando torna in regola.
 *
 * Cio' che la legge impone di cancellare non passa di qui: i webhook GDPR non
 * chiedono niente alla policy, e cancellano anche a negozio sospeso o
 * disinstallato.
 */

/** Le due rotte, ognuna con il lavoro che parte dopo la risposta. */
async function deleteProduct(args: { request: Request }) {
  const res = await rottaProdotto(args as never);
  await settleWebhookWork();
  return res;
}

async function deleteCustomer(args: { request: Request }) {
  const res = await rottaCliente(args as never);
  await settleWebhookWork();
  return res;
}

/** L'evento numero `i` fra quelli che il test ha prodotto. */
function evento(i = 0) {
  return store.righe[i];
}

function req(path: string, body: unknown) {
  return new Request(`https://app/webhooks/${path}`, {
    method: 'POST',
    headers: {
      'X-Shopify-Hmac-Sha256': 'sig',
      'X-Shopify-Shop-Domain': 'test-shop.myshopify.com',
    },
    body: JSON.stringify(body),
  });
}

function mockShop(over: Record<string, unknown> = {}) {
  (prisma.shop.findUnique as any).mockResolvedValue({
    id: 'shop-1',
    shopDomain: 'test-shop.myshopify.com',
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products,read_customers',
    currentPlan: 'pro',
    supabaseConfig: {
      connectionVerifiedAt: new Date(),
      tableNameProducts: 'products',
      tableNameCustomers: 'customers',
    },
    ...over,
  });
  (prisma.plan.findFirst as any).mockResolvedValue({
    planName: 'pro',
    customersSyncEnabled: true,
    productFeedsEnabled: true,
  });
  (prisma.syncJob.create as any).mockResolvedValue({});
}

/** Raccoglie le tabelle su cui e' stata chiesta una cancellazione. */
function mockSupabase(error: { message: string; code?: string } | null = null) {
  const deleted: string[] = [];
  (createSupabaseClient as any).mockReturnValue({
    from: (table: string) => ({
      delete: () => {
        deleted.push(table);
        return { eq: async () => ({ error }) };
      },
    }),
  });
  return deleted;
}

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  mockShop();
});

describe('webhook products/delete', () => {
  it('negozio in regola: la riga se ne va davvero', async () => {
    const deleted = mockSupabase();

    const res = await deleteProduct({ request: req('products/delete', { id: 99 }) } as any);

    expect(res.status).toBe(200);
    expect(deleted).toEqual(['products']);
  });

  // "Fuori quota" e "non esiste piu'" sono due cose diverse. Un prodotto fermo
  // per il tetto del piano tiene le sue righe — e' il punto di tutto il
  // registro dell'ambito — ma tenerle vuol dire non buttarle via perche' sono
  // vecchie, non tenerle anche quando il merchant ha eliminato il prodotto.
  // Fuori ambito non ci ripassa nessuna corsa: se non se ne va adesso, non se
  // ne va piu'.
  it('un prodotto fuori ambito viene comunque rimosso, e libera il posto', async () => {
    const deleted = mockSupabase();
    (prisma.productScopeEntry.deleteMany as any).mockClear();

    const res = await deleteProduct({ request: req('products/delete', { id: 99 }) } as any);

    expect(res.status).toBe(200);
    expect(deleted).toEqual(['products']);
    expect(prisma.productScopeEntry.deleteMany).toHaveBeenCalledWith({
      where: { shopId: 'shop-1', shopifyProductId: { in: ['99'] } },
    });
  });

  const nonSiCancella = async () => {
    const deleted = mockSupabase();
    const res = await deleteProduct({ request: req('products/delete', { id: 99 }) } as any);
    expect(res.status).toBe(200);
    expect(deleted).toEqual([]);
    expect(createSupabaseClient).not.toHaveBeenCalled();
  };

  it("uso dell'app sospeso: la copia resta ferma com'era", async () => {
    mockShop({ authorization: 'DISABLED' });
    await nonSiCancella();
  });

  it('app disinstallata: la copia resta ferma', async () => {
    mockShop({ uninstalledAt: new Date('2026-05-01T00:00:00Z') });
    await nonSiCancella();
  });

  it('progetto scollegato: non si cancella (come prima)', async () => {
    mockShop({ supabaseConfig: { connectionVerifiedAt: null, tableNameProducts: 'products' } });
    await nonSiCancella();
  });
});

describe('webhook customers/delete', () => {
  it('negozio in regola: la riga se ne va davvero', async () => {
    const deleted = mockSupabase();

    const res = await deleteCustomer({ request: req('customers/delete', { id: 7 }) } as any);

    expect(res.status).toBe(200);
    expect(deleted).toEqual(['customers']);
  });

  const nonSiCancella = async () => {
    const deleted = mockSupabase();
    const res = await deleteCustomer({ request: req('customers/delete', { id: 7 }) } as any);
    expect(res.status).toBe(200);
    expect(deleted).toEqual([]);
  };

  it("uso dell'app sospeso: la copia resta ferma", async () => {
    mockShop({ authorization: 'DISABLED' });
    await nonSiCancella();
  });

  it('app disinstallata: la copia resta ferma', async () => {
    mockShop({ uninstalledAt: new Date('2026-05-01T00:00:00Z') });
    await nonSiCancella();
  });

  it('piano senza clienti: la tabella e gia ferma, e resta ferma', async () => {
    // Cambio di comportamento consapevole: prima la cancellazione passava anche
    // qui. Ma se il piano non prevede i clienti, quella tabella non riceve piu'
    // ne' aggiunte ne' aggiornamenti da un pezzo — lasciar passare le sole
    // rimozioni la eroderebbe senza mai rimpiazzarne il contenuto.
    mockShop({ currentPlan: 'free' });
    (prisma.plan.findFirst as any).mockResolvedValue({
      planName: 'free',
      customersSyncEnabled: false,
    });
    await nonSiCancella();
  });
});

// Una cancellazione dichiarata riuscita quando non lo e' lascia nel database del
// merchant una riga che Shopify considera sparita: il prodotto continua a
// comparire nei suoi conti, i dati della persona restano dove non dovrebbero.
// Ed e' definitivo, perche' con il 200 Shopify non ripete la consegna.
describe('una cancellazione fallita non si dichiara riuscita', () => {
  it('prodotto non cancellato → l evento resta da lavorare, e la traccia c e', async () => {
    mockShop();
    mockSupabase({ message: 'permission denied for table products', code: '42501' });

    const res = await deleteProduct({ request: req('products/delete', { id: 99 }) } as any);

    expect(res.status).toBe(200);
    expect(evento().status).toBe('queued');
    expect(evento().attempts).toBe(1);
    const job = (prisma.syncJob.create as any).mock.calls[0][0].data;
    expect(job).toMatchObject({ shopId: 'shop-1', status: 'failed' });
    expect(job.errors.message).toContain('permission denied');
  });

  it('cliente non cancellato → l evento resta da lavorare, e la traccia c e', async () => {
    mockShop();
    mockSupabase({ message: 'permission denied for table customers', code: '42501' });

    const res = await deleteCustomer({ request: req('customers/delete', { id: 7 }) } as any);

    expect(res.status).toBe(200);
    expect(evento().status).toBe('queued');
    expect(evento().attempts).toBe(1);
    const job = (prisma.syncJob.create as any).mock.calls[0][0].data;
    expect(job).toMatchObject({ shopId: 'shop-1', status: 'failed' });
    expect(job.errors.message).toContain('permission denied');
  });

  // Il guasto che non sappiamo gestire e' passeggero quanto l'altro: il
  // database dell'app che non risponde non deve costare la cancellazione.
  it('database dell app irraggiungibile → nessun finto ricevuto: il lavoro resta', async () => {
    // La ricevuta e' passata (la scrive un'altra tabella), quindi il 200 e'
    // dovuto: rifiutare adesso un evento gia' accettato non aiuterebbe. Cio'
    // che NON si dichiara e' che la cancellazione sia avvenuta — le due righe
    // tornano in attesa, ed e' li' che si legge la differenza.
    (prisma.shop.findUnique as any).mockRejectedValue(new Error('connection refused'));

    const prodotto = await deleteProduct({ request: req('products/delete', { id: 99 }) } as any);
    const cliente = await deleteCustomer({ request: req('customers/delete', { id: 7 }) } as any);

    expect(prodotto.status).toBe(200);
    expect(cliente.status).toBe(200);
    expect(evento(0).status).toBe('queued');
    expect(evento(1).status).toBe('queued');
    expect(evento(0).completedAt).toBeNull();
    expect(evento(1).completedAt).toBeNull();
  });
});
