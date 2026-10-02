import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  forgetVisitor,
  identifyVisitor,
  linkUserToCustomer,
  pruneAnonymousUsers,
  recordUserSeen,
  touchIssuedUser,
} from './users.server';

const TELEFONO = 'corew_1700000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PORTATILE = 'corew_1750000000000_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TABLET = 'corew_1760000000000_cccccccccccccccccccccccccccccccc';

/** Il negozio per cui gli identificativi qui sopra sono stati emessi. */
const SHOP = 'shop_a';
const ALTRO_NEGOZIO = 'shop_b';

/** Una riga emessa per `SHOP`, con quello che serve a riconoscerla. */
const emessa = (externalId: string, extra: Row = {}): Row => ({
  external_id: externalId,
  shopify_customer_id: null,
  first_seen_at: '2026-01-01T00:00:00.000Z',
  last_seen_at: '2026-01-01T00:00:00.000Z',
  merged_into: null,
  issued_for_shop: SHOP,
  ...extra,
});

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
    issued_for_shop: null,
  }),
  customers: () => ({}),
};

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: unknown }> {
  private op: 'select' | 'update' | 'delete' | 'upsert' | null = null;
  private payload: Row[] = [];
  private patch: Row = {};
  private filters: ((row: Row) => boolean)[] = [];
  private cap: number | null = null;
  /** `select` chiamato dopo il verbo: "restituiscimi le righe toccate". */
  private returning = false;
  /** Le colonne nominate nei filtri: servono a simulare la colonna che manca. */
  private filterColumns: string[] = [];

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(_columns?: string): this {
    // `select` e' sia il verbo di partenza sia il "restituiscimi cio' che hai
    // toccato" in coda a una delete: dipende da cosa e' stato chiamato prima.
    if (this.op === null) this.op = 'select';
    else this.returning = true;
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

  /** Solo la forma che usa il codice: `col.is.null,col.eq.valore`. */
  or(expression: string): this {
    const branches = expression.split(',').map((part) => {
      const [column, operator, ...rest] = part.split('.');
      this.filterColumns.push(column);
      const value = rest.join('.');
      if (operator === 'is' && value === 'null') return (row: Row) => (row[column] ?? null) === null;
      if (operator === 'eq') return (row: Row) => String(row[column] ?? '') === value;
      throw new Error(`operatore non simulato: ${part}`);
    });
    this.filters.push((row) => branches.some((branch) => branch(row)));
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

    // Il guasto iniettato: serve a provare che un errore VERO non diventa mai
    // successo, che e' la meta' che prima mancava. `PGRST205` (tabella assente)
    // continua ad arrivare dal ramo qui sopra, e le due strade devono restare
    // distinguibili.
    const guasto = this.db.fails[`${this.table}.${this.op}`];
    if (guasto) return { data: null, error: guasto };

    // La colonna che il database del merchant non ha ancora: risponde come
    // PostgREST, PGRST204 se e' nel corpo e 42703 se e' in un filtro.
    const missing = this.db.missingColumns;
    const bodyColumns = [...this.payload.flatMap((row) => Object.keys(row)), ...Object.keys(this.patch)];
    const inBody = bodyColumns.find((column) => missing.has(column));
    if (inBody) {
      return {
        data: null,
        error: { code: 'PGRST204', message: `Could not find the '${inBody}' column of '${this.table}' in the schema cache` },
      };
    }
    const inFilter = this.filterColumns.find((column) => missing.has(column));
    if (inFilter) {
      return {
        data: null,
        error: { code: '42703', message: `column ${this.table}.${inFilter} does not exist` },
      };
    }
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
      const touched = rows.filter(matches);
      for (const row of touched) Object.assign(row, this.patch);
      return { data: this.returning ? touched.map((row) => ({ ...row })) : null, error: null };
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
  /** I guasti da far rispondere, per `tabella.operazione`. */
  readonly fails: Record<string, { code?: string; message: string }> = {};
  /** Colonne che questo database non ha ancora (schema non aggiornato). */
  readonly missingColumns = new Set<string>();
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

  // Il caso che sembra un problema e non lo e', purche' la scrittura del
  // passaggio non tocchi il legame.
  //
  // Un cliente che svuota i cookie o apre da un browser nuovo atterra come
  // chiunque altro, e la riga che nasce e' anonima: giusto cosi', in quel
  // momento non sappiamo ancora chi sia. Il guaio sarebbe l'opposto — che
  // tornando su un browser GIA' riconosciuto la scrittura del passaggio
  // riportasse il legame a zero. Da quel momento quella persona sarebbe di
  // nuovo un'estranea sul suo stesso dispositivo, e nessuno se ne accorgerebbe.
  it('un browser gia legato resta legato anche dopo un nuovo passaggio', async () => {
    const store = db([
      {
        external_id: TELEFONO,
        shopify_customer_id: 77,
        first_seen_at: '2026-01-01T00:00:00.000Z',
        merged_into: null,
      },
    ]);
    store.now = () => '2026-08-28T10:00:00.000Z';

    await recordUserSeen(store.client(), {
      externalId: TELEFONO,
      browser: 'Safari',
      deviceType: 'mobile',
      seenAt: new Date('2026-08-28T10:00:00Z'),
    });

    expect(store.tables.users).toHaveLength(1);
    expect(store.tables.users[0]).toMatchObject({
      shopify_customer_id: 77,
      first_seen_at: '2026-01-01T00:00:00.000Z',
      last_seen_at: '2026-08-28T10:00:00.000Z',
      browser: 'Safari',
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

describe('touchIssuedUser — l identificativo e stato emesso per questo negozio?', () => {
  it('emesso per questo negozio: riconosciuto, e il passaggio si registra', async () => {
    const store = db([emessa(TELEFONO)]);

    const esito = await touchIssuedUser(store.client(), {
      externalId: TELEFONO,
      shopId: SHOP,
      browser: 'Safari',
      seenAt: new Date('2026-08-28T10:00:00Z'),
    });

    expect(esito).toBe('issued');
    expect(store.tables.users[0]).toMatchObject({
      last_seen_at: '2026-08-28T10:00:00.000Z',
      browser: 'Safari',
      first_seen_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('mai emesso: sconosciuto, e non nasce nessuna riga', async () => {
    // Il caso dell'audit: un valore con la forma giusta, inventato o copiato.
    // La forma non basta piu' a farlo entrare.
    const store = db([emessa(PORTATILE)]);

    const esito = await touchIssuedUser(store.client(), { externalId: TELEFONO, shopId: SHOP });

    expect(esito).toBe('unknown');
    expect(store.tables.users.map((r) => r.external_id)).toEqual([PORTATILE]);
  });

  it('emesso per un altro negozio sullo stesso database: sconosciuto, e intatto', async () => {
    // Due negozi possono puntare allo stesso progetto Supabase. L'identificativo
    // di uno non deve valere per l'altro, e non deve nemmeno essere toccato.
    const store = db([emessa(TELEFONO, { issued_for_shop: ALTRO_NEGOZIO })]);

    const esito = await touchIssuedUser(store.client(), {
      externalId: TELEFONO,
      shopId: SHOP,
      seenAt: new Date('2026-08-28T10:00:00Z'),
    });

    expect(esito).toBe('unknown');
    expect(store.tables.users[0]).toMatchObject({
      issued_for_shop: ALTRO_NEGOZIO,
      last_seen_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('riga di prima della verifica (senza negozio): vale, e da adesso e di questo negozio', async () => {
    // La migrazione: le righe scritte prima della colonna non dicono per chi
    // sono state emesse. La prima verifica le reclama, e da li' in poi un altro
    // negozio non le puo' piu' usare.
    const store = db([emessa(TELEFONO, { issued_for_shop: null })]);

    expect(await touchIssuedUser(store.client(), { externalId: TELEFONO, shopId: SHOP })).toBe('issued');
    expect(store.tables.users[0].issued_for_shop).toBe(SHOP);
    expect(
      await touchIssuedUser(store.client(), { externalId: TELEFONO, shopId: ALTRO_NEGOZIO }),
    ).toBe('unknown');
  });

  it('database non ancora aggiornato (manca la colonna): basta che la riga esista', async () => {
    // Tra il rilascio e l'aggiornamento dello schema del merchant la colonna
    // non c'e'. Rifiutare tutto vorrebbe dire coniare un identificativo nuovo a
    // chiunque torni; si ricade sulla sola esistenza della riga.
    const store = db([emessa(TELEFONO, { issued_for_shop: undefined })]);
    store.missingColumns.add('issued_for_shop');

    expect(await touchIssuedUser(store.client(), { externalId: TELEFONO, shopId: SHOP })).toBe('issued');
    expect(await touchIssuedUser(store.client(), { externalId: PORTATILE, shopId: SHOP })).toBe('unknown');
  });

  it('un guasto vero non diventa ne si ne no: unverified', async () => {
    const store = db([emessa(TELEFONO)]);
    store.fails['users.update'] = { code: '57014', message: 'statement timeout' };

    expect(await touchIssuedUser(store.client(), { externalId: TELEFONO, shopId: SHOP })).toBe('unverified');
  });

  it('tabella assente: si crea, e un database vuoto non conosce nessuno', async () => {
    const store = new FakeDb({});
    const provision = vi.fn(async () => {
      store.tables.users = [];
      return true;
    });

    const esito = await touchIssuedUser(store.client(), { externalId: TELEFONO, shopId: SHOP }, provision);

    expect(provision).toHaveBeenCalledTimes(1);
    expect(esito).toBe('unknown');
    expect(store.tables.users).toHaveLength(0);
  });

  it('un negozio dal nome strano non entra nel filtro: sconosciuto, senza interrogare', async () => {
    // Il filtro si compone in una stringa: un valore con virgole o punti la
    // riscriverebbe. Non succede con i nostri identificativi, e qui si prova che
    // non succederebbe nemmeno se un giorno arrivasse.
    const store = db([emessa(TELEFONO)]);

    const esito = await touchIssuedUser(store.client(), {
      externalId: TELEFONO,
      shopId: 'x,issued_for_shop.is.null',
    });

    expect(esito).toBe('unknown');
    expect(store.calls).toHaveLength(0);
  });
});

describe('recordUserSeen — la riga di un identificativo appena coniato', () => {
  it('porta il negozio per cui e stato emesso', async () => {
    const store = db();

    await recordUserSeen(store.client(), { externalId: TELEFONO }, undefined, { issuedForShop: SHOP });

    expect(store.tables.users[0].issued_for_shop).toBe(SHOP);
  });

  it('su un database non ancora aggiornato la riga nasce lo stesso, senza negozio', async () => {
    const store = db();
    store.missingColumns.add('issued_for_shop');

    const esito = await recordUserSeen(store.client(), { externalId: TELEFONO }, undefined, {
      issuedForShop: SHOP,
    });

    expect(esito).toBe('written');
    expect(store.tables.users).toHaveLength(1);
  });
});

describe('linkUserToCustomer — il legame che arriva dall ordine', () => {
  it('riempie shopify_customer_id senza spostare ne cancellare niente', async () => {
    const store = db([emessa(TELEFONO, { first_seen_at: '2026-08-01T10:00:00.000Z' })]);

    const esito = await linkUserToCustomer(store.client(), {
      externalId: TELEFONO,
      shopId: SHOP,
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

  it('un identificativo mai emesso non si lega e non crea nessuna riga', async () => {
    // Prima un browser mai visto si creava al volo: l'attributo del carrello
    // bastava. Ma il carrello e' un posto dove chiunque scrive, e un valore
    // inventato li' dentro diventava una riga legata a un cliente vero.
    const store = db([], [{ shopify_customer_id: 77, external_id: null }]);

    const esito = await linkUserToCustomer(store.client(), {
      externalId: TELEFONO,
      shopId: SHOP,
      shopifyCustomerId: 77,
    });

    expect(esito.outcome).toBe('unknown_external_id');
    expect(store.tables.users).toHaveLength(0);
    expect(store.tables.customers[0].external_id).toBeNull();
  });

  it('un identificativo di un altro negozio non si lega', async () => {
    const store = db([emessa(TELEFONO, { issued_for_shop: ALTRO_NEGOZIO })]);

    const esito = await linkUserToCustomer(store.client(), {
      externalId: TELEFONO,
      shopId: SHOP,
      shopifyCustomerId: 77,
    });

    expect(esito.outcome).toBe('unknown_external_id');
    expect(store.tables.users[0].shopify_customer_id).toBeNull();
  });

  it('se la verifica non si puo fare il legame non si scrive', async () => {
    const store = db([emessa(TELEFONO)]);
    store.fails['users.update'] = { code: '57014', message: 'statement timeout' };

    const esito = await linkUserToCustomer(store.client(), {
      externalId: TELEFONO,
      shopId: SHOP,
      shopifyCustomerId: 77,
    });

    expect(esito.outcome).toBe('failed');
  });

  it('due browser dello stesso cliente restano due righe', async () => {
    // Non e' duplicazione, e' una relazione: chi compra dal telefono e dal
    // portatile ha due righe qui e una sola in `customers`. Cancellarne una
    // vorrebbe dire non riconoscerlo piu' su quel dispositivo.
    const store = db([
      emessa(TELEFONO, { shopify_customer_id: 77, first_seen_at: '2025-11-01T00:00:00.000Z' }),
      emessa(PORTATILE),
    ]);

    await linkUserToCustomer(store.client(), { externalId: PORTATILE, shopId: SHOP, shopifyCustomerId: 77 });

    expect(store.tables.users).toHaveLength(2);
    expect(store.tables.users.map((r) => r.shopify_customer_id)).toEqual([77, 77]);
  });

  it('merged_into punta al piu vecchio, che ha la storia piu lunga', async () => {
    const store = db([
      emessa(TELEFONO, { shopify_customer_id: 77, first_seen_at: '2025-11-01T00:00:00.000Z' }),
      emessa(PORTATILE, { first_seen_at: '2026-08-20T00:00:00.000Z' }),
    ]);

    const esito = await linkUserToCustomer(store.client(), {
      externalId: PORTATILE,
      shopId: SHOP,
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
      emessa(TELEFONO, { shopify_customer_id: 77, first_seen_at: '2025-11-01T00:00:00.000Z' }),
      emessa(PORTATILE, {
        shopify_customer_id: 77,
        first_seen_at: '2026-06-01T00:00:00.000Z',
        merged_into: TELEFONO,
      }),
      emessa(TABLET, { first_seen_at: '2026-08-20T00:00:00.000Z' }),
    ]);

    const esito = await linkUserToCustomer(store.client(), {
      externalId: TABLET,
      shopId: SHOP,
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
        emessa(TELEFONO, { shopify_customer_id: 77, first_seen_at: '2025-11-01T00:00:00.000Z' }),
        emessa(PORTATILE, { first_seen_at: '2026-08-20T00:00:00.000Z' }),
      ],
      [{ shopify_customer_id: 77, email_address: 'anna@example.com', external_id: null }],
    );

    await linkUserToCustomer(store.client(), { externalId: PORTATILE, shopId: SHOP, shopifyCustomerId: 77 });

    expect(store.tables.customers[0].external_id).toBe(PORTATILE);
    // E la tabella dei clienti resta con la sua riga sola: un browser anonimo
    // li' non ci potrebbe nemmeno entrare.
    expect(store.tables.customers).toHaveLength(1);
  });

  it('senza tabella clienti il legame si scrive lo stesso', async () => {
    // Un piano che non sincronizza i clienti non ha quella tabella: non e' un
    // guasto, e il riconoscimento vive comunque in `users`.
    const store = new FakeDb({ users: [emessa(TELEFONO)] });

    const esito = await linkUserToCustomer(store.client(), {
      externalId: TELEFONO,
      shopId: SHOP,
      shopifyCustomerId: 77,
    });

    expect(esito.outcome).toBe('linked');
    expect(store.tables.users[0].shopify_customer_id).toBe(77);
  });
});

describe('identifyVisitor — il legame prima dell acquisto', () => {
  it('dall email al cliente, e dal cliente al browser', async () => {
    const store = db(
      [emessa(TELEFONO)],
      [{ shopify_customer_id: 77, email_address: 'anna@example.com', phone_number: null }],
    );

    const esito = await identifyVisitor(store.client(), {
      externalId: TELEFONO,
      shopId: SHOP,
      email: '  Anna@Example.com ',
    });

    expect(esito.outcome).toBe('linked');
    expect(store.tables.users[0]).toMatchObject({
      external_id: TELEFONO,
      shopify_customer_id: 77,
    });
  });

  it('dal telefono in sole cifre, com e scritto nella colonna', async () => {
    const store = db([emessa(PORTATILE)], [{ shopify_customer_id: 88, phone_number: '393331234567' }]);

    const esito = await identifyVisitor(store.client(), {
      externalId: PORTATILE,
      shopId: SHOP,
      phone: '+39 333 123 4567',
    });

    expect(esito.outcome).toBe('linked');
    expect(store.tables.users[0].shopify_customer_id).toBe(88);
  });

  it('cliente non trovato: il browser resta noto, ma anonimo', async () => {
    // Nella tabella dei clienti ci sono solo quelli che hanno acconsentito al
    // marketing: "non trovato" e' spesso la risposta giusta, non un errore.
    const store = db([emessa(TELEFONO)], []);

    const esito = await identifyVisitor(store.client(), {
      externalId: TELEFONO,
      shopId: SHOP,
      email: 'sconosciuta@example.com',
    });

    expect(esito.outcome).toBe('no_match');
    expect(store.tables.users).toHaveLength(1);
    expect(store.tables.users[0].shopify_customer_id).toBeNull();
  });

  it('senza niente di cercabile non si interroga la tabella dei clienti', async () => {
    const store = db([emessa(TELEFONO)], []);
    const esito = await identifyVisitor(store.client(), {
      externalId: TELEFONO,
      shopId: SHOP,
      email: 'pippo',
    });

    expect(esito.outcome).toBe('no_identifier');
    expect(store.calls).not.toContain('customers.select');
  });

  it('un identificativo mai emesso non cerca nessuno e non scrive niente', async () => {
    // Il legame piu' pesante di tutti — un browser e una persona con nome e
    // cognome — non si fa su un valore che non abbiamo emesso noi.
    const store = db([], [{ shopify_customer_id: 77, email_address: 'anna@example.com' }]);

    const esito = await identifyVisitor(store.client(), {
      externalId: TELEFONO,
      shopId: SHOP,
      email: 'anna@example.com',
    });

    expect(esito.outcome).toBe('unknown_external_id');
    expect(store.tables.users).toHaveLength(0);
    expect(store.calls).not.toContain('customers.select');
  });

  it('se la verifica non si puo fare non si cerca nessuno', async () => {
    const store = db([emessa(TELEFONO)], [{ shopify_customer_id: 77, email_address: 'anna@example.com' }]);
    store.fails['users.update'] = { code: '57014', message: 'statement timeout' };

    const esito = await identifyVisitor(store.client(), {
      externalId: TELEFONO,
      shopId: SHOP,
      email: 'anna@example.com',
    });

    expect(esito.outcome).toBe('failed');
    expect(store.calls).not.toContain('customers.select');
  });

  it('due browser identificati con la stessa email restano due righe unite', async () => {
    const store = db(
      [
        emessa(TELEFONO, { first_seen_at: '2026-01-01T00:00:00.000Z' }),
        emessa(PORTATILE, { first_seen_at: '2026-08-01T00:00:00.000Z' }),
      ],
      [{ shopify_customer_id: 77, email_address: 'anna@example.com' }],
    );
    await identifyVisitor(store.client(), { externalId: TELEFONO, shopId: SHOP, email: 'anna@example.com' });
    await identifyVisitor(store.client(), { externalId: PORTATILE, shopId: SHOP, email: 'anna@example.com' });

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

describe('forgetVisitor', () => {
  const passo = (esito: Awaited<ReturnType<typeof forgetVisitor>>, nome: string) =>
    esito.steps.find((s) => s.step === nome);

  it('i tre gesti, e la revoca si dichiara applicata', async () => {
    const store = db(
      [{ external_id: TELEFONO, merged_into: null }, { external_id: PORTATILE, merged_into: TELEFONO }],
      [{ shopify_customer_id: 7, external_id: TELEFONO }],
    );

    const esito = await forgetVisitor(store.client(), TELEFONO);

    expect(esito.outcome).toBe('forgotten');
    expect(esito.steps.map((s) => s.outcome)).toEqual(['done', 'done', 'done']);
    expect(store.tables.customers[0].external_id).toBeNull();
    expect(store.tables.users.find((r) => r.external_id === PORTATILE)?.merged_into).toBeNull();
    expect(store.tables.users.find((r) => r.external_id === TELEFONO)).toBeUndefined();
  });

  // I tre casi dell'audit, uno per gesto. Prima ognuno di questi finiva in una
  // riga di log e la funzione tornava comunque un valore che nessuno guardava.
  it.each([
    ['customers.update', 'customer_unlink'],
    ['users.update', 'merge_pointers'],
    ['users.delete', 'user_delete'],
  ] as const)('%s in errore: il passo e failed, e la revoca non e applicata', async (dove, passoAtteso) => {
    const store = db([{ external_id: TELEFONO, merged_into: null }], [
      { shopify_customer_id: 7, external_id: TELEFONO },
    ]);
    store.fails[dove] = { code: '57014', message: 'statement timeout' };

    const esito = await forgetVisitor(store.client(), TELEFONO);

    expect(esito.outcome).toBe('failed');
    expect(passo(esito, passoAtteso)?.outcome).toBe('failed');
    expect(passo(esito, passoAtteso)?.detail).toContain('timeout');
  });

  // Il dettaglio finisce su una colonna del registro e da li' in un log:
  // PostgREST riporta volentieri il filtro della query, e il filtro qui e'
  // l'identificativo del browser di una persona.
  it('il dettaglio dell errore e redatto', async () => {
    const store = db([{ external_id: TELEFONO }]);
    store.fails['users.delete'] = {
      message: `connessione a postgresql://utente:parolasegreta@db.abc.supabase.co rifiutata per anna@example.com`,
    };

    const esito = await forgetVisitor(store.client(), TELEFONO);
    const dettaglio = passo(esito, 'user_delete')?.detail ?? '';

    expect(dettaglio).not.toContain('parolasegreta');
    expect(dettaglio).not.toContain('anna@example.com');
  });

  // Un negozio collegato prima della DDL del grafo non ha `users`; un piano che
  // non sincronizza i clienti non ha `customers`. Li' non c'e' niente da
  // cancellare, e chiamarlo errore vorrebbe dire mandare in lettera morta una
  // revoca gia' soddisfatta.
  it('tabella clienti assente: skipped, non failed', async () => {
    const store = new FakeDb({ users: [{ external_id: TELEFONO }] });

    const esito = await forgetVisitor(store.client(), TELEFONO);

    expect(esito.outcome).toBe('forgotten');
    expect(passo(esito, 'customer_unlink')?.outcome).toBe('skipped');
    expect(passo(esito, 'customer_unlink')?.detail).toBe('tabella assente');
    expect(passo(esito, 'user_delete')?.outcome).toBe('done');
  });

  it('nessuna tabella: tutto skipped, e la revoca resta applicata', async () => {
    const store = new FakeDb({});

    const esito = await forgetVisitor(store.client(), TELEFONO);

    expect(esito.outcome).toBe('forgotten');
    expect(esito.steps.map((s) => s.outcome)).toEqual(['skipped', 'skipped', 'skipped']);
  });

  // L'ordine e' parte del rimedio: si slega il cliente e si sciolgono i rimandi
  // PRIMA di cancellare la riga, cosi' un ritentativo ricomincia da un grafo
  // ancora intero.
  it('un gesto fallito non impedisce agli altri di riuscire', async () => {
    const store = db([{ external_id: TELEFONO }], [{ shopify_customer_id: 7, external_id: TELEFONO }]);
    store.fails['customers.update'] = { message: 'permission denied' };

    const esito = await forgetVisitor(store.client(), TELEFONO);

    expect(esito.outcome).toBe('failed');
    // La riga del visitatore se n'e' andata lo stesso: il ritentativo dovra'
    // solo rifare il gesto mancante.
    expect(store.tables.users).toHaveLength(0);
  });
});
