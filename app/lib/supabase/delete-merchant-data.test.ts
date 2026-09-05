import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const configUpdate = vi.fn();
const configDeleteMany = vi.fn();
const tokenDeleteMany = vi.fn();
const shopUpdate = vi.fn();
const resourceFindMany = vi.fn();
const resourceDeleteMany = vi.fn();
const deletionCreate = vi.fn();
const deletionUpdate = vi.fn();
const runQuery = vi.fn();
const runQueryRows = vi.fn();
const clearShopStatsCache = vi.fn();

// Il lucchetto vero e' una riga su Postgres: qui si simula solo la domanda che
// conta — l'ho preso o no? Il `lease` che si passa al lavoro e' quello che il
// DROP interroga un istante prima di partire.
let lockFree = true;
const runWithShopLease = vi.fn(
  async (_shopId: string, run: (lease: unknown) => Promise<void>) => {
    if (!lockFree) return 'occupato';
    lockFree = false;
    try {
      await run({ shopId: _shopId, assertHeld: async () => undefined });
    } finally {
      lockFree = true;
    }
    return 'eseguito';
  },
);

vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      findUnique: (...a: unknown[]) => findUniqueShop(...a),
      update: (...a: unknown[]) => shopUpdate(...a),
    },
    supabaseConfig: {
      update: (...a: unknown[]) => configUpdate(...a),
      deleteMany: (...a: unknown[]) => configDeleteMany(...a),
    },
    supabaseOAuthToken: { deleteMany: (...a: unknown[]) => tokenDeleteMany(...a) },
    supabaseManagedResource: {
      findMany: (...a: unknown[]) => resourceFindMany(...a),
      deleteMany: (...a: unknown[]) => resourceDeleteMany(...a),
    },
    supabaseDataDeletion: {
      create: (...a: unknown[]) => deletionCreate(...a),
      update: (...a: unknown[]) => deletionUpdate(...a),
    },
  },
}));
vi.mock('~/lib/supabase-oauth.server', () => ({
  getValidAccessToken: async () => 'token-supabase',
}));
vi.mock('~/lib/supabase-management.server', () => ({
  runQuery: (...a: unknown[]) => runQuery(...a),
  runQueryRows: (...a: unknown[]) => runQueryRows(...a),
}));
vi.mock('~/lib/queue/shop-lock.server', () => ({
  runWithShopLease: (...a: [string, (lease: unknown) => Promise<void>]) =>
    runWithShopLease(...a),
}));
vi.mock('~/lib/cache/stats-cache.server', () => ({
  clearShopStatsCache: (...a: unknown[]) => clearShopStatsCache(...a),
}));

import { deleteMerchantData } from './delete-merchant-data.server';

const SHOP = {
  id: 'shop-1',
  shopDomain: 'test-shop.myshopify.com',
  supabaseConfig: {
    shopId: 'shop-1',
    supabaseUrl: 'https://abcdefgh.supabase.co',
    supabaseProjectRef: 'abcdefgh',
    tableNameProducts: 'products',
    tableNameCustomers: 'customers',
  },
};

/** Il registro di un'installazione completa: tutte e cinque create da noi. */
function ownedRows(names: string[]) {
  return names.map((resourceName, i) => ({
    id: `res-${i}`,
    shopId: 'shop-1',
    projectRef: 'abcdefgh',
    schemaName: 'public',
    resourceName,
    resourceKind: 'table',
    createdByCoreWard: true,
    schemaVersion: 9,
  }));
}

const ALL_FIVE = ['products', 'users', 'customers', 'orders', 'order_lines'];

function dropSQL(): string {
  return runQuery.mock.calls[0]?.[2] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  lockFree = true;
  findUniqueShop.mockResolvedValue({ ...SHOP });
  resourceFindMany.mockResolvedValue(ownedRows(ALL_FIVE));
  configUpdate.mockResolvedValue({});
  configDeleteMany.mockResolvedValue({ count: 1 });
  tokenDeleteMany.mockResolvedValue({ count: 1 });
  resourceDeleteMany.mockResolvedValue({ count: 5 });
  shopUpdate.mockResolvedValue({});
  deletionCreate.mockResolvedValue({ id: 'del-1' });
  deletionUpdate.mockResolvedValue({});
  runQuery.mockResolvedValue(undefined);
  // Verifica: nessuna tabella superstite.
  runQueryRows.mockResolvedValue([]);
  clearShopStatsCache.mockResolvedValue(undefined);
});

