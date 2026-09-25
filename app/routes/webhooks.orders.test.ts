import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { creaFakeWebhookStore } from '~/lib/webhooks/inbox-fake-store';

/**
 * Gli ordini dopo che il lavoro e' uscito dalla richiesta HTTP.
 *
 * Era il webhook piu' lento e il piu' frequente insieme: rilettura GraphQL,
 * scrittura dell'ordine, scrittura delle righe, cancellazione per differenza e
 * legame browser-cliente, tutto PRIMA di rispondere. Adesso la risposta e' la
 * sola ricevuta, e cosa e' successo davvero si legge sulla riga dell'evento —
 * e' li' che questi test guardano dove prima guardavano il codice di stato.
 *
 * Il resto non cambia, ed e' voluto: il payload resta un innesco, l'ordine si
 * rilegge, e gli attributi del carrello restano l'unica cosa che la rilettura
 * non porta — per questo il trigger conservato se li porta dietro.
 */
const store = creaFakeWebhookStore();

vi.mock('~/lib/webhooks/verify.server', () => ({ verifyWebhook: () => true }));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn() }));
vi.mock('~/db.server', () => ({
  prisma: {
    // La posta in arrivo vera: e' l'unico modo di contare gli effetti prodotti
    // da due consegne dello stesso evento.
    get webhookEvent() {
      return store;
    },
    session: { count: async () => 0, findMany: async () => [], deleteMany: async () => ({ count: 0 }) },
    shop: { findUnique: vi.fn() },
    plan: { findFirst: vi.fn() },
    syncJob: { create: vi.fn() },
  },
}));

// La rilettura canonica: il webhook dice QUALE ordine, l'API dice com'e'.
// `vi.hoisted` perche' la fabbrica del mock viene issata sopra a tutto.
const { getOrderById } = vi.hoisted(() => ({ getOrderById: vi.fn() }));
vi.mock('~/lib/shopify-api.server', () => ({
  ShopifyAPIClient: { forShop: vi.fn(async () => ({ getOrderById })) },
}));

// Il riconoscimento del visitatore: qui interessa che il webhook gli passi la
// coppia giusta — id cliente e identificativo del browser — non cosa scrive.
// Quello ha i suoi test, in lib/tracking/users.server.test.
const { linkUserToCustomer } = vi.hoisted(() => ({
  linkUserToCustomer: vi.fn(async () => ({
    outcome: 'linked' as const,
    canonical: null,
    merged: [] as string[],
  })),
}));
vi.mock('~/lib/tracking/users.server', () => ({ linkUserToCustomer }));
vi.mock('~/lib/supabase/ensure-users-table.server', () => ({
  provisionUsersTable: vi.fn(async () => true),
}));

import { action as rotta } from './webhooks.orders';
import { settleWebhookWork } from '~/lib/webhooks/receive.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import type { ShopifyOrder, ShopifyOrderLine } from '~/lib/customers/order-rows';

/** La rotta piu' il lavoro che parte dopo la risposta. */
async function action(args: { request: Request }) {
  const res = await rotta(args as never);
  await settleWebhookWork();
  return res;
}

/** L'evento numero `i` fra quelli che il test ha prodotto. */
function evento(i = 0) {
  return store.righe[i];
}

/**
 * Una consegna, con il suo identificativo.
 *
 * L'id conta adesso quanto il corpo: due consegne che lo condividono sono LA
 * STESSA consegna e devono produrre un effetto solo, due che non lo
 * condividono sono due notifiche distinte dello stesso ordine e devono
 * produrre lo stesso risultato scritto due volte. Senza l'header, l'impronta
 * del corpo decide — ed e' voluto: un ritentativo che perde l'header non deve
 * diventare un secondo evento.
 */
