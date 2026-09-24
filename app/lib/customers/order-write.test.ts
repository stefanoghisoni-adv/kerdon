import { describe, it, expect } from 'vitest';
import { applyOrderToMerchant, OrderWriteError } from './order-write.server';
import type { ShopifyOrder, ShopifyOrderLine } from './order-rows';

const SYNCED = new Date('2026-08-24T10:00:00Z');

const line = (over: Partial<ShopifyOrderLine> = {}): ShopifyOrderLine => ({
  id: 900,
  title: 'Maglia',
  quantity: 1,
  current_quantity: 1,
  product_id: 10,
  variant_id: 20,
  unit_price: '19.95',
  total_discount: '0.00',
  line_net_total: '19.95',
  line_currency: 'EUR',
  ...over,
});

const order = (over: Partial<ShopifyOrder> = {}): ShopifyOrder => ({
  id: 111,
  order_number: '#1001',
  placed_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:05:00Z',
  cancelled_at: null,
  financial_status: 'paid',
  total_price: '19.95',
  currency: 'EUR',
  customer_id: 55,
  customer_first_name: 'Anna',
  customer_last_name: 'Rossi',
  lines: [line()],
  lines_complete: true,
  ...over,
});

/**
 * Un database del merchant finto ma con la memoria: tiene le righe scritte per
 * chiave, cosi' due scritture della stessa riga si vedono per quello che sono —
 * una sola riga, non due.
 */
function fakeSupabase(opts: { failOn?: 'orders' | 'order_lines' | 'delete' } = {}) {
  const tables: Record<string, Map<string | number, any>> = {
    orders: new Map(),
    order_lines: new Map(),
  };
  /** Ogni cancellazione tentata: chi, con quali ordini e quali righe da tenere. */
  const deletes: { orderIds: number[]; keep: string | null }[] = [];

  const key = (table: string) =>
    table === 'orders' ? 'shopify_order_id' : 'shopify_line_id';

  const client = {
    from(table: string) {
      return {
        async upsert(rows: any[]) {
          if (opts.failOn === table) return { error: { message: `permission denied for ${table}` } };
          for (const row of rows) tables[table].set(row[key(table)], row);
          return { error: null };
        },
        delete() {
          let orderIds: number[] = [];
          let keep: string | null = null;

          const builder: any = {
            eq(_col: string, value: number) {
              orderIds = [value];
              return builder;
            },
            in(_col: string, values: number[]) {
              orderIds = values;
              return builder;
            },
            not(_col: string, _op: string, list: string) {
              keep = list;
              return builder;
            },
            select() {
              deletes.push({ orderIds, keep });
              if (opts.failOn === 'delete') {
                return Promise.resolve({ data: null, error: { message: 'delete refused' } });
              }

              const kept = new Set(
                keep === null
                  ? []
                  : keep
                      .slice(1, -1)
                      .split(',')
                      .filter(Boolean)
                      .map(Number),
              );
              const removed: any[] = [];
              for (const [id, row] of tables.order_lines) {
                if (!orderIds.includes(row.shopify_order_id)) continue;
                if (kept.has(Number(id))) continue;
                removed.push(row);
                tables.order_lines.delete(id);
              }
              return Promise.resolve({ data: removed, error: null });
            },
          };

          return builder;
        },
      };
    },
  };

  return { client: client as any, tables, deletes };
}