describe('installazione completa', () => {
  it('elimina tutte e cinque le tabelle, non due', () => {
    // Il guasto d'origine: il DROP conosceva `products` e `customers` e basta,
    // mentre l'app crea anche `users`, `orders` e `order_lines`. Restavano nel
    // database del merchant dopo che l'app aveva dichiarato di averle tolte.
    return deleteMerchantData('shop-1').then((result) => {
      expect(result.status).toBe('completed');
      for (const name of ALL_FIVE) {
        expect(dropSQL()).toContain(`DROP TABLE IF EXISTS "public"."${name}";`);
      }
    });
  });

  it('un DROP solo, dentro una transazione', async () => {
    await deleteMerchantData('shop-1');

    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(dropSQL().startsWith('BEGIN;')).toBe(true);
    expect(dropSQL().endsWith('COMMIT;')).toBe(true);
  });

  it('il collegamento si spegne PRIMA del DDL', async () => {
    // `connectionVerifiedAt` e' l'interruttore che guardano corsa periodica,
    // coda e webhook: azzerarlo prima e' cio' che impedisce a una scrittura di
    // arrivare su una tabella che sta cadendo.
    const order: string[] = [];
    configUpdate.mockImplementation(async () => {
      order.push('spegni');
      return {};
    });
    runQuery.mockImplementation(async () => {
      order.push('drop');
    });

    await deleteMerchantData('shop-1');

    expect(order).toEqual(['spegni', 'drop']);
    expect(configUpdate).toHaveBeenCalledWith({
      where: { shopId: 'shop-1' },
      data: { connectionVerifiedAt: null },
    });
  });

  it('token e configurazione se ne vanno solo DOPO la verifica', async () => {
    const order: string[] = [];
    runQueryRows.mockImplementation(async () => {
      order.push('verifica');
      return [];
    });
    tokenDeleteMany.mockImplementation(async () => {
      order.push('token via');
      return { count: 1 };
    });
    configDeleteMany.mockImplementation(async () => {
      order.push('config via');
      return { count: 1 };
    });

    await deleteMerchantData('shop-1');

    expect(order).toEqual(['verifica', 'token via', 'config via']);
  });

  it('a fine corsa lo stato e completed e la cache e stata svuotata', async () => {
    await deleteMerchantData('shop-1');

    expect(deletionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'del-1' },
        data: expect.objectContaining({ status: 'completed' }),
      }),
    );
    expect(clearShopStatsCache).toHaveBeenCalledWith('shop-1');
    expect(shopUpdate).toHaveBeenCalledWith({
      where: { id: 'shop-1' },
      data: { setupCompletedAt: null },
    });
  });
});

describe('cosa NON e nostro non si tocca', () => {
  it('una tabella preesistente del merchant resta dov e', async () => {
    // `products` c'era gia' col suo catalogo dentro: al collegamento e' stata
    // registrata come sua. Un nome configurato non e' una prova di proprieta'.
    resourceFindMany.mockResolvedValue(ownedRows(['users', 'orders', 'order_lines']));

    const result = await deleteMerchantData('shop-1');

    expect(result.status).toBe('completed');
    expect(dropSQL()).not.toContain('"products"');
    expect(dropSQL()).not.toContain('"customers"');
    expect(dropSQL()).toContain('"users"');
  });

  it('il registro viene interrogato con createdByCoreWard true', async () => {
    await deleteMerchantData('shop-1');

    expect(resourceFindMany).toHaveBeenCalledWith({
      where: { shopId: 'shop-1', projectRef: 'abcdefgh', createdByCoreWard: true },
    });
  });

  it('registro vuoto: non si elimina niente e non si inventa niente', async () => {
    // La lettura conservativa. Eliminare "quello che di solito creiamo" su un
    // database dove non risulta che l'abbiamo creato noi e' l'errore da cui
    // tutto questo nasce.
    resourceFindMany.mockResolvedValue([]);

    const result = await deleteMerchantData('shop-1');

    expect(result.status).toBe('nothing_owned');
    expect(runQuery).not.toHaveBeenCalled();
    expect(configUpdate).not.toHaveBeenCalled();
  });
});

