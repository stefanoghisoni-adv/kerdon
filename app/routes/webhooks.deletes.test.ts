import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/lib/webhooks/verify.server', () => ({ verifyWebhook: () => true }));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn() }));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: vi.fn() },
    plan: { findFirst: vi.fn() },
    syncJob: { create: vi.fn() },
  },
}));

import { action as deleteProduct } from './webhooks.products.delete';
import { action as deleteCustomer } from './webhooks.customers.delete';
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
  it('prodotto non cancellato → 500 e riga nel registro dei job', async () => {
    mockShop();
    mockSupabase({ message: 'permission denied for table products', code: '42501' });

    const res = await deleteProduct({ request: req('products/delete', { id: 99 }) } as any);

    expect(res.status).toBe(500);
    const job = (prisma.syncJob.create as any).mock.calls[0][0].data;
    expect(job).toMatchObject({ shopId: 'shop-1', status: 'failed' });
    expect(job.errors.message).toContain('permission denied');
  });

  it('cliente non cancellato → 500 e riga nel registro dei job', async () => {
    mockShop();
    mockSupabase({ message: 'permission denied for table customers', code: '42501' });

    const res = await deleteCustomer({ request: req('customers/delete', { id: 7 }) } as any);

    expect(res.status).toBe(500);
    const job = (prisma.syncJob.create as any).mock.calls[0][0].data;
    expect(job).toMatchObject({ shopId: 'shop-1', status: 'failed' });
    expect(job.errors.message).toContain('permission denied');
  });

  // Il guasto che non sappiamo gestire e' passeggero quanto l'altro: il
  // database dell'app che non risponde non deve costare la cancellazione.
  it('database dell app irraggiungibile → 500, non un finto ricevuto', async () => {
    (prisma.shop.findUnique as any).mockRejectedValue(new Error('connection refused'));

    const prodotto = await deleteProduct({ request: req('products/delete', { id: 99 }) } as any);
    const cliente = await deleteCustomer({ request: req('customers/delete', { id: 7 }) } as any);

    expect(prodotto.status).toBe(500);
    expect(cliente.status).toBe(500);
  });
});