describe('applyOrderToMerchant — l ordine e le sue righe', () => {
  it('scrive prima l ordine e poi le righe', async () => {
    const db = fakeSupabase();

    const result = await applyOrderToMerchant({
      supabase: db.client,
      order: order(),
      syncedAt: SYNCED,
    });

    expect(result).toMatchObject({ lines: 1, deleted: 0, repairPending: false });
    expect(db.tables.orders.get(111)).toMatchObject({ shopify_order_id: 111, total_price: 19.95 });
    expect(db.tables.order_lines.get(900)).toMatchObject({
      shopify_line_id: 900,
      current_quantity: 1,
      line_net_total: 19.95,
      line_currency: 'EUR',
    });
  });

  it('un ordine senza righe si scrive lo stesso', async () => {
    // Vale per i totali del negozio anche quando non ha nulla da raggruppargli
    // sotto: un ordine di soli servizi, per dire.
    const db = fakeSupabase();

    const result = await applyOrderToMerchant({
      supabase: db.client,
      order: order({ lines: [] }),
      syncedAt: SYNCED,
    });

    expect(result).toMatchObject({ lines: 0 });
    expect(db.tables.orders.size).toBe(1);
  });

  it('l ordine non scritto ferma tutto: righe orfane non ne restano', async () => {
    const db = fakeSupabase({ failOn: 'orders' });

    await expect(
      applyOrderToMerchant({ supabase: db.client, order: order(), syncedAt: SYNCED }),
    ).rejects.toMatchObject({ step: 'order' });

    expect(db.tables.order_lines.size).toBe(0);
  });

  it('le righe non scritte si dichiarano come tali, non come ordine mancato', async () => {
    // Il passo che e' fallito e' cio' che poi finisce nel registro: "ordine non
    // scritto" e "righe non scritte" mandano chi legge in due direzioni diverse.
    const db = fakeSupabase({ failOn: 'order_lines' });

    const error = await applyOrderToMerchant({
      supabase: db.client,
      order: order(),
      syncedAt: SYNCED,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(OrderWriteError);
    expect(error.step).toBe('lines');
    expect(db.tables.orders.size).toBe(1);
  });
});

/**
 * Cancellare per differenza e' l'unica operazione di questo modulo che puo'
 * distruggere dati veri. Quando e' permessa e quando no e' tutto il file.
 */
describe('applyOrderToMerchant — riconciliazione', () => {
  it('elenco completo: la riga sparita dall ordine viene tolta', async () => {
    const db = fakeSupabase();

    // Prima l'ordine con due righe.
    await applyOrderToMerchant({
      supabase: db.client,
      order: order({ lines: [line({ id: 900 }), line({ id: 901, variant_id: 21 })] }),
      syncedAt: SYNCED,
    });
    expect(db.tables.order_lines.size).toBe(2);

    // Poi il merchant ne toglie una, e Shopify ce lo racconta per intero.
    const result = await applyOrderToMerchant({
      supabase: db.client,
      order: order({ lines: [line({ id: 900 })], lines_complete: true }),
      syncedAt: SYNCED,
    });

    expect(result).toMatchObject({ deleted: 1, repairPending: false });
    expect([...db.tables.order_lines.keys()]).toEqual([900]);
  });

  it('elenco incompleto: non si cancella niente e la riparazione si dichiara', async () => {
    // "Questa riga non l'ho vista" non vuol dire "questa riga non c'e' piu'":
    // vuol dire che si e' letto fino a cento. Cancellare li' significa
    // cancellare righe che esistono, e proprio negli ordini piu' grandi.
    const db = fakeSupabase();

    await applyOrderToMerchant({
      supabase: db.client,
      order: order({ lines: [line({ id: 900 }), line({ id: 901 })] }),
      syncedAt: SYNCED,
    });

    const cancellazioniPrima = db.deletes.length;

    const result = await applyOrderToMerchant({
      supabase: db.client,
      order: order({ lines: [line({ id: 900 })], lines_complete: false }),
      syncedAt: SYNCED,
    });

    expect(result).toMatchObject({ deleted: 0, repairPending: true });
    expect(db.tables.order_lines.size).toBe(2);
    // Nessuna cancellazione nemmeno tentata: non e' un fallimento, e' un divieto.
    expect(db.deletes).toHaveLength(cancellazioniPrima);
  });

  it('elenco completo e vuoto: l ordine perde tutte le sue righe', async () => {
    // Qui l'elenco vuoto e' l'elenco vero, e va distinto dal caso in cui non si
    // e' letto niente — ci si arriva solo con `lines_complete === true`.
    const db = fakeSupabase();

    await applyOrderToMerchant({
      supabase: db.client,
      order: order({ lines: [line({ id: 900 })] }),
      syncedAt: SYNCED,
    });

    const result = await applyOrderToMerchant({
      supabase: db.client,
      order: order({ lines: [], lines_complete: true }),
      syncedAt: SYNCED,
    });

    expect(result).toMatchObject({ deleted: 1 });
    expect(db.tables.order_lines.size).toBe(0);
    expect(db.tables.orders.size).toBe(1);
  });

  it('una cancellazione non riuscita non fa fallire la scrittura, ma si vede', async () => {
    // Ordine e righe correnti sono gia' scritti e sono la parte che conta:
    // farlo fallire qui vorrebbe dire far ripetere una consegna gia' andata
    // quasi tutta bene.
    //
    // Ma `repairPending` deve dirlo. Prima tornava `false` — indistinguibile da
    // "non c'era niente da togliere" — e chi chiamava non aveva modo di sapere
    // che qualcosa era rimasto indietro: "la toglie il tentativo dopo" era una
    // speranza senza nessuno che la mantenesse.
    const db = fakeSupabase({ failOn: 'delete' });

    const result = await applyOrderToMerchant({
      supabase: db.client,
      order: order(),
      syncedAt: SYNCED,
    });

    expect(result).toMatchObject({ lines: 1, deleted: 0, repairPending: true });
    expect(db.tables.orders.size).toBe(1);
  });

  it('un ordine senza id non si scrive affatto', async () => {
    const db = fakeSupabase();
    const result = await applyOrderToMerchant({
      supabase: db.client,
      order: order({ id: null }),
      syncedAt: SYNCED,
    });

    expect(result).toBeNull();
    expect(db.tables.orders.size).toBe(0);
  });
});

/**
 * Shopify riprova le consegne, e non promette di consegnarle una alla volta.
 * Il rimedio non e' un lucchetto: e' che ripetere non cambi il risultato.
 */
describe('applyOrderToMerchant — la stessa busta due volte', () => {
  it('lo stesso webhook ritentato lascia lo stesso stato, senza righe doppie', async () => {
    const db = fakeSupabase();
    const stesso = order({ lines: [line({ id: 900 }), line({ id: 901 })] });

    const primo = await applyOrderToMerchant({ supabase: db.client, order: stesso, syncedAt: SYNCED });
    const secondo = await applyOrderToMerchant({ supabase: db.client, order: stesso, syncedAt: SYNCED });

    expect(secondo).toEqual(primo);
    expect(db.tables.orders.size).toBe(1);
    expect(db.tables.order_lines.size).toBe(2);
  });

  it('due consegne in parallelo arrivano allo stesso risultato', async () => {
    // Non c'e' lucchetto e non serve: sono upsert su chiavi univoche, e la
    // cancellazione per differenza guarda l'elenco di quella consegna, che nei
    // due casi e' lo stesso.
    const db = fakeSupabase();
    const stesso = order({ lines: [line({ id: 900 }), line({ id: 901 })] });

    await Promise.all([
      applyOrderToMerchant({ supabase: db.client, order: stesso, syncedAt: SYNCED }),
      applyOrderToMerchant({ supabase: db.client, order: stesso, syncedAt: SYNCED }),
    ]);

    expect(db.tables.orders.size).toBe(1);
    expect(db.tables.order_lines.size).toBe(2);
    expect([...db.tables.order_lines.keys()].sort()).toEqual([900, 901]);
  });

  it('una consegna vecchia e una nuova in parallelo non si cancellano a vicenda', async () => {
    // La nuova ha una riga in meno (rimossa dall'ordine), la vecchia ce l'ha
    // ancora. Qualunque sia l'ordine di arrivo, il database resta coerente con
    // UNA delle due e non con un miscuglio: nessuna riga orfana, nessun
    // doppione.
    const db = fakeSupabase();
    const vecchia = order({ lines: [line({ id: 900 }), line({ id: 901 })] });
    const nuova = order({ lines: [line({ id: 900 })] });

    await Promise.all([
      applyOrderToMerchant({ supabase: db.client, order: nuova, syncedAt: SYNCED }),
      applyOrderToMerchant({ supabase: db.client, order: vecchia, syncedAt: SYNCED }),
    ]);

    expect(db.tables.orders.size).toBe(1);
    expect(db.tables.order_lines.has(900)).toBe(true);
    expect(db.tables.order_lines.size).toBeLessThanOrEqual(2);
  });
});

describe('applyOrderToMerchant — le valute non si mescolano', () => {
  it('ogni riga scrive la valuta che ha dichiarato', async () => {
    // Non si corregge e non si uniforma: a rifiutarsi di sommare due valute e'
    // il conto, e per farlo deve poter vedere che sono due.
    const db = fakeSupabase();

    await applyOrderToMerchant({
      supabase: db.client,
      order: order({
        currency: 'EUR',
        lines: [line({ id: 900, line_currency: 'EUR' }), line({ id: 901, line_currency: 'USD' })],
      }),
      syncedAt: SYNCED,
    });

    expect(db.tables.order_lines.get(900).line_currency).toBe('EUR');
    expect(db.tables.order_lines.get(901).line_currency).toBe('USD');
    expect(db.tables.orders.get(111).currency).toBe('EUR');
  });
});

describe('applyOrderToMerchant — costo logistico', () => {
  it('la configurazione passata da chi chiama finisce nel costo dell ordine', async () => {
    const db = fakeSupabase();

    await applyOrderToMerchant({
      supabase: db.client,
      order: order({ fulfillment_status: 'FULFILLED', shipping_country_code: 'IT', total_weight_grams: 1000 }),
      syncedAt: SYNCED,
      logisticsConfig: {
        zones: [
          { zoneName: 'Italia', countries: ['IT'], restOfWorld: false, rateType: 'linear', rates: [{ weightFromKg: null, weightToKg: null, cost: 3 }] },
        ],
        categories: [],
        fallbackRules: [],
        defaultWeightPerItemKg: null,
        returnCost: null,
      },
    });

    expect(db.tables.orders.get(111).logistics_cost).toBe(3);
  });

  it('senza configurazione scrive zero', async () => {
    const db = fakeSupabase();
    await applyOrderToMerchant({ supabase: db.client, order: order(), syncedAt: SYNCED });
    expect(db.tables.orders.get(111).logistics_cost).toBe(0);
  });
});