function req(body: unknown, consegna?: string) {
  const headers: Record<string, string> = {
    'X-Shopify-Hmac-Sha256': 'sig',
    'X-Shopify-Shop-Domain': 'test-shop.myshopify.com',
  };
  if (consegna) headers['X-Shopify-Webhook-Id'] = consegna;
  return new Request('https://app/webhooks/orders', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Negozio installato, autorizzato, collegato e con il permesso sugli ordini. */
function mockShop(over: Record<string, unknown> = {}) {
  (prisma.shop.findUnique as any).mockResolvedValue({
    id: 'shop-1',
    shopDomain: 'test-shop.myshopify.com',
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products,read_orders,read_all_orders',
    currentPlan: 'growth',
    supabaseConfig: { connectionVerifiedAt: new Date(), tableNameProducts: 'products' },
    ...over,
  });
  (prisma.plan.findFirst as any).mockResolvedValue({
    planName: 'growth',
    customersSyncEnabled: true,
    productFeedsEnabled: true,
  });
  (prisma.syncJob.create as any).mockResolvedValue({});
}

/**
 * Un client Supabase che raccoglie quel che gli si scrive, tabella per tabella,
 * e che sa anche fallire su richiesta. La cancellazione per differenza si
 * registra a parte: e' la sola operazione che puo' distruggere dati veri.
 */
function mockSupabase(errors: Record<string, { message: string; code?: string }> = {}) {
  const writes: Record<string, any[]> = {};
  const tablesTouched: string[] = [];
  const deletes: any[] = [];

  (createSupabaseClient as any).mockReturnValue({
    from: (table: string) => ({
      upsert: async (rows: any[]) => {
        tablesTouched.push(table);
        if (errors[table]) return { error: errors[table] };
        writes[table] = [...(writes[table] ?? []), ...rows];
        return { error: null };
      },
      delete: () => {
        const builder: any = {
          eq: (_c: string, v: unknown) => builder,
          in: (_c: string, v: unknown[]) => builder,
          not: (_c: string, _o: string, list: string) => {
            builder.keep = list;
            return builder;
          },
          select: async () => {
            deletes.push({ table, keep: builder.keep ?? null });
            return { data: [], error: null };
          },
        };
        return builder;
      },
    }),
  });

  return { writes, tablesTouched, deletes };
}

/** La RICEVUTA: quel poco che si guarda ancora del corpo REST. */
function receipt(over: Record<string, unknown> = {}) {
  return {
    id: 5001,
    // Tutto il resto arriva nella busta ma non si legge piu': i prezzi e le
    // quantita' del payload sono quelli che facevano sballare i margini.
    total_price: '119.80',
    line_items: [{ id: 9001, quantity: 2, price: '49.90' }],
    customer: { id: 77, first_name: 'Anna' },
    ...over,
  };
}

const line = (over: Partial<ShopifyOrderLine> = {}): ShopifyOrderLine => ({
  id: 9001,
  title: 'Felpa',
  quantity: 2,
  current_quantity: 2,
  product_id: 301,
  variant_id: 401,
  unit_price: '44.91',
  total_discount: '0.00',
  line_net_total: '89.82',
  line_currency: 'EUR',
  ...over,
});

/** L'ordine come lo consegna la rilettura GraphQL. */
function canonicalOrder(over: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: 5001,
    order_number: '#1042',
    placed_at: '2026-08-27T09:12:00+02:00',
    updated_at: '2026-08-27T09:12:03+02:00',
    cancelled_at: null,
    financial_status: 'paid',
    total_price: '119.80',
    currency: 'EUR',
    customer_id: 77,
    customer_first_name: 'Anna',
    customer_last_name: 'Rossi',
    lines: [line(), line({ id: 9002, title: 'Cappello', variant_id: 402, quantity: 1, current_quantity: 1, unit_price: '19.90', line_net_total: '29.98' })],
    lines_complete: true,
    ...over,
  };
}

let logged: string[];
let warned: string[];
let errored: string[];

beforeEach(() => {
  store.reset();
  vi.clearAllMocks();
  getOrderById.mockResolvedValue(canonicalOrder());
  logged = [];
  warned = [];
  errored = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errored.push(a.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** L'ultima riga strutturata che l'handler ha lasciato nel log. */
function lastTrace(lines: string[]): any {
  const line = [...lines].reverse().find((l) => l.startsWith('[webhook orders] {'));
  return line ? JSON.parse(line.slice('[webhook orders] '.length)) : null;
}

describe('webhook orders — il payload e un innesco, non una fonte', () => {
  it('del corpo prende l id e poi rilegge l ordine dall API', async () => {
    // E' IL PUNTO DI TUTTO IL CAMBIAMENTO. Il corpo REST non ha ne' la
    // quantita' corrente ne' il netto di riga, cioe' i due soli valori su cui si
    // puo' fare un margine che sopravviva a un rimborso: ricostruirli dal
    // payload significava scrivere numeri gonfiati e lasciare che fosse la
    // corsa periodica a correggerli, ore dopo.
    mockShop();
    const { writes } = mockSupabase();

    const res = await action({ request: req(receipt()) } as any);

    expect(res.status).toBe(200);
    expect(getOrderById).toHaveBeenCalledWith(5001);

    expect(writes.orders).toHaveLength(1);
    expect(writes.orders[0]).toMatchObject({
      shopify_order_id: 5001,
      order_number: '#1042',
      shopify_customer_id: 77,
      currency: 'EUR',
      total_price: 119.8,
    });

    expect(writes.order_lines).toHaveLength(2);
    expect(writes.order_lines[0]).toMatchObject({
      shopify_line_id: 9001,
      current_quantity: 2,
      line_net_total: 89.82,
      line_currency: 'EUR',
    });
  });

  it('i numeri scritti sono quelli riletti, non quelli della busta', async () => {
    // La busta dice due pezzi a 49.90; l'ordine riletto dice che uno e' stato
    // reso. Vince la rilettura, e la differenza e' esattamente il margine
    // sovrastimato che nessuno vedeva.
    mockShop();
    const { writes } = mockSupabase();
    getOrderById.mockResolvedValue(
      canonicalOrder({
        lines: [line({ quantity: 2, current_quantity: 1, line_net_total: '44.91' })],
      }),
    );

    await action({ request: req(receipt()) } as any);

    expect(writes.order_lines).toHaveLength(1);
    expect(writes.order_lines[0]).toMatchObject({
      quantity: 2,
      current_quantity: 1,
      line_net_total: 44.91,
    });
  });

  it('un rimborso rilegge l ordine, non il rimborso', async () => {
    // La busta di `refunds/create` e' il RIMBORSO: l'id in cima e' il suo.
    // Rileggendo quello si andrebbe a prendere un ordine che non esiste.
    mockShop();
    mockSupabase();

    await action({ request: req({ id: 88001, order_id: 5001 }) } as any);

    expect(getOrderById).toHaveBeenCalledWith(5001);
  });

  it('un ordine interamente rimborsato porta le sue righe a zero', async () => {
    // `cancelled_at` resta null — l'ordine e' valido — ma non c'e' piu' niente
    // in mano al cliente, e il contributo di quelle righe e' zero.
    mockShop();
    const { writes } = mockSupabase();
    getOrderById.mockResolvedValue(
      canonicalOrder({
        financial_status: 'refunded',
        total_price: '0.00',
        lines: [line({ current_quantity: 0, line_net_total: '89.82' })],
      }),
    );

    await action({ request: req(receipt()) } as any);

    expect(writes.orders[0]).toMatchObject({ total_price: 0, cancelled_at: null });
    expect(writes.order_lines[0]).toMatchObject({ current_quantity: 0, line_net_total: 0 });
  });

  it('un ordine annullato si scrive lo stesso, con la data di annullamento', async () => {
    // Toglierlo vorrebbe dire un ordine che il merchant vede su Shopify e non
    // trova nel suo database: a escluderlo dal profitto e' il conto.
    mockShop();
    const { writes } = mockSupabase();
    getOrderById.mockResolvedValue(
      canonicalOrder({ cancelled_at: '2026-08-27T11:00:00+02:00', financial_status: 'voided' }),
    );

    await action({ request: req(receipt()) } as any);

    expect(writes.orders[0]).toMatchObject({
      cancelled_at: '2026-08-27T11:00:00+02:00',
      financial_status: 'voided',
    });
    expect(writes.order_lines).toHaveLength(2);
  });

  it('un ordine senza righe scrive comunque l ordine', async () => {
    mockShop();
    const { writes, tablesTouched } = mockSupabase();
    getOrderById.mockResolvedValue(canonicalOrder({ lines: [] }));

    await action({ request: req(receipt()) } as any);

    expect(writes.orders).toHaveLength(1);
    expect(tablesTouched).toEqual(['orders']);
    expect(lastTrace(logged)).toMatchObject({ status: 'completed', lines: 0 });
  });

  it('lascia una traccia leggibile anche quando e andato tutto bene', async () => {
    mockShop();
    mockSupabase();

    await action({ request: req(receipt()) } as any);

    expect(lastTrace(logged)).toMatchObject({
      webhook: 'orders',
      order: 5001,
      status: 'completed',
      lines: 2,
      lines_complete: true,
    });
    // Un successo non sporca il registro dei job: sarebbe una riga per vendita.
    expect(prisma.syncJob.create).not.toHaveBeenCalled();
  });
});

describe('webhook orders — cancellare per differenza, e quando non si puo', () => {
  it('elenco completo: le righe sparite dall ordine si tolgono', async () => {
    mockShop();
    const { deletes } = mockSupabase();

    await action({ request: req(receipt()) } as any);

    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({ table: 'order_lines', keep: '(9001,9002)' });
  });

  it('elenco incompleto: nessuna cancellazione, e la riparazione si registra', async () => {
    // Su un elenco troncato "non l'ho vista" non e' "non c'e' piu'": cancellare
    // li' vuol dire cancellare righe che esistono, e proprio negli ordini piu'
    // grandi.
    mockShop();
    const { writes, deletes } = mockSupabase();
    getOrderById.mockResolvedValue(canonicalOrder({ lines_complete: false }));

    const res = await action({ request: req(receipt()) } as any);

    expect(res.status).toBe(200);
    expect(writes.order_lines).toHaveLength(2);
    expect(deletes).toHaveLength(0);
    expect(warned.some((w) => w.includes('riconciliazione non conclusa'))).toBe(true);
    expect(lastTrace(logged)).toMatchObject({ status: 'completed', lines_complete: false });

    // La riparazione in sospeso e' l'elenco degli ordini di cui SAPPIAMO che i
    // numeri sono provvisori: senza, l'unico modo di ritrovarli sarebbe
    // rileggere tutto il negozio sperando che basti.
    const job = (prisma.syncJob.create as any).mock.calls[0][0].data;
    expect(job).toMatchObject({ shopId: 'shop-1', jobType: 'order_repair_pending' });
    expect(job.errors.order_repair.order).toBe(5001);
  });
});

describe('webhook orders — la stessa busta due volte', () => {
  it('ritentata, scrive le stesse righe e non ne aggiunge di nuove', async () => {
    // Shopify riprova le consegne: il rimedio non e' un lucchetto, e' che
    // ripetere non cambi il risultato. Sono upsert su chiavi univoche.
    mockShop();
    const { writes } = mockSupabase();

    // `synced_at` fuori dal confronto, ed e' il punto: dice QUANDO abbiamo
    // scritto, non cosa. Fra due consegne cambia per forza, e confrontarlo
    // faceva fallire il test quando i due giri cadevano in millisecondi
    // diversi — un rosso intermittente su una proprieta' che nessuno voleva
    // verificare.
    const senzaOrario = (righe: any[]) =>
      JSON.stringify(righe.map(({ synced_at: _scritta, ...resto }) => resto));

    // Due consegne DISTINTE dello stesso ordine: e' quel che succede quando
    // Shopify rimanda la notifica perche' non ha ricevuto risposta in tempo.
    // Ognuna rilegge l'ordine da capo e riscrive le stesse chiavi.
    await action({ request: req(receipt(), 'consegna-1') } as any);
    const primo = senzaOrario(writes.order_lines);
    writes.order_lines = [];
    writes.orders = [];

    await action({ request: req(receipt(), 'consegna-2') } as any);

    expect(senzaOrario(writes.order_lines)).toBe(primo);
    expect(writes.orders).toHaveLength(1);
  });

  it('la STESSA consegna due volte: una riga sola e un solo effetto', async () => {
    // La deduplica su `X-Shopify-Webhook-Id`, che prima per gli ordini non
    // esisteva affatto: un timeout faceva ritentare Shopify, e il ritentativo
    // rileggeva, riscriveva e ricancellava tutto daccapo.
    mockShop();
    const { writes } = mockSupabase();

    await action({ request: req(receipt(), 'consegna-1') } as any);
    const res = await action({ request: req(receipt(), 'consegna-1') } as any);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ duplicate: true });
    expect(store.righe).toHaveLength(1);
    expect(writes.orders).toHaveLength(1);
    expect(getOrderById).toHaveBeenCalledTimes(1);
  });

  it('senza l header dell id, due consegne identiche restano la stessa', async () => {
    // Un ritentativo che perde l'header non deve diventare un secondo evento:
    // l'impronta del corpo lo riconosce lo stesso.
    mockShop();
    const { writes } = mockSupabase();

    await action({ request: req(receipt()) } as any);
    await action({ request: req(receipt()) } as any);

    expect(store.righe).toHaveLength(1);
    expect(writes.orders).toHaveLength(1);
  });

  it('due consegne in parallelo scrivono le stesse chiavi, non righe doppie', async () => {
    mockShop();
    const { writes } = mockSupabase();

    await Promise.all([
      action({ request: req(receipt(), 'consegna-1') } as any),
      action({ request: req(receipt(), 'consegna-2') } as any),
    ]);

    // Due consegne, due upsert per riga: le chiavi restano due, e a fare da
    // giudice e' `onConflict` sul database, non l'ordine di arrivo.
    expect(new Set(writes.order_lines.map((l: any) => l.shopify_line_id))).toEqual(
      new Set([9001, 9002]),
    );
    expect(new Set(writes.orders.map((o: any) => o.shopify_order_id))).toEqual(new Set([5001]));
  });
});

describe('webhook orders — un errore non sparisce piu in silenzio', () => {
  it('ordine non scritto: traccia nel log e riga nel registro dei job', async () => {
    mockShop();
    const { writes } = mockSupabase({ orders: { message: 'permission denied for table orders' } });

    const res = await action({ request: req(receipt()) } as any);

    // 200 perche' la ricevuta e' scritta: rifiutare adesso un evento gia'
    // accettato non rimetterebbe a posto niente. Che la scrittura NON sia
    // riuscita si legge sulla riga, che torna in attesa — e a ritentare siamo
    // noi, non piu' Shopify per una finestra che finisce.
    expect(res.status).toBe(200);
    expect(evento().status).toBe('queued');
    expect(evento().attempts).toBe(1);
    expect(writes.order_lines).toBeUndefined();

    expect(lastTrace(errored)).toMatchObject({ status: 'failed', order: 5001 });
    expect(errored.some((e) => e.includes('permission denied for table orders'))).toBe(true);

    const job = (prisma.syncJob.create as any).mock.calls[0][0].data;
    expect(job).toMatchObject({ shopId: 'shop-1', jobType: 'webhook', status: 'failed' });
    expect(job.errors.message).toContain('permission denied for table orders');
    expect(job.errors.order_webhook.order).toBe(5001);
  });

  it('righe non scritte: l ordine resta, ma il fallimento si vede', async () => {
    mockShop();
    const { writes } = mockSupabase({ order_lines: { message: 'value too long' } });

    const res = await action({ request: req(receipt()) } as any);

    expect(res.status).toBe(200);
    expect(evento().status).toBe('queued');
    expect(writes.orders).toHaveLength(1);
    expect(lastTrace(errored)).toMatchObject({ status: 'failed' });
    expect((prisma.syncJob.create as any).mock.calls[0][0].data.errors.message).toContain(
      'value too long',
    );
  });

  it('corpo illeggibile: 400, nessuna riga, e comunque una traccia', async () => {
    // Cambio di risposta consapevole, e adesso la regola vale per tutti i
    // webhook. Un corpo che non e' JSON non diventera' valido riprovandolo, ma
    // non e' nemmeno qualcosa che si possa dichiarare preso in carico: non
    // c'e' niente da scrivere in posta in arrivo. La traccia resta — un corpo
    // che non si legge vuol dire che a monte qualcosa non va.
    mockShop();
    mockSupabase();

    const res = await action({ request: req('{ questo non e JSON') } as any);

    expect(res.status).toBe(400);
    expect(store.righe).toHaveLength(0);
    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(errored.some((e) => e.includes('corpo non leggibile come JSON'))).toBe(true);
  });

  it('rilettura non riuscita: l evento resta da lavorare', async () => {
    // Diverso da "ordine sparito": qui l'API non ha risposto, e non sappiamo
    // niente. Su un non-letto non si scrive e non si cancella.
    mockShop();
    const { writes } = mockSupabase();
    getOrderById.mockRejectedValue(new Error('Shopify API error: 503'));

    const res = await action({ request: req(receipt()) } as any);

    expect(res.status).toBe(200);
    expect(evento().status).toBe('queued');
    expect(evento().lastError).toContain('Shopify API error: 503');
    expect(writes.orders).toBeUndefined();
  });

  it('database dell app irraggiungibile: l evento resta da lavorare', async () => {
    (prisma.shop.findUnique as any).mockRejectedValue(new Error('connection refused'));
    mockSupabase();

    const res = await action({ request: req(receipt()) } as any);

    expect(res.status).toBe(200);
    expect(evento().status).toBe('queued');
    expect(evento().completedAt).toBeNull();
    expect(evento().lastError).toContain('connection refused');
  });
});

describe('webhook orders — quando non c e niente da fare', () => {
  it('ordine non piu leggibile: non si scrive, ma l identificativo si conserva', async () => {
    // Sparito fra la notifica e la rilettura, o fuori dalla finestra che il
    // negozio ci concede. Della ricevuta resta l'unica cosa che ha — l'id —
    // perche' quell'ordine sia ritrovabile invece di sparire in silenzio.
    mockShop();
    const { writes, deletes } = mockSupabase();
    getOrderById.mockResolvedValue(null);

    const res = await action({ request: req(receipt()) } as any);

    expect(res.status).toBe(200);
    expect(writes.orders).toBeUndefined();
    expect(deletes).toHaveLength(0);
    expect(lastTrace(logged)).toMatchObject({
      status: 'skipped',
      order: 5001,
      detail: 'ordine non piu leggibile su Shopify',
    });

    const job = (prisma.syncJob.create as any).mock.calls[0][0].data;
    expect(job.jobType).toBe('order_repair_pending');
    expect(job.errors.order_repair.order).toBe(5001);
  });

  it('payload senza id: si acknowledgia senza cercare nemmeno il negozio', async () => {
    mockShop();
    mockSupabase();

    const res = await action({ request: req({ line_items: [] }) } as any);

    expect(res.status).toBe(200);
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
    expect(getOrderById).not.toHaveBeenCalled();
    expect(lastTrace(logged)).toMatchObject({ status: 'skipped' });
  });

  it('permesso sugli ordini non concesso: non si rilegge nemmeno', async () => {
    mockShop({ scopes: 'read_products' });
    mockSupabase();

    await action({ request: req(receipt()) } as any);

    expect(getOrderById).not.toHaveBeenCalled();
    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(lastTrace(logged)).toMatchObject({ status: 'skipped' });
  });

  it('nessun progetto collegato: niente scritture', async () => {
    mockShop({ supabaseConfig: null });
    mockSupabase();

    await action({ request: req(receipt()) } as any);

    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(lastTrace(logged)).toMatchObject({ status: 'skipped' });
  });

  /**
   * Le due condizioni che qui mancavano.
   *
   * Il collegamento e il permesso sugli ordini si guardavano gia'. Non si
   * guardava se il negozio fosse ancora autorizzato, ne' se avesse
   * disinstallato — ed e' l'unica strada che non passa da nessuna schermata:
   * l'ordine arriva perche' qualcuno ha comprato, non perche' il merchant abbia
   * premuto qualcosa.
   */
  it("uso dell'app sospeso: l ordine non si scrive", async () => {
    mockShop({ authorization: 'DISABLED' });
    mockSupabase();

    const res = await action({ request: req(receipt()) } as any);

    expect(res.status).toBe(200);
    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(lastTrace(logged)).toMatchObject({ status: 'skipped' });
  });

  it('app disinstallata: l ordine non si scrive', async () => {
    mockShop({ uninstalledAt: new Date('2026-05-01T00:00:00Z') });
    mockSupabase();

    await action({ request: req(receipt()) } as any);

    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(lastTrace(logged)).toMatchObject({ status: 'skipped' });
  });

  it('valore inatteso nella colonna: in dubbio non si scrive', async () => {
    mockShop({ authorization: 'DISABLD' });
    mockSupabase();

    await action({ request: req(receipt()) } as any);

    expect(createSupabaseClient).not.toHaveBeenCalled();
  });

  // Il motivo del rifiuto non si butta: e' l'unica cosa che poi permette di
  // capire perche' un ordine non si trova. Le due frasi storiche restano
  // parola per parola, cosi' chi le riconosce in un registro non deve
  // reimpararle.
  it('il registro dice PERCHE l ordine e stato saltato', async () => {
    // Tre consegne DISTINTE: con lo stesso identificativo sarebbero la stessa,
    // e la deduplica — giustamente — non lavorerebbe le ultime due.
    mockShop({ scopes: 'read_products' });
    mockSupabase();
    await action({ request: req(receipt(), 'consegna-1') } as any);
    expect(lastTrace(logged)).toMatchObject({
      detail: 'permesso sugli ordini non concesso',
    });

    mockShop({ supabaseConfig: null });
    await action({ request: req(receipt(), 'consegna-2') } as any);
    expect(lastTrace(logged)).toMatchObject({
      detail: 'nessun progetto collegato e verificato: non c e dove scrivere',
    });

    mockShop({ authorization: 'DISABLED' });
    await action({ request: req(receipt(), 'consegna-3') } as any);
    expect(lastTrace(logged)).toMatchObject({
      detail: 'uso dell app sospeso: la sincronizzazione e ferma',
    });
  });
});

/**
 * L'ordine come momento in cui un browser si rivela.
 *
 * E' il legame piu' forte che esista: nella stessa busta arrivano l'id del
 * cliente Shopify e l'identificativo del browser che ha riempito il carrello.
 * Non serve che il cliente abbia fatto login, basta che abbia comprato.
 *
 * E' anche l'unica cosa per cui la ricevuta resta insostituibile: gli attributi
 * del carrello in GraphQL non ci sono, e la rilettura non li porterebbe.
 */
describe('webhook orders — il browser che ha comprato', () => {
  const VISITATORE = 'corew_1700000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  /** L'attributo di carrello, com'e' scritto nel corpo REST del webhook. */
  function conAttributo(value: string, name = '_corew_external_id') {
    return receipt({
      note_attributes: [{ name: 'consegna', value: 'al piano' }, { name, value }],
    });
  }

  it('lega il browser al cliente leggendo l attributo di carrello', async () => {
    mockShop();
    mockSupabase();

    await action({ request: req(conAttributo(VISITATORE)) } as any);

    expect(linkUserToCustomer).toHaveBeenCalledWith(
      expect.anything(),
      { externalId: VISITATORE, shopifyCustomerId: 77 },
      expect.any(Function),
    );
  });

  it('l attributo si chiama con l underscore davanti, che per Shopify vuol dire privato', async () => {
    // Senza l'underscore l'identificativo comparirebbe nel carrello e sulla
    // conferma d'ordine del cliente: rumore per chi compra e una domanda in
    // piu' per il merchant.
    mockShop();
    mockSupabase();

    await action({ request: req(conAttributo(VISITATORE, 'corew_external_id')) } as any);

    expect(linkUserToCustomer).not.toHaveBeenCalled();
  });

  it('acquisto come ospite: non c e nessuno a cui legare il browser', async () => {
    mockShop();
    mockSupabase();

    const payload = { ...conAttributo(VISITATORE), customer: null };
    await action({ request: req(payload) } as any);

    expect(linkUserToCustomer).not.toHaveBeenCalled();
  });

  it('negozio senza tracciamento configurato: nessun attributo, nessun legame', async () => {
    mockShop();
    mockSupabase();

    await action({ request: req(receipt()) } as any);

    expect(linkUserToCustomer).not.toHaveBeenCalled();
  });

  it('un valore inventato nel carrello non entra nella tabella', async () => {
    // Nel carrello puo' scrivere chiunque: un tema, un'altra app, il cliente
    // con la console aperta.
    mockShop();
    mockSupabase();

    await action({ request: req(conAttributo('pippo')) } as any);

    expect(linkUserToCustomer).not.toHaveBeenCalled();
  });

  it('il legame non puo far fallire il webhook, ne fermare la scrittura delle righe', async () => {
    mockShop();
    const { writes } = mockSupabase();
    linkUserToCustomer.mockRejectedValueOnce(new Error('supabase giu'));

    const res = await action({ request: req(conAttributo(VISITATORE)) } as any);

    expect(res.status).toBe(200);
    expect(writes.orders).toHaveLength(1);
    expect(writes.order_lines).toHaveLength(2);
    expect(lastTrace(logged)).toMatchObject({ status: 'completed' });
  });
});
