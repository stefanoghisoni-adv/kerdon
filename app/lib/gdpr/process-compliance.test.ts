import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('~/db.server', () => ({
  prisma: {
    complianceRequest: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    shop: { findUnique: vi.fn() },
    syncJob: { create: vi.fn() },
  },
}));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn(() => ({})) }));
vi.mock('~/lib/queue/shop-lock.server', () => ({ runWithShopLease: vi.fn() }));
vi.mock('./customer-record.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./customer-record.server')>();
  return {
    ...actual,
    collectCustomerData: vi.fn(),
    eraseCustomerFromMerchant: vi.fn(),
    eraseCustomerFromAppDatabase: vi.fn(),
  };
});
vi.mock('./shop-record.server', () => ({ eraseShopRecord: vi.fn() }));
vi.mock('./audit.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./audit.server')>();
  return { ...actual, saveGdprOutcome: vi.fn(), trySaveGdprOutcome: vi.fn() };
});

import { Prisma } from '@prisma/client';
import {
  MAX_ATTEMPTS,
  drainComplianceRequests,
  processComplianceRequest,
  pruneExpiredExports,
} from './process-compliance.server';
import { prisma } from '~/db.server';
import { runWithShopLease } from '~/lib/queue/shop-lock.server';
import {
  collectCustomerData,
  eraseCustomerFromAppDatabase,
  eraseCustomerFromMerchant,
} from './customer-record.server';
import { eraseShopRecord } from './shop-record.server';
import { saveGdprOutcome, trySaveGdprOutcome } from './audit.server';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Il lavoro, dopo la ricevuta.
 *
 * Queste prove stavano nel file delle rotte finche' erano le rotte a fare il
 * lavoro. Non sono cambiate perche' il lavoro sia cambiato — cancella le stesse
 * tabelle, anonimizza gli stessi ordini — ma perche' e' cambiato dove avviene:
 * fuori dalla richiesta HTTP, dove puo' metterci il tempo che serve senza che
 * Shopify scambi la lentezza per un rifiuto.
 *
 * Le due cose che qui vanno difese piu' di tutte sono lo stato e la ripetizione.
 * Una consegna doppia non deve produrre due esportazioni ne' due cancellazioni
 * in corsa; un fallimento non deve sparire in silenzio ne' restare a ritentare
 * per sempre senza che nessuno se ne accorga.
 */

const SHOP = 'test-shop.myshopify.com';
const OK = { count: 1 };

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    webhookId: 'consegna-1',
    topic: 'customers/redact',
    shopDomain: SHOP,
    shopId: null,
    customerRef: 'impronta',
    payload: { shop_domain: SHOP, customer: { id: 4021 } },
    attempts: 1,
    ...over,
  };
}

const shopWithConfig = {
  id: 'shop-1',
  supabaseConfig: { tableNameCustomers: 'customers' },
};

/** L'argomento dell'ultimo `update` sulla riga della richiesta. */
function lastUpdate() {
  const calls = (prisma.complianceRequest.update as any).mock.calls;
  return calls.at(-1)?.[0].data;
}

let errorSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.complianceRequest.updateMany as any).mockResolvedValue(OK);
  (prisma.complianceRequest.findUnique as any).mockResolvedValue(row());
  (prisma.complianceRequest.update as any).mockResolvedValue({});
  (prisma.complianceRequest.deleteMany as any).mockResolvedValue({ count: 1 });
  (prisma.shop.findUnique as any).mockResolvedValue(shopWithConfig);
  (runWithShopLease as any).mockImplementation(
    async (_id: string, run: (lease: unknown) => Promise<void>) => {
      await run({ shopId: _id, assertHeld: async () => undefined });
      return 'eseguito';
    },
  );
  (eraseCustomerFromMerchant as any).mockResolvedValue([
    { table: 'customers', outcome: 'deleted', rows: 1 },
  ]);
  (eraseCustomerFromAppDatabase as any).mockResolvedValue([
    { table: 'customer_data_access_log', outcome: 'deleted', rows: 0 },
  ]);
  (collectCustomerData as any).mockResolvedValue({
    data: { customer: { id: 4021 }, orders: [], order_lines: [], browsers: [] },
    steps: [{ table: 'customers', outcome: 'read', rows: 1 }],
  });
  (eraseShopRecord as any).mockResolvedValue({
    outcome: 'erased',
    shopId: null,
    proofId: 'prova-1',
    steps: [{ table: 'shops', outcome: 'deleted', rows: 1 }],
  });
  // Dichiarata qui e non lasciata al default: `clearAllMocks` azzera le
  // chiamate ma NON l'implementazione, quindi un test che la fa fallire se la
  // porterebbe dietro in tutti quelli dopo.
  (saveGdprOutcome as any).mockResolvedValue(undefined);
  (trySaveGdprOutcome as any).mockResolvedValue(undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('la presa, che rende innocua la consegna doppia', () => {
  it('chi arriva secondo non lavora niente', async () => {
    // Non un controllo prima — due invocazioni simultanee lo passerebbero
    // entrambe — ma un aggiornamento condizionato sullo stato: chi trova zero
    // righe aggiornate se ne va.
    (prisma.complianceRequest.updateMany as any).mockResolvedValue({ count: 0 });

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('skipped');
    expect(eraseCustomerFromMerchant).not.toHaveBeenCalled();
  });

  it('si prende solo cio che e in coda o gia fallito', async () => {
    await processComplianceRequest('req-1');
    const where = (prisma.complianceRequest.updateMany as any).mock.calls[0][0].where;

    expect(where.status.in).toEqual(['queued', 'failed']);
  });

  it('ogni presa conta un tentativo', async () => {
    await processComplianceRequest('req-1');
    const data = (prisma.complianceRequest.updateMany as any).mock.calls[0][0].data;

    expect(data.attempts).toEqual({ increment: 1 });
    expect(data.status).toBe('processing');
  });

  it('riga sparita nel frattempo: non si inventa niente', async () => {
    (prisma.complianceRequest.findUnique as any).mockResolvedValue(null);

    expect(await processComplianceRequest('req-1')).toBe('skipped');
  });
});

describe('customers/redact', () => {
  it('cancella nel database del merchant e nel nostro', async () => {
    const result = await processComplianceRequest('req-1');

    expect(result).toBe('done');
    expect(eraseCustomerFromMerchant).toHaveBeenCalled();
    expect(eraseCustomerFromAppDatabase).toHaveBeenCalled();
  });

  it('avviene sotto il lucchetto della sincronizzazione', async () => {
    // Una corsa avviata un istante prima riscriverebbe il cliente subito dopo
    // averlo cancellato.
    await processComplianceRequest('req-1');

    expect(runWithShopLease).toHaveBeenCalledWith('shop-1', expect.any(Function));
  });

  it('lucchetto occupato: non e un fallimento, si riprova', async () => {
    (runWithShopLease as any).mockResolvedValue('occupato');

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
    expect(lastUpdate()?.status ?? 'failed').not.toBe('completed');
  });

  it('negozio senza progetto collegato: il nostro database si pulisce lo stesso', async () => {
    (prisma.shop.findUnique as any).mockResolvedValue({ id: 'shop-1', supabaseConfig: null });

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('done');
    expect(eraseCustomerFromMerchant).not.toHaveBeenCalled();
    expect(eraseCustomerFromAppDatabase).toHaveBeenCalled();
  });

  it('negozio mai registrato: niente da cancellare, e non e un errore', async () => {
    (prisma.shop.findUnique as any).mockResolvedValue(null);

    expect(await processComplianceRequest('req-1')).toBe('done');
  });

  it('cancellazione parziale: la richiesta NON risulta riuscita', async () => {
    (eraseCustomerFromMerchant as any).mockResolvedValue([
      { table: 'customers', outcome: 'failed', rows: 0, detail: 'statement timeout' },
    ]);

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
    // La traccia di un fallimento passa da `trySave`: li' si sta gia'
    // registrando un guasto, e una traccia che non si scrive non deve coprirlo
    // con un secondo guasto. Il percorso della riuscita, invece, solleva.
    const traccia = (trySaveGdprOutcome as any).mock.calls.at(-1)[1];
    expect(traccia.steps.some((s: any) => s.outcome === 'failed')).toBe(true);
  });
});

describe('customers/data_request', () => {
  const asDataRequest = () =>
    (prisma.complianceRequest.findUnique as any).mockResolvedValue(
      row({ topic: 'customers/data_request' }),
    );

  it("l esportazione si scrive sulla riga, con una scadenza", async () => {
    asDataRequest();
    await processComplianceRequest('req-1');

    expect(lastUpdate().export).toBeTruthy();
    expect(lastUpdate().exportExpiresAt).toBeInstanceOf(Date);
  });

  it('chiusa la richiesta, il payload si azzera davvero', async () => {
    // `undefined` avrebbe voluto dire "non toccare", e l id della persona
    // sarebbe rimasto scritto in una coda di richieste gia eseguite.
    asDataRequest();
    await processComplianceRequest('req-1');

    expect(lastUpdate().payload).toBe(Prisma.DbNull);
  });

  it('persona mai sincronizzata: esportazione vuota, non un errore', async () => {
    asDataRequest();
    (prisma.shop.findUnique as any).mockResolvedValue({ id: 'shop-1', supabaseConfig: null });

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('done');
    expect(lastUpdate().export).toEqual({
      customer: null,
      orders: [],
      order_lines: [],
      browsers: [],
    });
  });

  it('raccolta incompleta: nessuna esportazione, e si ritenta', async () => {
    // Un esportazione incompleta messa a disposizione come completa e peggio di
    // una ritentata: chi la legge crederebbe che il resto non esiste.
    asDataRequest();
    (collectCustomerData as any).mockResolvedValue({
      data: null,
      steps: [{ table: 'orders', outcome: 'failed', rows: 0, detail: 'statement timeout' }],
    });

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
    expect(lastUpdate()?.export).toBeUndefined();
  });
});

describe('shop/redact', () => {
  const asShopRedact = () =>
    (prisma.complianceRequest.findUnique as any).mockResolvedValue(
      row({ topic: 'shop/redact', customerRef: null }),
    );

  it('riuscita: della richiesta stessa non resta traccia nel database', async () => {
    // La riga porta il dominio del negozio appena cancellato: tenerla vorrebbe
    // dire non averlo cancellato. Si puo' togliere solo perche' la prova
    // minimizzata e' gia' stata scritta dentro la transazione che ha cancellato
    // il negozio — senza quella, questa riga sarebbe l'ultima cosa rimasta a
    // dire che la richiesta e' arrivata.
    asShopRedact();
    const result = await processComplianceRequest('req-1');

    expect(result).toBe('done');
    expect(prisma.complianceRequest.deleteMany).toHaveBeenCalledWith({
      where: { shopDomain: SHOP },
    });
  });

  /**
   * Occupato e lucchetto giu' sono due modi di dire "non si e' fatto niente":
   * la riga resta, e resta anche il negozio. Prima questo caso non esisteva —
   * `shop/redact` non prendeva nessun lucchetto, mentre `customers/redact` lo
   * prendeva: la richiesta piu' distruttiva delle due era l'unica senza.
   */
  it.each([
    ['busy', 'occupato'],
    ['lock_unavailable', 'irraggiungibile'],
  ])('lucchetto %s: la richiesta resta ritentabile', async (outcome) => {
    asShopRedact();
    (eraseShopRecord as any).mockResolvedValue({
      outcome,
      shopId: 'shop-1',
      steps: [{ table: 'richiesta', outcome: 'failed', rows: 0, detail: 'si riprova' }],
    });

    expect(await processComplianceRequest('req-1')).toBe('failed');
    expect(prisma.complianceRequest.deleteMany).not.toHaveBeenCalled();
    expect(lastUpdate().status).toBe('failed');
  });

  /**
   * La seconda consegna non ha piu' un negozio in cui riconoscersi: la prova e'
   * l'unica cosa rimasta, e trovarla vale quanto aver fatto il lavoro.
   */
  it('seconda consegna: la prova gia scritta chiude la pratica', async () => {
    asShopRedact();
    (eraseShopRecord as any).mockResolvedValue({
      outcome: 'already_erased',
      shopId: null,
      proofId: 'prova-1',
      steps: [{ table: 'shop_erasure_proofs', outcome: 'skipped', rows: 0 }],
    });

    expect(await processComplianceRequest('req-1')).toBe('done');
    expect(prisma.complianceRequest.deleteMany).toHaveBeenCalledWith({
      where: { shopDomain: SHOP },
    });
  });

  it('porta l id della consegna fino alla cancellazione', async () => {
    asShopRedact();
    await processComplianceRequest('req-1');

    expect(eraseShopRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        shopDomain: SHOP,
        webhookId: 'consegna-1',
        topic: 'shop/redact',
      }),
    );
  });

  it('fallita: la riga resta, perche il negozio e ancora li', async () => {
    asShopRedact();
    (eraseShopRecord as any).mockResolvedValue({
      outcome: 'failed',
      shopId: 'shop-1',
      steps: [{ table: 'sessions', outcome: 'failed', rows: 0, detail: 'timeout' }],
    });

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
    expect(prisma.complianceRequest.deleteMany).not.toHaveBeenCalled();
  });
});

