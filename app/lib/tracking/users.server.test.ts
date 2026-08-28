import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  identifyVisitor,
  linkUserToCustomer,
  pruneAnonymousUsers,
  recordUserSeen,
} from './users.server';

const TELEFONO = 'corew_1700000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PORTATILE = 'corew_1750000000000_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TABLET = 'corew_1760000000000_cccccccccccccccccccccccccccccccc';

/* ------------------------------------------------------------------------- *
 * Un Supabase finto, ma non compiacente.
 *
 * Riproduce le tre cose che qui contano davvero e che, sbagliate, farebbero
 * passare un test su un codice rotto:
 *
 *  1. l'upsert aggiorna SOLO le colonne presenti nel corpo, com'e' l'INSERT ...
 *     ON CONFLICT DO UPDATE che l'API REST costruisce. E' cio' che permette a
 *     `first_seen_at` di sopravvivere al ritorno;
 *  2. le colonne assenti all'inserimento prendono il DEFAULT della DDL;
 *  3. una tabella che non c'e' risponde con il codice con cui risponde
 *     davvero (PGRST205), non con un vuoto silenzioso.
 * ------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

/** La chiave su cui l'upsert riconosce una riga gia' presente. */
const PRIMARY_KEY: Record<string, string> = {
  users: 'external_id',
  customers: 'shopify_customer_id',
};

