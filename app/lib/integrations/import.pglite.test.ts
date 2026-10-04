/**
 * Un import interrotto e ripreso, provato su un Postgres vero.
 *
 * LA PROMESSA. Un giro si puo' fermare dopo qualunque pagina (tempo finito,
 * deploy, coda che restituisce l'item) e riprendere dall'ultima pagina chiusa:
 * nessun conflitto doppio, nessuna doppia scrittura su Shopify, contatori che
 * si sommano invece di ripartire o raddoppiare.
 *
 * Qui girano le tabelle vere dell'app (la migrazione delle integrazioni) e
 * l'SQL vero dell'import: la lettura dei conflitti con `ANY(...::bigint[])` e
 * l'upsert che riapre una decisione solo se il valore di Klaviyo e' cambiato.
 * Prisma e' un sottile adattatore su PGlite che esegue le query cosi' come
 * l'import le scrive. Klaviyo, Shopify e il database del merchant sono finti:
 * qui conta la ripresa, non l'abbinamento. PGlite e' Postgres in WebAssembly,
 * in memoria e usa e getta.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => ({
  db: null as any,
  shop: null as Record<string, unknown> | null,
  customers: [] as Array<Record<string, unknown>>,
}));

/** Il tagged template di Prisma in una query con parametri posizionali. */
function sqlOf(strings: TemplateStringsArray, values: unknown[]) {
  return {
    text: strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), ''),
    values,
  };
}

const RUN_COLUMNS: Record<string, string> = {
  id: 'id',
  shopId: 'shop_id',
  provider: 'provider',
  status: 'status',
  cursor: 'cursor',
  counters: 'counters',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

function runFromRow(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(RUN_COLUMNS).map(([k, col]) => [k, row[col]]));
}

function runParams(data: Record<string, unknown>) {
  const cols: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(data)) {
    cols.push(RUN_COLUMNS[k]);
    values.push(k === 'counters' ? JSON.stringify(v) : v);
  }
  return { cols, values };
}

vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: async () => h.shop },
    integrationFieldMapping: {
      findUnique: async ({ where }: any) => {
        const w = where.shopId_provider_targetField;
        const { rows } = await h.db.query(
          `SELECT source_key, date_format, target_field FROM integration_field_mappings
            WHERE shop_id = $1 AND provider = $2 AND target_field = $3`,
          [w.shopId, w.provider, w.targetField],
        );
        const r = rows[0];
        return r ? { sourceKey: r.source_key, dateFormat: r.date_format, targetField: r.target_field } : null;
      },
    },
    integrationImportRun: {
      findUnique: async ({ where }: any) => {
        const { rows } = await h.db.query(`SELECT * FROM integration_import_runs WHERE id = $1`, [where.id]);
        return runFromRow(rows[0]);
      },
      create: async ({ data }: any) => {
        const { cols, values } = runParams({ id: randomUUID(), ...data });
        const { rows } = await h.db.query(
          `INSERT INTO integration_import_runs (${cols.join(', ')})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          values,
        );
        return runFromRow(rows[0]);
      },
      update: async ({ where, data }: any) => {
        const { cols, values } = runParams(data);
        const { rows } = await h.db.query(
          `UPDATE integration_import_runs SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}
            WHERE id = $${cols.length + 1} RETURNING *`,
          [...values, where.id],
        );
        return runFromRow(rows[0]);
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = sqlOf(strings, values);
      return (await h.db.query(q.text, q.values)).rows;
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = sqlOf(strings, values);
      return (await h.db.query(q.text, q.values)).affectedRows ?? 0;
    },
  },
}));

vi.mock('~/lib/billing/find-plan.server', () => ({
  findPlanByName: vi.fn(async () => ({ customersSyncEnabled: true, maxCustomers: null })),
}));
vi.mock('~/lib/integrations/connections.server', () => ({
  getAccessToken: vi.fn(async () => 'tok'),
  markNeedsReconnect: vi.fn(),
  connectionStatus: vi.fn(async () => ({ status: 'connected', accountName: 'Acme' })),
}));
vi.mock('~/lib/integrations/klaviyo/api.server', async (orig) => ({
  ...(await orig<typeof import('~/lib/integrations/klaviyo/api.server')>()),
  listProfiles: vi.fn(),
}));
vi.mock('~/lib/shopify-api.server', () => ({ ShopifyAPIClient: { forShop: vi.fn() } }));
vi.mock('~/lib/workers/processors.server', () => ({
  resolveBirthdateTarget: vi.fn(async () => ({ namespace: 'facts', key: 'birth_date', type: 'date' })),
}));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn(() => ({})) }));
vi.mock('~/lib/limits/customer-limit.server', () => ({
  loadCustomerQuota: vi.fn(async () => ({
    ok: true,
    quota: { admit: () => true, chosenIds: () => [], remaining: () => null },
  })),
}));
vi.mock('~/lib/gdpr/paged-read', () => ({
  readAllByIn: vi.fn(),
  drainPages: vi.fn(async () => ({ rows: h.customers, keys: [], error: null, expected: null })),
}));
vi.mock('~/lib/queue/queue-store.server', () => ({ enqueueSyncRequest: vi.fn() }));
vi.mock('~/lib/queue/trigger.server', () => ({ triggerSyncDrain: vi.fn() }));

import { processIntegrationImport } from './import.server';
import { listProfiles } from '~/lib/integrations/klaviyo/api.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';

const MIGRATION = readFileSync(
  join(process.cwd(), 'prisma/migrations/20261003120000_integrations/migration.sql'),
  'utf8',
);

const PAGINA_2 = 'https://a.klaviyo.com/api/profiles?page%5Bcursor%5D=due';

const profilo = (id: string, email: string, birthday: string) => ({
  id,
  email,
  phone: null,
  countryCode: null,
  shopifyCustomerId: null,
  properties: { birthday },
});

const cliente = (id: number, email: string, dob: string | null) => ({
  id: `uuid-${id}`,
  shopify_customer_id: id,
  email_address: email,
  phone_number: null,
  country_code: 'IT',
  date_of_birth: dob,
  created_at: `2024-01-0${id}T00:00:00`,
});

// Pagina 1: un campo vuoto (si riempie) e un valore diverso (conflitto).
// Pagina 2: un altro campo vuoto e un altro conflitto, piu' un valore uguale.
const PAGINE: Record<string, { profiles: ReturnType<typeof profilo>[]; next: string | null }> = {
  primo: {
    profiles: [profilo('k1', 'uno@x.it', '1985-04-23'), profilo('k2', 'due@x.it', '1981-01-01')],
    next: PAGINA_2,
  },
  [PAGINA_2]: {
    profiles: [
      profilo('k3', 'tre@x.it', '1990-07-07'),
      profilo('k4', 'quattro@x.it', '1972-03-03'),
      profilo('k5', 'cinque@x.it', '1966-06-06'),
    ],
    next: null,
  },
};

const setCustomerBirthdates = vi.fn();
const pagineLette: Array<string | null> = [];

async function nuovoGiro(): Promise<string> {
  const id = randomUUID();
  await h.db.query(
    `INSERT INTO integration_import_runs (id, shop_id, provider, status, counters)
     VALUES ($1, 'shop-1', 'klaviyo', 'running', '{}')`,
    [id],
  );
  return id;
}

async function giro(id: string) {
  const { rows } = await h.db.query(`SELECT * FROM integration_import_runs WHERE id = $1`, [id]);
  return rows[0];
}

async function conflitti() {
  const { rows } = await h.db.query(
    `SELECT shopify_customer_id::int AS cliente, our_value, their_value, status,
            to_char(decided_at, 'YYYY-MM-DD HH24:MI') AS decided_at
       FROM integration_conflicts ORDER BY shopify_customer_id`,
  );
  return rows;
}

const scritti = () =>
  setCustomerBirthdates.mock.calls.flatMap((c) => c[0] as Array<{ customerId: number; date: string }>);

beforeEach(async () => {
  vi.clearAllMocks();
  pagineLette.length = 0;
  h.db = new PGlite();
  // La tabella dei negozi ridotta all'osso: la migrazione vi aggancia le FK.
  await h.db.exec(`CREATE TABLE shops (id TEXT PRIMARY KEY);
    INSERT INTO shops (id) VALUES ('shop-1');`);
  await h.db.exec(MIGRATION);
  await h.db.query(
    `INSERT INTO integration_field_mappings (id, shop_id, provider, source_key, target_field, date_format)
     VALUES ($1, 'shop-1', 'klaviyo', 'birthday', 'birthdate', 'auto')`,
    [randomUUID()],
  );
  h.shop = {
    id: 'shop-1',
    shopDomain: 'acme.myshopify.com',
    currentPlan: 'Core',
    scopes: 'read_customers,write_customers',
    birthdateMetafieldNamespace: 'facts',
    birthdateMetafieldKey: 'birth_date',
    supabaseConfig: { tableNameCustomers: 'customers' },
  };
  h.customers = [
    cliente(1, 'uno@x.it', null),
    cliente(2, 'due@x.it', '19800505'),
    cliente(3, 'tre@x.it', null),
    cliente(4, 'quattro@x.it', '19700101'),
    cliente(5, 'cinque@x.it', '19660606'),
  ];
  setCustomerBirthdates.mockImplementation(async (entries: unknown[]) => ({
    written: entries.length,
    errors: [],
    failed: [],
  }));
  (ShopifyAPIClient.forShop as any).mockResolvedValue({ setCustomerBirthdates });
  (listProfiles as any).mockImplementation(async (_t: string, cursor: string | null) => {
    pagineLette.push(cursor);
    return PAGINE[cursor ?? 'primo'];
  });
});

const ATTESI = {
  matchedById: 0,
  matchedByEmail: 5,
  matchedByPhone: 0,
  filled: 2,
  same: 1,
  conflicts: 2,
  decided: 0,
  skippedNoMatch: 0,
  skippedAmbiguous: 0,
  unreadable: 0,
  notWritten: 0,
};

const CONFLITTI_ATTESI = [
  { cliente: 2, our_value: '1980-05-05', their_value: '1981-01-01', status: 'open', decided_at: null },
  { cliente: 4, our_value: '1970-01-01', their_value: '1972-03-03', status: 'open', decided_at: null },
];

// PGlite carica il suo WASM al primo uso: sulla macchina di build i 5 s di
// default non bastano al primo test.
describe('import interrotto e ripreso su Postgres', { timeout: 30_000 }, () => {
  it('fermo per tempo dopo la pagina 1, ripreso col cursore: contatori sommati, nessun doppione', async () => {
    const runId = await nuovoGiro();
    let adesso = 0;
    const continuazioni: Array<[string, string]> = [];

    const prima = await processIntegrationImport('shop-1', {
      cursor: null,
      runId,
      lease: { assertHeld: async () => undefined },
      saveCursor: async (cursor: string, id: string) => {
        continuazioni.push([cursor, id]);
      },
      // Ogni lettura dell'orologio avanza di 50 s: dopo la pagina 1 ne restano 5.
      budgetMs: 55_000,
      clock: () => (adesso += 50_000),
    } as any);

    expect(prima).toBe('paused');
    expect(continuazioni).toEqual([[PAGINA_2, runId]]);
    const aMeta = await giro(runId);
    expect(aMeta.status).toBe('running');
    expect(aMeta.cursor).toBe(PAGINA_2);
    expect(aMeta.counters).toMatchObject({ filled: 1, conflicts: 1, matchedByEmail: 2 });

    // La continuazione accodata riparte dal cursore che le e' stato passato.
    const seconda = await processIntegrationImport('shop-1', {
      cursor: continuazioni[0][0],
      runId: continuazioni[0][1],
      lease: { assertHeld: async () => undefined },
      saveCursor: async () => undefined,
    });

    expect(seconda).toBe('completed');
    expect(pagineLette).toEqual([null, PAGINA_2]);
    const finito = await giro(runId);
    expect(finito.status).toBe('completed');
    expect(finito.finished_at).toBeInstanceOf(Date);
    expect(finito.counters).toEqual(ATTESI);
    expect(await conflitti()).toEqual(CONFLITTI_ATTESI);
    expect(scritti()).toEqual([
      { customerId: 1, date: '1985-04-23' },
      { customerId: 3, date: '1990-07-07' },
    ]);
  });

  it('item restituito dalla coda (payload senza cursore): riprende dal cursore salvato sul giro', async () => {
    const runId = await nuovoGiro();
    const controller = new AbortController();
    (listProfiles as any).mockImplementationOnce(async (_t: string, cursor: string | null) => {
      pagineLette.push(cursor);
      // Lo spegnimento arriva mentre la pagina 1 e' in lettura.
      controller.abort();
      return PAGINE.primo;
    });

    const prima = await processIntegrationImport('shop-1', {
      cursor: null,
      runId,
      lease: { assertHeld: async () => undefined },
      signal: controller.signal,
      saveCursor: async () => undefined,
    });
    expect(prima).toBe('paused');

    // La coda ripesca lo stesso item: il suo payload ha ancora cursore null.
    const seconda = await processIntegrationImport('shop-1', {
      cursor: null,
      runId,
      lease: { assertHeld: async () => undefined },
      saveCursor: async () => undefined,
    });

    expect(seconda).toBe('completed');
    expect(pagineLette).toEqual([null, PAGINA_2]);
    expect((await giro(runId)).counters).toEqual(ATTESI);
    expect(await conflitti()).toEqual(CONFLITTI_ATTESI);
    expect(scritti().map((e) => e.customerId)).toEqual([1, 3]);
  });

  it('pagina 2 fallita a meta e ritentata: la pagina si rifa senza conflitti doppi ne contatori gonfiati', async () => {
    const runId = await nuovoGiro();
    // La prima scrittura della pagina 2 su Shopify salta: l'item solleva e la
    // coda lo ritenta.
    let chiamate = 0;
    setCustomerBirthdates.mockImplementation(async (entries: unknown[]) => {
      chiamate++;
      if (chiamate === 2) throw new Error('Shopify 502');
      return { written: entries.length, errors: [], failed: [] };
    });
    const opts = {
      cursor: null,
      runId,
      lease: { assertHeld: async () => undefined },
      saveCursor: async () => undefined,
    };

    await expect(processIntegrationImport('shop-1', opts)).rejects.toThrow('Shopify 502');
    const aMeta = await giro(runId);
    expect(aMeta.cursor).toBe(PAGINA_2);
    expect(aMeta.counters).toMatchObject({ filled: 1, conflicts: 1 });

    expect(await processIntegrationImport('shop-1', opts)).toBe('completed');
    expect(pagineLette).toEqual([null, PAGINA_2, PAGINA_2]);
    expect((await giro(runId)).counters).toEqual(ATTESI);
    expect(await conflitti()).toEqual(CONFLITTI_ATTESI);
  });

  it('decisione gia presa: resta se Klaviyo e uguale, si riapre se e cambiato', async () => {
    const decisaIl = '2026-09-01 10:00';
    await h.db.query(
      `INSERT INTO integration_conflicts
         (id, shop_id, provider, shopify_customer_id, target_field, our_value, their_value, status, decided_at, updated_at)
       VALUES ($1, 'shop-1', 'klaviyo', 2, 'birthdate', '1980-05-05', '1981-01-01', 'kept_ours', $3, NOW()),
              ($2, 'shop-1', 'klaviyo', 4, 'birthdate', '1970-01-01', '1960-01-01', 'used_theirs', $3, NOW())`,
      [randomUUID(), randomUUID(), decisaIl],
    );
    const runId = await nuovoGiro();

    expect(
      await processIntegrationImport('shop-1', {
        cursor: null,
        runId,
        lease: { assertHeld: async () => undefined },
        saveCursor: async () => undefined,
      }),
    ).toBe('completed');

    expect(await conflitti()).toEqual([
      { cliente: 2, our_value: '1980-05-05', their_value: '1981-01-01', status: 'kept_ours', decided_at: decisaIl },
      { cliente: 4, our_value: '1970-01-01', their_value: '1972-03-03', status: 'open', decided_at: null },
    ]);
    expect((await giro(runId)).counters).toMatchObject({ decided: 1, conflicts: 1 });
  });
});