describe('quando va male', () => {
  it('un fallimento torna in coda per il giro dopo', async () => {
    (eraseCustomerFromMerchant as any).mockResolvedValue([
      { table: 'customers', outcome: 'failed', rows: 0, detail: 'timeout' },
    ]);

    await processComplianceRequest('req-1');

    expect(lastUpdate().status).toBe('failed');
    expect(lastUpdate().lastError).toContain('timeout');
  });

  it(`dopo ${MAX_ATTEMPTS} tentativi smette da sola e chiama qualcuno`, async () => {
    // Restare a ritentare in eterno sarebbe peggio: la richiesta di una persona
    // vera sarebbe ferma e nessuno se ne accorgerebbe.
    (prisma.complianceRequest.findUnique as any).mockResolvedValue(
      row({ attempts: MAX_ATTEMPTS - 1 }),
    );
    (eraseCustomerFromMerchant as any).mockResolvedValue([
      { table: 'customers', outcome: 'failed', rows: 0, detail: 'timeout' },
    ]);

    await processComplianceRequest('req-1');

    expect(lastUpdate().status).toBe('dead_letter');
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('ALLARME');
  });

  /**
   * LA PROVA E' UNA CONDIZIONE, NON UN DI PIU'.
   *
   * Prima l'errore di scrittura della traccia veniva inghiottito da un `catch`
   * che scriveva un `console.error` e lasciava proseguire: la richiesta si
   * dichiarava completata, e l'unica prova rimasta era testo in un log a
   * ritenzione breve. Davanti a chi la chiede, quella richiesta non risulta
   * eseguita affatto.
   */
  it('traccia non scritta: la richiesta NON si chiude', async () => {
    (saveGdprOutcome as any).mockRejectedValue(new Error('registro non raggiungibile'));

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
    expect(lastUpdate().status).toBe('failed');
    expect(lastUpdate().completedAt).toBeUndefined();
  });

  it('un errore inatteso non fa risultare la richiesta eseguita', async () => {
    (eraseCustomerFromMerchant as any).mockRejectedValue(new Error('chiave non decifrabile'));

    const result = await processComplianceRequest('req-1');

    expect(result).toBe('failed');
  });

  it('la traccia registra i passi, mai i dati della persona', async () => {
    await processComplianceRequest('req-1');
    const scritto = JSON.stringify((saveGdprOutcome as any).mock.calls.at(-1)[1]);

    expect(scritto).not.toContain('4021');
    expect(scritto).toContain('impronta');
  });
});