/** Le colonne che la DDL riempie da sola quando il corpo non le nomina. */
const DEFAULTS: Record<string, (now: string) => Row> = {
  users: (now) => ({
    shopify_customer_id: null,
    browser: null,
    device_type: null,
    first_seen_at: now,
    last_seen_at: now,
    merged_into: null,
  }),
  customers: () => ({}),
};

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: unknown }> {
  private op: 'select' | 'update' | 'delete' | 'upsert' | null = null;
  private payload: Row[] = [];
  private patch: Row = {};
  private filters: ((row: Row) => boolean)[] = [];
  private cap: number | null = null;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(_columns?: string): this {
    // `select` e' sia il verbo di partenza sia il "restituiscimi cio' che hai
    // toccato" in coda a una delete: dipende da cosa e' stato chiamato prima.
    if (this.op === null) this.op = 'select';
    return this;
  }

  upsert(rows: Row[], _options?: unknown): this {
    this.op = 'upsert';
    this.payload = rows;
    return this;
  }

  update(values: Row): this {
    this.op = 'update';
    this.patch = values;
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => String(row[column] ?? '') === String(value));
    return this;
  }

  is(column: string, value: null): this {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }

  lt(column: string, value: string): this {
    this.filters.push((row) => String(row[column] ?? '') < value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  limit(count: number): this {
    this.cap = count;
    return this;
  }

  then<A, B>(
    onFulfilled?: ((value: { data: Row[] | null; error: unknown }) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }

  private run(): { data: Row[] | null; error: unknown } {
    const rows = this.db.tables[this.table];
    if (!rows) {
      return {
        data: null,
        error: {
          code: 'PGRST205',
          message: `Could not find the table 'public.${this.table}' in the schema cache`,
        },
      };
    }

    this.db.calls.push(`${this.table}.${this.op}`);
    const matches = (row: Row) => this.filters.every((f) => f(row));

    if (this.op === 'upsert') {
      const key = PRIMARY_KEY[this.table];
      for (const incoming of this.payload) {
        const existing = rows.find((row) => row[key] === incoming[key]);
        // Solo le colonne presenti nel corpo: e' tutta la differenza fra un
        // ritorno che aggiorna e un ritorno che riscrive la prima comparsa.
        if (existing) Object.assign(existing, incoming);
        else rows.push({ ...DEFAULTS[this.table](this.db.now()), ...incoming });
      }
      return { data: null, error: null };
    }

    if (this.op === 'update') {
      for (const row of rows.filter(matches)) Object.assign(row, this.patch);
      return { data: null, error: null };
    }

    if (this.op === 'delete') {
      const removed = rows.filter(matches);
      this.db.tables[this.table] = rows.filter((row) => !matches(row));
      return { data: removed, error: null };
    }

    const found = rows.filter(matches);
    return { data: this.cap === null ? found : found.slice(0, this.cap), error: null };
  }
}

class FakeDb {
  readonly calls: string[] = [];
  now: () => string = () => new Date().toISOString();

  constructor(public tables: Record<string, Row[]>) {}

  client(): SupabaseClient {
    return { from: (table: string) => new FakeQuery(this, table) } as unknown as SupabaseClient;
  }
}

/** Il caso normale: la tabella dei browser c'e', quella dei clienti anche. */
function db(users: Row[] = [], customers: Row[] = []): FakeDb {
  return new FakeDb({ users, customers });
}

let warned: string[];

beforeEach(() => {
  warned = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordUserSeen', () => {
  it('alla prima comparsa nasce la riga del browser', async () => {
    const store = db();
    store.now = () => '2026-08-01T10:00:00.000Z';

    await recordUserSeen(store.client(), {
      externalId: TELEFONO,
      browser: 'Safari',
      deviceType: 'mobile',
      seenAt: new Date('2026-08-01T10:00:00Z'),
    });

    expect(store.tables.users).toHaveLength(1);
    expect(store.tables.users[0]).toMatchObject({
      external_id: TELEFONO,
      browser: 'Safari',
      device_type: 'mobile',
      first_seen_at: '2026-08-01T10:00:00.000Z',
      last_seen_at: '2026-08-01T10:00:00.000Z',
      // Nasce anonima: chi arriva non ha ancora detto chi e'.
      shopify_customer_id: null,
      merged_into: null,
    });
  });

  it('al ritorno la riga si aggiorna e non si duplica', async () => {
    const store = db();
    store.now = () => '2026-08-01T10:00:00.000Z';
    await recordUserSeen(store.client(), {
      externalId: TELEFONO,
      seenAt: new Date('2026-08-01T10:00:00Z'),
    });

    await recordUserSeen(store.client(), {
      externalId: TELEFONO,
      seenAt: new Date('2026-08-20T18:30:00Z'),
    });

    // Una riga per browser, non una per visita.
    expect(store.tables.users).toHaveLength(1);
    // La prima comparsa resta la prima comparsa: e' il motivo per cui
    // `first_seen_at` non viaggia mai nel corpo dell'upsert.
    expect(store.tables.users[0].first_seen_at).toBe('2026-08-01T10:00:00.000Z');
    expect(store.tables.users[0].last_seen_at).toBe('2026-08-20T18:30:00.000Z');
  });

  it('cio che il container non manda non cancella cio che aveva mandato', async () => {
    const store = db();
    await recordUserSeen(store.client(), { externalId: TELEFONO, browser: 'Safari' });
    await recordUserSeen(store.client(), { externalId: TELEFONO });

    expect(store.tables.users[0].browser).toBe('Safari');
  });

  it('la tabella che non c e viene creata e la scrittura si ripete', async () => {
    // La DDL gira al collegamento: ogni negozio collegato prima di oggi non ha
    // `users`, e senza questa rete non ce l'avrebbe mai.
    const store = new FakeDb({});
    const provision = vi.fn(async () => {
      store.tables.users = [];
      return true;
    });

    const esito = await recordUserSeen(store.client(), { externalId: TELEFONO }, provision);

    expect(provision).toHaveBeenCalledTimes(1);
    expect(esito).toBe('written');
    expect(store.tables.users).toHaveLength(1);
  });
});

describe('linkUserToCustomer — il legame che arriva dall ordine', () => {
  it('riempie shopify_customer_id senza spostare ne cancellare niente', async () => {
    const store = db([
      {
        external_id: TELEFONO,
        shopify_customer_id: null,
        first_seen_at: '2026-08-01T10:00:00.000Z',
        last_seen_at: '2026-08-01T10:00:00.000Z',
        merged_into: null,
      },
    ]);

    const esito = await linkUserToCustomer(store.client(), {
      externalId: TELEFONO,
      shopifyCustomerId: 77,
    });

    expect(esito.outcome).toBe('linked');
    expect(store.tables.users).toHaveLength(1);
    expect(store.tables.users[0]).toMatchObject({
      external_id: TELEFONO,
      shopify_customer_id: 77,
      // La riga resta dov'e', con la sua storia: e' l'unico posto dove esiste
      // l'elenco dei browser di quel cliente.
      first_seen_at: '2026-08-01T10:00:00.000Z',
      merged_into: null,
    });
  });

  it('un browser mai visto prima si crea al volo', async () => {
    // Un ordine puo' arrivare da un browser di cui non abbiamo ancora la riga:
    // l'attributo di carrello c'e' comunque, e vale piu' della riga mancante.
    const store = db();
    await linkUserToCustomer(store.client(), { externalId: TELEFONO, shopifyCustomerId: 77 });

    expect(store.tables.users).toHaveLength(1);
    expect(store.tables.users[0].shopify_customer_id).toBe(77);
  });

  it('due browser dello stesso cliente restano due righe', async () => {
    // Non e' duplicazione, e' una relazione: chi compra dal telefono e dal
    // portatile ha due righe qui e una sola in `customers`. Cancellarne una
    // vorrebbe dire non riconoscerlo piu' su quel dispositivo.
    const store = db([
      {
        external_id: TELEFONO,
        shopify_customer_id: 77,
        first_seen_at: '2025-11-01T00:00:00.000Z',
        merged_into: null,
      },
    ]);

    await linkUserToCustomer(store.client(), { externalId: PORTATILE, shopifyCustomerId: 77 });

    expect(store.tables.users).toHaveLength(2);
    expect(store.tables.users.map((r) => r.shopify_customer_id)).toEqual([77, 77]);
  });

  it('merged_into punta al piu vecchio, che ha la storia piu lunga', async () => {
    const store = db([
      {
        external_id: TELEFONO,
        shopify_customer_id: 77,
        first_seen_at: '2025-11-01T00:00:00.000Z',
        merged_into: null,
      },
    ]);
    store.now = () => '2026-08-20T00:00:00.000Z';

    const esito = await linkUserToCustomer(store.client(), {
      externalId: PORTATILE,
      shopifyCustomerId: 77,
    });

    expect(esito.canonical).toBe(TELEFONO);
    expect(esito.merged).toEqual([PORTATILE]);

    const telefono = store.tables.users.find((r) => r.external_id === TELEFONO)!;
    const portatile = store.tables.users.find((r) => r.external_id === PORTATILE)!;
    // Il piu' recente dichiara a chi appartiene…
    expect(portatile.merged_into).toBe(TELEFONO);
    // …e il piu' vecchio non punta a nessuno: e' lui il canonico.
    expect(telefono.merged_into).toBeNull();
    // Nessuno dei due e' stato cancellato: gli eventi gia' partiti sotto
    // l'identificativo nuovo vivono dentro Meta e GA4, e senza la sua riga qui
    // resterebbero orfani per sempre.
    expect(portatile.shopify_customer_id).toBe(77);
  });

  it('un terzo browser punta allo stesso canonico, non al precedente', async () => {
    const store = db([
      {
        external_id: TELEFONO,
        shopify_customer_id: 77,
        first_seen_at: '2025-11-01T00:00:00.000Z',
        merged_into: null,
      },
      {
        external_id: PORTATILE,
        shopify_customer_id: 77,
        first_seen_at: '2026-06-01T00:00:00.000Z',
        merged_into: TELEFONO,
      },
    ]);
    store.now = () => '2026-08-20T00:00:00.000Z';

    const esito = await linkUserToCustomer(store.client(), {
      externalId: TABLET,
      shopifyCustomerId: 77,
    });

    expect(esito.merged).toEqual([TABLET]);
    const tablet = store.tables.users.find((r) => r.external_id === TABLET)!;
    expect(tablet.merged_into).toBe(TELEFONO);
  });

  it('sul cliente resta l identificativo piu recente, per comodita dei tag', async () => {
    // La fonte di verita' e' `users`; questa e' l'unica concessione a
    // `customers`, e contiene l'ultimo browser visto — quello da cui la persona
    // sta navigando adesso — non il canonico.
    const store = db(
      [
        {
          external_id: TELEFONO,
          shopify_customer_id: 77,
          first_seen_at: '2025-11-01T00:00:00.000Z',
          merged_into: null,
        },
      ],
      [{ shopify_customer_id: 77, email_address: 'anna@example.com', external_id: null }],
    );

    await linkUserToCustomer(store.client(), { externalId: PORTATILE, shopifyCustomerId: 77 });

    expect(store.tables.customers[0].external_id).toBe(PORTATILE);
    // E la tabella dei clienti resta con la sua riga sola: un browser anonimo
    // li' non ci potrebbe nemmeno entrare.
    expect(store.tables.customers).toHaveLength(1);
  });

  it('senza tabella clienti il legame si scrive lo stesso', async () => {
    // Un piano che non sincronizza i clienti non ha quella tabella: non e' un
    // guasto, e il riconoscimento vive comunque in `users`.
    const store = new FakeDb({ users: [] });

    const esito = await linkUserToCustomer(store.client(), {
      externalId: TELEFONO,
      shopifyCustomerId: 77,
    });

    expect(esito.outcome).toBe('linked');
    expect(store.tables.users[0].shopify_customer_id).toBe(77);
  });
});

describe('identifyVisitor — il legame prima dell acquisto', () => {
  it('dall email al cliente, e dal cliente al browser', async () => {
    const store = db(
      [],
      [{ shopify_customer_id: 77, email_address: 'anna@example.com', phone_number: null }],
    );

    const esito = await identifyVisitor(store.client(), {
      externalId: TELEFONO,
      email: '  Anna@Example.com ',
    });

    expect(esito.outcome).toBe('linked');
    expect(store.tables.users[0]).toMatchObject({
      external_id: TELEFONO,
      shopify_customer_id: 77,
    });
  });

  it('dal telefono in sole cifre, com e scritto nella colonna', async () => {
    const store = db([], [{ shopify_customer_id: 88, phone_number: '393331234567' }]);

    const esito = await identifyVisitor(store.client(), {
      externalId: PORTATILE,
      phone: '+39 333 123 4567',
    });

    expect(esito.outcome).toBe('linked');
    expect(store.tables.users[0].shopify_customer_id).toBe(88);
  });

  it('cliente non trovato: il browser resta noto, ma anonimo', async () => {
    // Nella tabella dei clienti ci sono solo quelli che hanno acconsentito al
    // marketing: "non trovato" e' spesso la risposta giusta, non un errore.
    const store = db([], []);

    const esito = await identifyVisitor(store.client(), {
      externalId: TELEFONO,
      email: 'sconosciuta@example.com',
    });

    expect(esito.outcome).toBe('no_match');
    expect(store.tables.users).toHaveLength(1);
    expect(store.tables.users[0].shopify_customer_id).toBeNull();
  });

  it('senza niente di cercabile non si interroga il database', async () => {
    const store = db([], []);
    const esito = await identifyVisitor(store.client(), { externalId: TELEFONO, email: 'pippo' });

    expect(esito.outcome).toBe('no_identifier');
    expect(store.calls).not.toContain('customers.select');
    // Il browser si registra comunque: e' un visitatore vero.
    expect(store.tables.users).toHaveLength(1);
  });

  it('due browser identificati con la stessa email restano due righe unite', async () => {
    const store = db([], [{ shopify_customer_id: 77, email_address: 'anna@example.com' }]);
    store.now = () => '2026-01-01T00:00:00.000Z';
    await identifyVisitor(store.client(), { externalId: TELEFONO, email: 'anna@example.com' });

    store.now = () => '2026-08-01T00:00:00.000Z';
    await identifyVisitor(store.client(), { externalId: PORTATILE, email: 'anna@example.com' });

    expect(store.tables.users).toHaveLength(2);
    const portatile = store.tables.users.find((r) => r.external_id === PORTATILE)!;
    expect(portatile.merged_into).toBe(TELEFONO);
    expect(portatile.shopify_customer_id).toBe(77);
  });
});

describe('pruneAnonymousUsers', () => {
  it('porta via i vecchi anonimi e risparmia gli identificati', async () => {
    const store = db([
      // Anonimo e fermo da due anni: non diventera' mai un cliente, e il
      // browser ha comunque buttato il cookie che portava questo nome.
      { external_id: TELEFONO, shopify_customer_id: null, last_seen_at: '2024-08-01T00:00:00Z' },
      // Identificato, e fermo da altrettanto: e' proprio quello che serve a
      // riconoscere il cliente al ritorno. Non si tocca, mai.
      { external_id: PORTATILE, shopify_customer_id: 77, last_seen_at: '2024-08-01T00:00:00Z' },
      // Anonimo ma di ieri: e' un visitatore in corso.
      { external_id: TABLET, shopify_customer_id: null, last_seen_at: '2026-08-27T00:00:00Z' },
    ]);

    const tolte = await pruneAnonymousUsers(store.client(), new Date('2026-08-28T00:00:00Z'));

    expect(tolte).toBe(1);
    expect(store.tables.users.map((r) => r.external_id)).toEqual([PORTATILE, TABLET]);
  });

  it('una tabella che non c e non ha niente da potare, e non e un guasto', async () => {
    const store = new FakeDb({});
    expect(await pruneAnonymousUsers(store.client())).toBe(0);
    expect(warned).toHaveLength(0);
  });
});
