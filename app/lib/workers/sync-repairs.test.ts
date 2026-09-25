import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Il guasto che questo file difende, in una riga: una corsa che ignorava un
 * errore si dichiarava completata, e la corsa dopo ripartiva da li'.
 *
 * Il seguito non si vedeva il giorno stesso. Il confine incrementale della
 * corsa successiva si calcolava dall'ultima corsa completata, quindi passava
 * sopra la risorsa che nessuno era riuscito a scrivere. Se su Shopify quella
 * risorsa non veniva piu' toccata — ed e' il caso normale per un prodotto fermo
 * a catalogo — non tornava nel delta mai piu': il difetto diventava permanente,
 * e l'unico modo di accorgersene era leggere un avviso in un log.
 *
 * Ogni prova qui sotto inietta un fallimento in un punto diverso e chiede la
 * stessa cosa: che il confine non scavalchi la risorsa, e che di quella risorsa
 * resti scritto qualcosa.
 */

/**
 * Una scrittura che si esegue solo quando qualcuno l'aspetta.
 *
 * Serve a riprodurre la cosa giusta: le operazioni di Prisma dentro una
 * transazione non partono quando le si costruisce, partono al commit. Con un
 * mock che esegue subito, "il processo muore un istante prima del commit"
 * sarebbe indistinguibile da "il commit e' avvenuto" — cioe' proprio il caso
 * che qui si vuole poter distinguere.
 */
const pigra = vi.hoisted(
  () =>
    <T,>(esegui: () => T) => ({ then: (risolvi: (v: T) => void) => risolvi(esegui()) }),
);

const stato = vi.hoisted(() => ({
  /** Le riparazioni gia' aperte per il negozio. */
  aperte: [] as Record<string, unknown>[],
  /** Le upsert di riparazione arrivate alla transazione di chiusura. */
  scritte: [] as Record<string, unknown>[],
  /** Le chiusure di riparazione. */
  chiuse: [] as Record<string, unknown>[],
  /** Gli aggiornamenti sul registro delle corse. */
  corse: [] as Record<string, unknown>[],
  /** Quante transazioni di chiusura sono state eseguite. */
  transazioni: 0,
  /** Se la transazione di chiusura deve fallire (il crash a un passo dal commit). */
  transazioneRotta: false,
}));