describe('il giro del cron', () => {
  it('non dipende dalla coda: riprende cio che e rimasto indietro', async () => {
    // Se la sveglia non e mai arrivata — Redis giu al momento della presa in
    // carico — la riga e comunque qui. E questo passaggio a rendere la coda
    // durevole invece di una speranza.
    (prisma.complianceRequest.findMany as any).mockResolvedValue([
      { id: 'req-1', status: 'queued' },
    ]);

    const { processed } = await drainComplianceRequests();

    expect(processed).toBe(1);
  });

  it('una lavorazione abbandonata a meta viene ripresa', async () => {
    (prisma.complianceRequest.findMany as any).mockResolvedValue([
      { id: 'req-1', status: 'processing' },
    ]);

    await drainComplianceRequests();

    // Prima riportata a 'failed', altrimenti la presa non la prenderebbe: e la
    // stessa condizione sullo stato che protegge dai doppioni.
    const primo = (prisma.complianceRequest.updateMany as any).mock.calls[0][0];
    expect(primo.where.status).toBe('processing');
    expect(primo.data.status).toBe('failed');
  });

  it('le fallite si riprendono distanziate, non subito', async () => {
    (prisma.complianceRequest.findMany as any).mockResolvedValue([]);
    await drainComplianceRequests();

    const or = (prisma.complianceRequest.findMany as any).mock.calls[0][0].where.OR;
    const failed = or.find((c: any) => c.status === 'failed');
    expect(failed.startedAt.lt).toBeInstanceOf(Date);
  });

  it('conta separatamente cio che e riuscito e cio che no', async () => {
    (prisma.complianceRequest.findMany as any).mockResolvedValue([
      { id: 'req-1', status: 'queued' },
      { id: 'req-2', status: 'queued' },
    ]);
    (eraseCustomerFromMerchant as any)
      .mockResolvedValueOnce([{ table: 'customers', outcome: 'deleted', rows: 1 }])
      .mockResolvedValueOnce([{ table: 'customers', outcome: 'failed', rows: 0, detail: 'x' }]);

    const result = await drainComplianceRequests();

    expect(result).toEqual({ processed: 1, failed: 1 });
  });
});

describe('le esportazioni scadute', () => {
  it('si tolgono davvero, non solo si contano', async () => {
    (prisma.complianceRequest.updateMany as any).mockResolvedValue({ count: 3 });

    const removed = await pruneExpiredExports();

    expect(removed).toBe(3);
    const data = (prisma.complianceRequest.updateMany as any).mock.calls[0][0].data;
    expect(data.export).toBe(Prisma.DbNull);
    expect(data.exportExpiresAt).toBeNull();
  });

  it('una copia dei dati di una persona senza scadenza sarebbe per sempre', async () => {
    (prisma.complianceRequest.updateMany as any).mockResolvedValue({ count: 0 });
    const now = new Date('2026-08-29T12:00:00Z');

    await pruneExpiredExports(now);

    const where = (prisma.complianceRequest.updateMany as any).mock.calls[0][0].where;
    expect(where.exportExpiresAt.lt).toEqual(now);
  });
});
