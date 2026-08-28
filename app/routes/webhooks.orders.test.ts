import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('~/lib/webhooks/verify.server', () => ({ verifyWebhook: () => true }));
vi.mock('~/lib/supabase.server', () => ({ createSupabaseClient: vi.fn() }));
vi.mock('~/db.server', () => ({
  prisma: { shop: { findUnique: vi.fn() }, syncJob: { create: vi.fn() } },
}));

// Il riconoscimento del visitatore: qui interessa che il webhook gli passi la
// coppia giusta — id cliente e identificativo del browser — non cosa scrive.
// Quello ha i suoi test, in lib/tracking/users.server.test.
// `vi.hoisted` perche' la fabbrica del mock viene issata sopra a tutto: una
// costante dichiarata qui sotto, al momento in cui la fabbrica gira, non
// esisterebbe ancora.
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

import { action } from './webhooks.orders';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';

function req(body: unknown) {
  return new Request('https://app/webhooks/orders', {
    method: 'POST',
    headers: {
      'X-Shopify-Hmac-Sha256': 'sig',
      'X-Shopify-Shop-Domain': 'test-shop.myshopify.com',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Negozio collegato, verificato, con il permesso sugli ordini. */
function mockShop(over: Record<string, unknown> = {}) {
  (prisma.shop.findUnique as any).mockResolvedValue({
    id: 'shop-1',
    shopDomain: 'test-shop.myshopify.com',
    scopes: 'read_products,read_orders,read_all_orders',
    supabaseConfig: { connectionVerifiedAt: new Date(), tableNameProducts: 'products' },
    ...over,
  });
  (prisma.syncJob.create as any).mockResolvedValue({});
}

/**
 * Un client Supabase che raccoglie quel che gli si scrive, tabella per tabella,
 * e che sa anche fallire su richiesta.
 */
function mockSupabase(errors: Record<string, { message: string; code?: string }> = {}) {
  const writes: Record<string, any[]> = {};
  const tablesTouched: string[] = [];

  (createSupabaseClient as any).mockReturnValue({
    from: (table: string) => ({
      upsert: async (rows: any[]) => {
        tablesTouched.push(table);
        if (errors[table]) return { error: errors[table] };
        writes[table] = [...(writes[table] ?? []), ...rows];
        return { error: null };
      },
    }),
  });

  return { writes, tablesTouched };
}

/** Il corpo REST di `orders/create`, ridotto ai campi che il webhook guarda. */
function orderPayload(over: Record<string, unknown> = {}) {
  return {
    id: 5001,
    name: '#1042',
    order_number: 1042,
    created_at: '2026-08-27T09:12:00+02:00',
    updated_at: '2026-08-27T09:12:03+02:00',
    cancelled_at: null,
    financial_status: 'paid',
    total_price: '119.80',
    current_total_price: '119.80',
    currency: 'EUR',
    customer: { id: 77, first_name: 'Anna', last_name: 'Rossi' },
    line_items: [
      {
        id: 9001,
        title: 'Felpa',
        name: 'Felpa - L',
        quantity: 2,
        product_id: 301,
        variant_id: 401,
        price: '49.90',
        total_discount: '0.00',
        discount_allocations: [{ amount: '9.98' }],
      },
      {
        id: 9002,
        title: 'Cappello',
        name: 'Cappello - Unica',
        quantity: 1,
        product_id: 302,
        variant_id: 402,
        price: '19.90',
        total_discount: '0.00',
        discount_allocations: [],
      },
    ],
    ...over,
  };
}

let logged: string[];
let warned: string[];
let errored: string[];

beforeEach(() => {
  vi.clearAllMocks();
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

describe('webhook orders — l ordine arriva davvero su Supabase', () => {
  it('scrive ordine e righe da un payload REST vero', async () => {
    // QUESTO E' IL TEST CHE PRIMA FALLIVA. Il payload del webhook veniva passato
    // grezzo a `orderToRows`, che si aspetta la forma normalizzata: `lines` era
    // undefined, il TypeError finiva nel catch, e su Supabase non arrivava mai
    // niente. `writes` restava vuoto e la risposta era 200 lo stesso.
    mockShop();
    const { writes } = mockSupabase();

    const res = await action({ request: req(orderPayload()) } as any);

    expect(res.status).toBe(200);
    expect(writes.orders).toHaveLength(1);
    expect(writes.orders[0]).toMatchObject({
      shopify_order_id: 5001,
      order_number: '#1042',
      shopify_customer_id: 77,
      customer_first_name: 'Anna',
      currency: 'EUR',
      total_price: 119.8,
      financial_status: 'paid',
      cancelled_at: null,
      placed_at: '2026-08-27T09:12:00+02:00',
    });

    expect(writes.order_lines).toHaveLength(2);
    expect(writes.order_lines[0]).toMatchObject({
      shopify_line_id: 9001,
      shopify_order_id: 5001,
      shopify_product_id: 301,
      shopify_variant_id: 401,
      title: 'Felpa',
      quantity: 2,
      // 49.90 x 2 meno 9.98 di sconto, su due unita': il prezzo pagato.
      unit_price: 44.91,
    });
    expect(writes.order_lines[1]).toMatchObject({
      shopify_line_id: 9002,
      shopify_variant_id: 402,
      quantity: 1,
      unit_price: 19.9,
    });
  });

  it('lascia una traccia leggibile anche quando e andato tutto bene', async () => {
    mockShop();
    mockSupabase();

    await action({ request: req(orderPayload()) } as any);

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

  it('un ordine senza righe scrive comunque l ordine', async () => {
    mockShop();
    const { writes, tablesTouched } = mockSupabase();

    await action({ request: req(orderPayload({ line_items: [] })) } as any);

    expect(writes.orders).toHaveLength(1);
    expect(writes.orders[0].shopify_order_id).toBe(5001);
    // Nessuna riga da scrivere: la seconda tabella non si tocca nemmeno.
    expect(tablesTouched).toEqual(['orders']);
    expect(lastTrace(logged)).toMatchObject({ status: 'completed', lines: 0 });
  });

  it('un ordine annullato si scrive lo stesso, con la data di annullamento', async () => {
    // Non e' la sincronizzazione a escluderlo dal profitto: e' il conto, che
    // guarda `cancelled_at`. Toglierlo qui vorrebbe dire un ordine che il
    // merchant vede su Shopify e non trova nel suo database.
    mockShop();
    const { writes } = mockSupabase();

    await action({
      request: req(
        orderPayload({
          cancelled_at: '2026-08-27T11:00:00+02:00',
          financial_status: 'voided',
          current_total_price: '0.00',
        }),
      ),
    } as any);

    expect(writes.orders[0]).toMatchObject({
      shopify_order_id: 5001,
      cancelled_at: '2026-08-27T11:00:00+02:00',
      financial_status: 'voided',
      total_price: 0,
    });
    expect(writes.order_lines).toHaveLength(2);
  });

  it('un ordine interamente rimborsato porta il totale corrente, non quello originale', async () => {
    mockShop();
    const { writes } = mockSupabase();

    await action({
      request: req(
        orderPayload({
          financial_status: 'refunded',
          total_price: '119.80',
          current_total_price: '0.00',
        }),
      ),
    } as any);

    expect(writes.orders[0]).toMatchObject({ financial_status: 'refunded', total_price: 0 });
  });
});

describe('webhook orders — il corpo del webhook non e tutto l ordine', () => {
  it('oltre le cento righe si scrive quel che c e, dichiarandolo incompleto', async () => {
    mockShop();
    const { writes } = mockSupabase();

    const line_items = Array.from({ length: 120 }, (_, i) => ({
      id: 9000 + i,
      title: `Riga ${i}`,
      quantity: 1,
      product_id: 300,
      variant_id: 400 + i,
      price: '1.00',
    }));

    await action({ request: req(orderPayload({ line_items })) } as any);

    // Le righe presenti si scrivono: un elenco monco non e' un motivo per non
    // scrivere quel che si e' ricevuto.
    expect(writes.order_lines).toHaveLength(120);
    // Ma non lo si spaccia per completo, e lo si dice ad alta voce.
    expect(lastTrace(logged)).toMatchObject({ status: 'completed', lines_complete: false });
    expect(warned.some((w) => w.includes('troncato'))).toBe(true);
  });
});

describe('webhook orders — un errore non sparisce piu in silenzio', () => {
  it('ordine non scritto: traccia nel log e riga nel registro dei job', async () => {
    mockShop();
    const { writes } = mockSupabase({ orders: { message: 'permission denied for table orders' } });

    const res = await action({ request: req(orderPayload()) } as any);

    // A Shopify si continua a rispondere 200: un 500 farebbe ritentare e alla
    // lunga spegnerebbe la sottoscrizione.
    expect(res.status).toBe(200);
    // Le righe non si scrivono senza l'ordine che le raggruppa.
    expect(writes.order_lines).toBeUndefined();

    expect(lastTrace(errored)).toMatchObject({ status: 'failed', order: 5001 });
    expect(errored.some((e) => e.includes('permission denied for table orders'))).toBe(true);

    expect(prisma.syncJob.create).toHaveBeenCalledTimes(1);
    const job = (prisma.syncJob.create as any).mock.calls[0][0].data;
    expect(job).toMatchObject({ shopId: 'shop-1', jobType: 'webhook', status: 'failed' });
    expect(job.errors.message).toContain('permission denied for table orders');
    expect(job.errors.order_webhook.order).toBe(5001);
  });

  it('righe non scritte: l ordine resta, ma il fallimento si vede', async () => {
    mockShop();
    const { writes } = mockSupabase({ order_lines: { message: 'value too long' } });

    await action({ request: req(orderPayload()) } as any);

    expect(writes.orders).toHaveLength(1);
    expect(lastTrace(errored)).toMatchObject({ status: 'failed' });
    expect((prisma.syncJob.create as any).mock.calls[0][0].data.errors.message).toContain(
      'value too long',
    );
  });

  it('corpo illeggibile: nessuna scrittura, ma una riga di errore', async () => {
    mockShop();
    mockSupabase();

    const res = await action({ request: req('{ questo non e JSON') } as any);

    expect(res.status).toBe(200);
    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(lastTrace(errored)).toMatchObject({ status: 'failed', order: null });
  });

  it('database dell app irraggiungibile: si risponde 200 e lo si scrive nel log', async () => {
    (prisma.shop.findUnique as any).mockRejectedValue(new Error('connection refused'));
    mockSupabase();

    const res = await action({ request: req(orderPayload()) } as any);

    expect(res.status).toBe(200);
    expect(lastTrace(errored)).toMatchObject({ status: 'failed', detail: 'connection refused' });
  });
});

describe('webhook orders — quando non c e niente da fare', () => {
  it('payload senza id: si acknowledgia senza cercare nemmeno il negozio', async () => {
    mockShop();
    mockSupabase();

    const res = await action({ request: req({ line_items: [] }) } as any);

    expect(res.status).toBe(200);
    expect(prisma.shop.findUnique).not.toHaveBeenCalled();
    expect(lastTrace(logged)).toMatchObject({ status: 'skipped' });
  });

  it('permesso sugli ordini non concesso: non si prova nemmeno a scrivere', async () => {
    mockShop({ scopes: 'read_products' });
    mockSupabase();

    await action({ request: req(orderPayload()) } as any);

    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(lastTrace(logged)).toMatchObject({ status: 'skipped' });
  });

  it('nessun progetto collegato: niente scritture', async () => {
    mockShop({ supabaseConfig: null });
    mockSupabase();

    await action({ request: req(orderPayload()) } as any);

    expect(createSupabaseClient).not.toHaveBeenCalled();
    expect(lastTrace(logged)).toMatchObject({ status: 'skipped' });
  });
});

/**
 * L'ordine come momento in cui un browser si rivela.
 *
 * E' il legame piu' forte che esista: nella stessa busta arrivano l'id del
 * cliente Shopify e l'identificativo del browser che ha riempito il carrello.
 * Non serve che il cliente abbia fatto login, basta che abbia comprato.
 */
describe('webhook orders — il browser che ha comprato', () => {
  const VISITATORE = 'corew_1700000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  /** L'attributo di carrello, com'e' scritto nel corpo REST del webhook. */
  function conAttributo(value: string, name = '_corew_external_id') {
    return orderPayload({ note_attributes: [{ name: 'consegna', value: 'al piano' }, { name, value }] });
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

    await action({ request: req(orderPayload()) } as any);

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