vi.mock('../../db.server', () => ({
  prisma: {
    shop: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
    syncJob: {
      create: vi.fn(async () => ({ id: 'job-1' })),
      update: vi.fn((args: { data: Record<string, unknown> }) =>
        pigra(() => {
          stato.corse.push(args.data);
          return {};
        }),
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    syncJobEvent: {
      createMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    // Il registro dell'ambito: quali prodotti continuano ad aggiornarsi e
    // quali sono fermi per il tetto del piano. Qui e' vuoto e non oppone
    // resistenza; cosa ci finisca dentro lo provano i test dedicati
    // (product-scope.test.ts e plan-scope.test.ts).
    productScopeEntry: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    syncRepair: {
      findMany: vi.fn(async () => stato.aperte),
      upsert: vi.fn((args: { create: Record<string, unknown> }) =>
        pigra(() => {
          stato.scritte.push(args.create);
          return {};
        }),
      ),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        stato.chiuse.push(args.data);
        return {};
      }),
      updateMany: vi.fn((args: { where: Record<string, unknown> }) =>
        pigra(() => {
          stato.chiuse.push(args.where);
          return { count: 1 };
        }),
      ),
      groupBy: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    $transaction: vi.fn(async (ops: unknown[]) => {
      if (stato.transazioneRotta) throw new Error('commit del confine non riuscito');
      stato.transazioni++;
      return Promise.all(ops as Promise<unknown>[]);
    }),
    plan: { findFirst: vi.fn(async () => ({ maxProducts: null, customersSyncEnabled: true })) },
  },
}));

vi.mock('../../utils/crypto.server', () => ({ decrypt: (v: string) => `decrypted_${v}` }));

vi.mock('../shopify-api.server', () => {
  const ctor = vi.fn();
  return {
    ShopifyAPIClient: Object.assign(ctor, {
      forShop: vi.fn(async (shop: string) => new (ctor as any)(shop)),
    }),
  };
});

vi.mock('../supabase.server', () => ({ createSupabaseClient: vi.fn() }));
vi.mock('../stats/inventory-cost.server', () => ({
  enrichVariantCosts: vi.fn(async (_c: unknown, p: unknown) => p),
}));
vi.mock('../supabase/ensure-customers-table.server', () => ({
  ensureCustomersTable: vi.fn(async () => ({ status: 'already_present', empty: false })),
}));
vi.mock('../supabase/ensure-products-table.server', () => ({
  ensureProductsTable: vi.fn(async () => ({ status: 'already_present', empty: false })),
}));
vi.mock('../supabase/apply-schema-update.server', () => ({
  applyMerchantSchemaUpdate: vi.fn(async () => ({})),
}));
vi.mock('../transformers/product.server', () => ({
  transformProduct: (p: { id: number; variants: { id: number }[] }) =>
    p.variants.map((v) => ({
      shopify_product_id: p.id,
      shopify_variant_id: v.id,
      cost_per_item: '1.00',
      product_title: 'x',
    })),
}));
vi.mock('../transformers/customer.server', () => ({
  transformCustomer: (c: { id: number }) => ({ shopify_customer_id: c.id }),
}));

import { processInitialBulkSync, processPeriodicSyncCheck } from './processors.server';
import { ShopifyAPIClient } from '../shopify-api.server';
import { createSupabaseClient } from '../supabase.server';
import { prisma } from '../../db.server';

const COLLEGAMENTO = new Date('2026-01-01T00:00:00Z');
const CONFINE_PRECEDENTE = new Date('2026-03-01T10:00:00Z');
/** Il prodotto e' stato toccato DENTRO la finestra di questa corsa. */
const MODIFICA = '2026-03-01T10:30:00Z';

interface FintoDb {
  /** Su quali operazioni rispondere con un errore. */
  rompi?: Partial<Record<'productUpsert' | 'orphanDelete' | 'revoke' | 'customerUpsert', string>>;
  /** Le varianti gia' presenti per il prodotto. */
  esistenti?: number[];
}

function supabaseFinto(opts: FintoDb = {}) {
  const upsertate: unknown[][] = [];
  const rompi = opts.rompi ?? {};

  const client = {
    from: () => ({
      select: () => ({
        eq: async () => ({
          data: (opts.esistenti ?? []).map((id) => ({ shopify_variant_id: id })),
          error: null,
        }),
        in: async () => ({ data: [], error: null }),
        range: async () => ({ data: [], error: null }),
      }),
      upsert: async (rows: unknown[]) => {
        const chiaviCliente =
          Array.isArray(rows) && rows.some((r) => 'shopify_customer_id' in (r as object));
        const errore = chiaviCliente ? rompi.customerUpsert : rompi.productUpsert;
        if (errore) return { error: { message: errore } };
        upsertate.push(rows);
        return { error: null };
      },
      update: () => ({
        in: async () => ({ error: rompi.revoke ? { message: rompi.revoke } : null }),
        select: async () => ({
          data: [],
          error: rompi.revoke ? { message: rompi.revoke } : null,
        }),
      }),
      delete: () => ({
        eq: () => ({
          in: async () => ({ error: rompi.orphanDelete ? { message: rompi.orphanDelete } : null }),
          is: async () => ({ error: null }),
        }),
        lt: async () => ({ error: null }),
      }),
    }),
  };

  return { client, upsertate };
}

function negozio(over: Record<string, unknown> = {}) {
  return {
    id: 'shop-1',
    shopDomain: 'test.myshopify.com',
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products,read_customers',
    currentPlan: 'Growth',
    isInTrial: false,
    trialEndsAt: null,
    activeChargeId: 'ch-1',
    accessToken: 'tok',
    supabaseConfig: {
      connectionVerifiedAt: COLLEGAMENTO,
      tableNameProducts: 'products',
      tableNameCustomers: 'customers',
      supabaseUrl: 'https://x.supabase.co',
      supabaseServiceRoleKey: 'k',
      updatedAt: COLLEGAMENTO,
    },
    ...over,
  };
}

function shopify(over: Record<string, unknown> = {}) {
  (ShopifyAPIClient as any).mockImplementation(() => ({
    getProducts: vi.fn(async () => ({ products: [], nextPageInfo: null })),
    getCustomers: vi.fn(async () => ({ customers: [], nextPageInfo: null })),
    ...over,
  }));
}

/** Il confine scritto dalla corsa, o `undefined` se non ne ha scritto nessuno. */
function confineScritto(): Date | undefined {
  const chiusura = stato.corse.find((c) => c.watermarkAt !== undefined);
  return chiusura?.watermarkAt as Date | undefined;
}

function riparazione(risorsa: string, operazione: string) {
  return stato.scritte.find(
    (r) => r.resourceId === risorsa && r.operation === operazione,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stato.aperte = [];
  stato.scritte = [];
  stato.chiuse = [];
  stato.corse = [];
  stato.transazioni = 0;
  stato.transazioneRotta = false;

  (prisma.shop.findUnique as any).mockResolvedValue(negozio());
  (prisma.syncJob.findFirst as any).mockResolvedValue({ watermarkAt: CONFINE_PRECEDENTE });
  (prisma.syncJob.create as any).mockResolvedValue({ id: 'job-1' });
});

describe('un upsert di prodotto che fallisce', () => {
  it('lascia una riparazione e tiene il confine indietro fino alla modifica', async () => {
    const db = supabaseFinto({ rompi: { productUpsert: 'permission denied' } });
    (createSupabaseClient as any).mockReturnValue(db.client);
    shopify({
      getProducts: vi.fn(async () => ({
        products: [
          {
            id: 77,
            variants_complete: true,
            updated_at: MODIFICA,
            variants: [{ id: 771 }],
          },
        ],
        nextPageInfo: null,
      })),
    });

    await processPeriodicSyncCheck('shop-1');

    const riga = riparazione('77', 'upsert');
    expect(riga).toBeTruthy();
    expect(riga?.resourceType).toBe('product');
    expect(riga?.sourceUpdatedAt).toEqual(new Date(MODIFICA));

    // La prova che conta: il confine si ferma alla modifica del prodotto, non
    // all'inizio della corsa. Cosi' la corsa dopo, chiedendo "cosa e' cambiato
    // da li' in poi", questo prodotto se lo ritrova davanti.
    expect(confineScritto()).toEqual(new Date(MODIFICA));
  });

  it('non conta fra i sincronizzati il prodotto che non e\' stato scritto', async () => {
    const db = supabaseFinto({ rompi: { productUpsert: 'permission denied' } });
    (createSupabaseClient as any).mockReturnValue(db.client);
    shopify({
      getProducts: vi.fn(async () => ({
        products: [
          { id: 77, variants_complete: true, updated_at: MODIFICA, variants: [{ id: 771 }] },
        ],
        nextPageInfo: null,
      })),
    });

    await processPeriodicSyncCheck('shop-1');

    const chiusura = stato.corse.find((c) => c.watermarkAt !== undefined);
    // I contatori sono un rendiconto di operazioni commesse, non di tentativi.
    expect(chiusura?.productsSynced).toBe(0);
    expect(chiusura?.variantsSynced).toBe(0);
    expect(chiusura?.status).toBe('completed_with_repairs');
  });

  it('alla corsa dopo il prodotto rientra nel delta e la riparazione si chiude', async () => {
    // Il caso peggiore del guasto vecchio: una risorsa modificata UNA VOLTA
    // SOLA. Su Shopify non cambiera' piu', quindi se il confine la scavalca non
    // torna mai. Qui la corsa successiva la ritrova e la scrive.
    stato.aperte = [
      {
        id: 'r-77',
        resourceType: 'product',
        resourceId: '77',
        operation: 'upsert',
        sourceUpdatedAt: new Date(MODIFICA),
        recoveredByDelta: true,
        attempts: 1,
        nextAttemptAt: COLLEGAMENTO,
        details: null,
        openedByJobId: 'job-0',
      },
    ];

    const db = supabaseFinto();
    (createSupabaseClient as any).mockReturnValue(db.client);
    const getProducts = vi.fn(async () => ({
      products: [
        { id: 77, variants_complete: true, updated_at: MODIFICA, variants: [{ id: 771 }] },
      ],
      nextPageInfo: null,
    }));
    shopify({ getProducts });

    await processPeriodicSyncCheck('shop-1');

    // La finestra parte da prima della modifica: e' il confine trattenuto dalla
    // corsa precedente, meno la sovrapposizione.
    const chiesto = new Date((getProducts.mock.calls[0] as any)[0].updatedAtMin);
    expect(chiesto.getTime()).toBeLessThan(new Date(MODIFICA).getTime());

    expect(stato.chiuse.some((c) => JSON.stringify(c).includes('r-77'))).toBe(true);
    // Niente piu' da aspettare: il confine avanza fino all'inizio di questa corsa.
    expect(confineScritto()!.getTime()).toBeGreaterThan(new Date(MODIFICA).getTime());
  });
});

describe('una cancellazione di varianti orfane che fallisce', () => {
  it('conserva l\'elenco degli id e non lascia avanzare il confine', async () => {
    const db = supabaseFinto({
      rompi: { orphanDelete: 'delete rifiutata' },
      esistenti: [771, 999],
    });
    (createSupabaseClient as any).mockReturnValue(db.client);
    shopify({
      getProducts: vi.fn(async () => ({
        products: [
          { id: 77, variants_complete: true, updated_at: MODIFICA, variants: [{ id: 771 }] },
        ],
        nextPageInfo: null,
      })),
    });

    await processPeriodicSyncCheck('shop-1');

    const riga = riparazione('77', 'delete');
    expect(riga).toBeTruthy();
    expect((riga?.details as { ids: number[] }).ids).toEqual([999]);
    expect(confineScritto()).toEqual(new Date(MODIFICA));
  });
});

describe('una revoca di consenso che fallisce', () => {
  it('lascia una riparazione per ogni cliente, invece di un avviso nel log', async () => {
    // Era il punto peggiore di tutti: da quella colonna dipende il rifiuto di
    // servire i dati di quella persona, quindi il fallimento silenzioso
    // lasciava leggibile un cliente che aveva detto di no.
    const db = supabaseFinto({ rompi: { revoke: 'update rifiutata' } });
    (createSupabaseClient as any).mockReturnValue(db.client);
    shopify({
      getCustomers: vi.fn(async () => ({
        customers: [
          {
            id: 5,
            updated_at: MODIFICA,
            email_marketing_consent: { state: 'unsubscribed' },
          },
        ],
        nextPageInfo: null,
      })),
    });

    await processPeriodicSyncCheck('shop-1');

    const riga = riparazione('5', 'consent_revoke');
    expect(riga).toBeTruthy();
    expect(riga?.resourceType).toBe('customer');
    expect(confineScritto()).toEqual(new Date(MODIFICA));
  });
});

describe('un blocco di clienti che non si scrive', () => {
  it('fa fallire la corsa e lascia il confine dov\'era', async () => {
    // Questo e' l'altro ramo della scelta: un blocco sono fino a mille persone,
    // e mille righe di riparazione costerebbero piu' che rifare la corsa.
    const db = supabaseFinto({ rompi: { customerUpsert: 'connessione caduta' } });
    (createSupabaseClient as any).mockReturnValue(db.client);
    shopify({
      getCustomers: vi.fn(async () => ({
        customers: [
          { id: 5, updated_at: MODIFICA, email_marketing_consent: { state: 'subscribed' } },
        ],
        nextPageInfo: null,
      })),
    });

    await expect(processPeriodicSyncCheck('shop-1')).rejects.toThrow();

    expect(confineScritto()).toBeUndefined();
    expect(stato.corse.some((c) => c.status === 'failed')).toBe(true);
  });
});

describe('la riscrittura della data di nascita', () => {
  it('rifiutata da Shopify, lascia una riparazione ma non blocca la replica', async () => {
    // "Al giro dopo si ritenta" era falso: la corsa successiva legge il delta, e
    // un cliente la cui scrittura NON e' andata non risulta cambiato su
    // Shopify. Senza magazzino d'uscita, quella data non partiva mai piu'.
    const db = supabaseFinto();
    (createSupabaseClient as any).mockReturnValue(db.client);

    const setCustomerBirthdates = vi.fn(async () => ({
      written: 0,
      errors: ['Value is invalid'],
      failed: [{ customerId: 5, reason: 'Value is invalid' }],
    }));

    // Il cliente e' su Shopify senza data, e sul database del merchant con una.
    (createSupabaseClient as any).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: async () => ({ data: [], error: null }),
          in: async () => ({
            data: [{ shopify_customer_id: 5, date_of_birth: '1985-04-23' }],
            error: null,
          }),
          range: async () => ({ data: [], error: null }),
        }),
        upsert: async () => ({ error: null }),
        update: () => ({ in: async () => ({ error: null }), select: async () => ({ data: [], error: null }) }),
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }), is: async () => ({ error: null }) }) }),
      }),
    });

    shopify({
      getCustomers: vi.fn(async () => ({
        customers: [
          { id: 5, updated_at: MODIFICA, email_marketing_consent: { state: 'subscribed' } },
        ],
        nextPageInfo: null,
      })),
      setCustomerBirthdates,
      listCustomerMetafieldDefinitions: vi.fn(async () => []),
    });

    (prisma.shop.findUnique as any).mockResolvedValue(
      negozio({
        scopes: 'read_products,read_customers,write_customers',
        birthdateMetafieldNamespace: 'facts',
        birthdateMetafieldKey: 'birth_date',
      }),
    );

    await processPeriodicSyncCheck('shop-1');

    const riga = riparazione('5', 'birthdate_writeback');
    expect(riga).toBeTruthy();
    expect((riga?.details as { date: string }).date).toBe('1985-04-23');
    // Non torna dal delta: quel campo su Shopify non cambia, quindi non puo'
    // essere il delta a riportarlo.
    expect(riga?.recoveredByDelta).toBe(false);

    // E la replica verso il merchant non e' bloccata: la corsa chiude, e il
    // confine avanza — questa riparazione non trattiene niente perche' non c'e'
    // niente da rileggere.
    expect(confineScritto()).toBeTruthy();
    expect(stato.corse.some((c) => c.status === 'completed_with_repairs')).toBe(true);
  });

  it('rimasta in sospeso, viene rispinta all\'inizio della corsa successiva', async () => {
    stato.aperte = [
      {
        id: 'r-5',
        resourceType: 'customer',
        resourceId: '5',
        operation: 'birthdate_writeback',
        sourceUpdatedAt: null,
        recoveredByDelta: false,
        attempts: 1,
        nextAttemptAt: COLLEGAMENTO,
        details: { date: '1985-04-23' },
        openedByJobId: 'job-0',
      },
    ];

    const setCustomerBirthdates = vi.fn(async () => ({ written: 1, errors: [], failed: [] }));

    (createSupabaseClient as any).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: async () => ({ data: [], error: null }),
          // La data si RILEGGE dal database del merchant: fra il guasto e
          // adesso puo' essere cambiata, e rispingere quella vecchia sarebbe
          // riscrivergli addosso una cosa che aveva gia' corretto.
          in: async () => ({
            data: [{ shopify_customer_id: 5, date_of_birth: '1990-01-01' }],
            error: null,
          }),
          range: async () => ({ data: [], error: null }),
        }),
        upsert: async () => ({ error: null }),
        update: () => ({ in: async () => ({ error: null }), select: async () => ({ data: [], error: null }) }),
        delete: () => ({ eq: () => ({ in: async () => ({ error: null }), is: async () => ({ error: null }) }) }),
      }),
    });

    shopify({ setCustomerBirthdates, listCustomerMetafieldDefinitions: vi.fn(async () => []) });

    (prisma.shop.findUnique as any).mockResolvedValue(
      negozio({
        scopes: 'read_products,read_customers,write_customers',
        birthdateMetafieldNamespace: 'facts',
        birthdateMetafieldKey: 'birth_date',
      }),
    );

    await processPeriodicSyncCheck('shop-1');

    expect(setCustomerBirthdates).toHaveBeenCalledWith(
      [{ customerId: 5, date: '1990-01-01' }],
      expect.anything(),
    );
    expect(stato.chiuse.some((c) => c.status === 'done')).toBe(true);
  });
});