describe('identificatori malformati', () => {
  it('si fermano prima del DDL, e non si ritentano', async () => {
    resourceFindMany.mockResolvedValue(
      ownedRows(['products"; DROP TABLE fatture; --']),
    );

    const result = await deleteMerchantData('shop-1');

    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(false);
    expect(runQuery).not.toHaveBeenCalled();
    // Nemmeno il collegamento e' stato spento: non e' successo niente.
    expect(configUpdate).not.toHaveBeenCalled();
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(configDeleteMany).not.toHaveBeenCalled();
  });
});

describe('quando qualcosa va storto', () => {
  it('DROP rifiutato: token e configurazione restano, stato failed, ritentabile', async () => {
    // Postgres dentro a un BEGIN trasforma il COMMIT in ROLLBACK: il database
    // del merchant e' come prima, per intero.
    runQuery.mockRejectedValue(new Error('Supabase query error: 400 — permission denied'));

    const result = await deleteMerchantData('shop-1');

    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(true);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(configDeleteMany).not.toHaveBeenCalled();
    expect(shopUpdate).not.toHaveBeenCalled();
    expect(deletionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  it('la verifica trova una tabella ancora viva: non e un successo', async () => {
    // La Management API risponde 2xx all'SQL eseguito, non all'esito che ci
    // aspettavamo, e un DROP con IF EXISTS non protesta mai. L'unica prova che
    // le tabelle non ci sono piu' e' andarle a cercare.
    runQueryRows.mockResolvedValue([{ table_schema: 'public', table_name: 'orders' }]);

    const result = await deleteMerchantData('shop-1');

    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(true);
    expect(result.remaining).toEqual(['"public"."orders"']);
    expect(tokenDeleteMany).not.toHaveBeenCalled();
    expect(configDeleteMany).not.toHaveBeenCalled();
  });

  it('verifica irraggiungibile: non sapere non e sapere di si', async () => {
    runQueryRows.mockRejectedValue(new Error('fetch failed'));

    const result = await deleteMerchantData('shop-1');

    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(true);
    expect(configDeleteMany).not.toHaveBeenCalled();
  });

  it('senza ref del progetto non si afferma niente', async () => {
    findUniqueShop.mockResolvedValue({
      ...SHOP,
      supabaseConfig: {
        ...SHOP.supabaseConfig,
        supabaseProjectRef: null,
        supabaseUrl: 'https://esempio.example.com',
      },
    });

    const result = await deleteMerchantData('shop-1');

    expect(result.status).toBe('failed');
    expect(runQuery).not.toHaveBeenCalled();
    expect(configDeleteMany).not.toHaveBeenCalled();
  });

  it('il ref si ricava dall URL quando manca la colonna', async () => {
    findUniqueShop.mockResolvedValue({
      ...SHOP,
      supabaseConfig: { ...SHOP.supabaseConfig, supabaseProjectRef: null },
    });

    const result = await deleteMerchantData('shop-1');

    expect(result.status).toBe('completed');
    expect(runQuery.mock.calls[0][1]).toBe('abcdefgh');
  });
});

describe('due richieste insieme', () => {
  it('una sola tiene il lucchetto, e l altra non ripete niente', async () => {
    let sbloccaPrima: () => void = () => undefined;
    let dropIniziato: () => void = () => undefined;
    const alDrop = new Promise<void>((resolve) => (dropIniziato = resolve));
    runQuery.mockImplementation(() => {
      dropIniziato();
      return new Promise<void>((resolve) => (sbloccaPrima = resolve));
    });

    const prima = deleteMerchantData('shop-1');
    await alDrop;
    // La seconda arriva mentre la prima e' ferma dentro al DROP.
    const seconda = await deleteMerchantData('shop-1');

    expect(seconda.status).toBe('already_running');
    expect(runQuery).toHaveBeenCalledTimes(1);

    sbloccaPrima();
    expect((await prima).status).toBe('completed');
    // Un solo giro di cancellazioni: la seconda non ha toccato niente.
    expect(configDeleteMany).toHaveBeenCalledTimes(1);
    expect(deletionCreate).toHaveBeenCalledTimes(1);
  });
});