describe('un crash fra la scrittura al merchant e il commit del confine', () => {
  it('non lascia nessun confine, e la corsa dopo rilegge la stessa finestra', async () => {
    const db = supabaseFinto();
    (createSupabaseClient as any).mockReturnValue(db.client);
    shopify({
      getProducts: vi.fn(async () => ({
        products: [
          { id: 77, variants_complete: true, updated_at: MODIFICA, variants: [{ id: 771 }] },
        ],
        nextPageInfo: null,
      })),
    });

    stato.transazioneRotta = true;
    await expect(processPeriodicSyncCheck('shop-1')).rejects.toThrow();

    // Le righe sono state scritte sul database del merchant — sono upsert, e
    // riscriverle identiche alla corsa dopo non fa danno — ma il confine no.
    expect(db.upsertate.length).toBeGreaterThan(0);
    expect(confineScritto()).toBeUndefined();

    // Seconda corsa, stesso confine di partenza: la finestra e' la stessa, e
    // riassorbirla non produce doppioni perche' sono upsert sulla stessa
    // chiave.
    stato.transazioneRotta = false;
    stato.corse = [];
    const secondo = supabaseFinto();
    (createSupabaseClient as any).mockReturnValue(secondo.client);
    const getProducts = vi.fn(async () => ({
      products: [
        { id: 77, variants_complete: true, updated_at: MODIFICA, variants: [{ id: 771 }] },
      ],
      nextPageInfo: null,
    }));
    shopify({ getProducts });

    await processPeriodicSyncCheck('shop-1');

    const chiesto = (getProducts.mock.calls[0] as any)[0].updatedAtMin;
    expect(new Date(chiesto).getTime()).toBe(
      CONFINE_PRECEDENTE.getTime() - 120_000,
    );
    expect(secondo.upsertate[0]).toEqual([
      expect.objectContaining({ shopify_product_id: 77, shopify_variant_id: 771 }),
    ]);
    expect(confineScritto()).toBeTruthy();
  });
});

describe('la finestra di sovrapposizione', () => {
  it('rilegge un pezzo gia\' letto senza creare doppioni', async () => {
    // La sovrapposizione esiste perche' fra due finestre che si toccano c'e'
    // una fessura. Il prezzo e' rileggere qualcosa due volte, e va bene solo
    // finche' riassorbire e' idempotente: la chiave dell'upsert e' la variante,
    // quindi la seconda scrittura e' un aggiornamento a vuoto.
    const db = supabaseFinto();
    (createSupabaseClient as any).mockReturnValue(db.client);
    const prodotto = {
      id: 77,
      variants_complete: true,
      updated_at: CONFINE_PRECEDENTE.toISOString(),
      variants: [{ id: 771 }],
    };
    shopify({ getProducts: vi.fn(async () => ({ products: [prodotto], nextPageInfo: null })) });

    await processPeriodicSyncCheck('shop-1');
    await processPeriodicSyncCheck('shop-1');

    expect(db.upsertate).toHaveLength(2);
    // Due scritture identiche, sulla stessa chiave: una riga sola sul database
    // del merchant.
    expect(db.upsertate[0]).toEqual(db.upsertate[1]);
  });
});

describe('la spazzata di fine corsa completa', () => {
  it('fallita, lascia una riparazione con il suo istante di confine', async () => {
    // "Le righe obsolete verranno rimosse alla corsa successiva" era una
    // speranza senza nessuno che la mantenesse: la corsa successiva puo'
    // benissimo essere una incrementale, che non spazza affatto.
    (createSupabaseClient as any).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: async () => ({ data: [], error: null }),
          in: async () => ({ data: [], error: null }),
          range: async () => ({ data: [], error: null }),
        }),
        upsert: async () => ({ error: null }),
        update: () => ({ in: async () => ({ error: null }), select: async () => ({ data: [], error: null }) }),
        delete: () => ({
          lt: async () => ({ error: { message: 'delete rifiutata' } }),
          eq: () => ({ in: async () => ({ error: null }), is: async () => ({ error: null }) }),
        }),
      }),
    });
    shopify({
      getProducts: vi.fn(async () => ({
        products: [
          { id: 77, variants_complete: true, updated_at: MODIFICA, variants: [{ id: 771 }] },
        ],
        nextPageInfo: null,
      })),
    });

    await processInitialBulkSync('shop-1');

    const riga = riparazione('catalogue', 'sweep');
    expect(riga).toBeTruthy();
    // Con il confine di allora: rieseguirla piu' tardi resta corretto, perche'
    // quel che e' stato scritto dopo non ci ricade sotto.
    expect(typeof (riga?.details as { before: string }).before).toBe('string');
    // Non torna dal delta: la corsa incrementale non spazza.
    expect(riga?.recoveredByDelta).toBe(false);
  });

  it('rimasta in sospeso, viene rigiocata prima di riscrivere qualunque cosa', async () => {
    const confineDiAllora = '2026-02-01T00:00:00.000Z';
    stato.aperte = [
      {
        id: 'r-sweep',
        resourceType: 'product',
        resourceId: 'catalogue',
        operation: 'sweep',
        sourceUpdatedAt: null,
        recoveredByDelta: false,
        attempts: 1,
        nextAttemptAt: COLLEGAMENTO,
        details: { before: confineDiAllora },
        openedByJobId: 'job-0',
      },
    ];

    const soglie: string[] = [];
    (createSupabaseClient as any).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: async () => ({ data: [], error: null }),
          in: async () => ({ data: [], error: null }),
          range: async () => ({ data: [], error: null }),
        }),
        upsert: async () => ({ error: null }),
        update: () => ({ in: async () => ({ error: null }), select: async () => ({ data: [], error: null }) }),
        delete: () => ({
          lt: async (_col: string, valore: string) => {
            soglie.push(valore);
            return { error: null };
          },
          eq: () => ({ in: async () => ({ error: null }), is: async () => ({ error: null }) }),
        }),
      }),
    });
    shopify({ getProducts: vi.fn(async () => ({ products: [], nextPageInfo: null })) });

    await processInitialBulkSync('shop-1');

    expect(soglie[0]).toBe(confineDiAllora);
    expect(stato.chiuse.some((c) => c.status === 'done')).toBe(true);
  });
});
