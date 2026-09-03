// Processor implementations for background sync jobs
import type { SyncJobData } from '../queue/queues.server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ShopifyAPIClient } from '../shopify-api.server';
import { transformProduct } from '../transformers/product.server';
import { transformCustomer } from '../transformers/customer.server';
import { createSupabaseClient } from '../supabase.server';
import { prisma } from '../../db.server';
import { isProductLimitReached } from '../limits/product-limit';
import { enrichVariantCosts } from '../stats/inventory-cost.server';
import { filterEligibleProductRows } from '../eligibility/product-eligibility';
import { sortByCreatedAtAsc } from '../sync/product-order';
import { orderToRows } from '../customers/order-rows';
import { ensureOrdersTables } from '../supabase/ensure-orders-tables.server';
import {
  createEventBuffer,
  formatProductLabel,
  type SyncEventBuffer,
} from '../sync/job-events';
import { createEventCollector, pruneOldEvents } from '../sync/job-events.server';
import type { ShopifyCustomer, ShopifyProduct, SupabaseProductRow } from '~/types/shopify';
import { isCustomerOptedIn } from '../stats/customer-consent-stats';
import { ensureCustomersTable } from '../supabase/ensure-customers-table.server';
import { ensureProductsTable } from '../supabase/ensure-products-table.server';
import { applyMerchantSchemaUpdate } from '../supabase/apply-schema-update.server';
import { findPlanByName } from '../billing/find-plan.server';
import { can, denialOf } from '~/lib/authz/capabilities';
import { shopCapabilitiesWithPlan } from '~/lib/authz/shop-capabilities.server';
import { WITHDRAWN_CUSTOMER_FIELDS } from '~/lib/customers/consent-withdrawal';
import { isUnknownColumn } from '~/lib/supabase/column-errors';
import { birthdateMetafieldOf, type MetafieldKey } from '~/lib/customers/birthdate-metafield';
import {
  birthdateWritebackTarget,
  planBirthdateWriteback,
  type BirthdateWriteTarget,
} from '~/lib/customers/birthdate-writeback';
import { hasCustomerWriteAccess } from '~/lib/sync/customers-write-access';

// Solo la parte del Job BullMQ che i processor usano davvero. Tipandola cosi'
// il bulk sync puo' girare anche senza coda (allineamento automatico dal cron),
// e un Job vero resta compatibile senza cast.
interface ProgressReporter {
  updateProgress(value: unknown): Promise<unknown> | unknown;
}

/**
 * La tabella dei prodotti dev'esserci prima di qualunque scrittura.
 *
 * Non e' un dettaglio da tollerare come per i clienti: senza tabella prodotti
 * non c'e' nulla da sincronizzare, quindi la corsa si ferma qui — ma con un
 * messaggio che dice cosa manca, invece dell'errore grezzo dell'API REST
 * ("Could not find the table 'public.products' in the schema cache") che
 * arrivava a valle, dopo aver gia' scaricato mezzo catalogo da Shopify.
 */
async function requireProductsTable(
  shopId: string,
  config: Parameters<typeof ensureProductsTable>[1],
  supabase: SupabaseClient,
): Promise<void> {
  const table = await ensureProductsTable(shopId, config, supabase);
  if (table.status === 'unavailable') {
    throw new Error(
      `Tabella prodotti "${config.tableNameProducts}" non disponibile sul database collegato: ricollega il database dalle impostazioni.`,
    );
  }
}

// --- Dettaglio della corsa: righe toccate da delete e update -----------------

interface ReturningResult {
  data?: unknown;
  error?: { message?: string } | null;
}

interface ReturningBuilder extends PromiseLike<ReturningResult> {
  select?: (columns: string) => PromiseLike<ReturningResult>;
}

/**
 * PostgREST restituisce le righe toccate da una delete o da una update solo se
 * ci si concatena `.select(...)`.
 *
 * La concatenazione si tenta e basta: se il client non la espone (client piu'
 * vecchi, doppioni nei test) si aspetta la query com'era e si prosegue senza
 * righe. La scrittura resta identica in entrambi i casi — quello che si perde e'
 * solo il dettaglio, che non deve mai valere quanto la sincronizzazione.
 */
async function runReturningRows<T>(
  pending: ReturningBuilder,
  columns: string,
): Promise<{ rows: T[]; error: { message?: string } | null }> {
  const chained =
    typeof pending.select === 'function' ? pending.select(columns) : pending;
  const result = ((await chained) ?? {}) as ReturningResult;

  return {
    rows: Array.isArray(result.data) ? (result.data as T[]) : [],
    error: result.error ?? null,
  };
}

/** Colonne che bastano a descrivere una riga prodotto sparita. */
const REMOVED_PRODUCT_COLUMNS =
  'shopify_product_id, shopify_variant_id, product_title, variant_title';

interface RemovedProductRow {
  shopify_product_id?: number | null;
  shopify_variant_id?: number | null;
  product_title?: string | null;
  variant_title?: string | null;
}

function collectRemovedProducts(
  events: SyncEventBuffer,
  rows: RemovedProductRow[],
): void {
  for (const row of rows) {
    events.add({
      entity: 'product',
      action: 'removed',
      shopifyId: row.shopify_product_id ?? null,
      variantId: row.shopify_variant_id ?? null,
      label: formatProductLabel(row),
      sublabel: row.variant_title ?? null,
    });
  }
}

function collectAddedProducts(
  events: SyncEventBuffer,
  rows: SupabaseProductRow[],
): void {
  for (const row of rows) {
    events.add({
      entity: 'product',
      action: 'added',
      shopifyId: row.shopify_product_id,
      variantId: row.shopify_variant_id,
      label: formatProductLabel(row),
      sublabel: row.variant_title ?? null,
    });
  }
}

/**
 * Cosa c'e' gia' su Supabase dei clienti di questa pagina, PRIMA dell'upsert —
 * che e' proprio l'operazione che cancella la differenza.
 *
 * Una lettura sola, due usi. Il primo c'era gia': chi compare qui verra'
 * aggiornato, chi manca aggiunto. Il secondo e' la data di nascita che il
 * merchant puo' aver scritto a mano nella sua tabella, e che va riportata su
 * Shopify quando Shopify non ne ha una. Sono la stessa domanda allo stesso
 * insieme di righe: farne due — o peggio, una per cliente — sarebbe un giro a
 * vuoto per ogni pagina di ogni corsa.
 *
 * null quando la lettura non riesce: senza risposta non si tira a indovinare
 * fra aggiunta e aggiornamento, si rinuncia al dettaglio — e non si riscrive
 * niente verso Shopify, perche' non sapere cosa c'e' sul database del merchant
 * non autorizza a indovinare cosa mandargli.
 */
interface ExistingCustomerRow {
  shopify_customer_id?: number | null;
  date_of_birth?: string | null;
}

async function fetchExistingCustomers(
  supabase: SupabaseClient,
  tableName: string,
  ids: number[],
): Promise<Map<number, string | null> | null> {
  if (ids.length === 0) return new Map();

  const read = async (
    columns: string,
  ): Promise<{
    data: ExistingCustomerRow[] | null;
    error: { code?: string; message?: string } | null;
  }> =>
    (await supabase
      .from(tableName)
      .select(columns)
      .in('shopify_customer_id', ids)) as unknown as {
      data: ExistingCustomerRow[] | null;
      error: { code?: string; message?: string } | null;
    };

  try {
    let { data, error } = await read('shopify_customer_id, date_of_birth');

    // Una tabella nata da una versione precedente puo' non avere
    // `date_of_birth`, e PostgREST rifiuta l'intera select per una colonna che
    // non conosce. Il dettaglio aggiunto/aggiornato pero' da quella colonna non
    // dipende: si ripiega sulla sola chiave, e la riscrittura verso Shopify non
    // trovera' semplicemente niente da riportare indietro.
    if (isUnknownColumn(error)) {
      ({ data, error } = await read('shopify_customer_id'));
    }

    if (error || !data) return null;

    const existing = new Map<number, string | null>();
    for (const row of data) {
      if (row.shopify_customer_id == null) continue;
      existing.set(row.shopify_customer_id, row.date_of_birth ?? null);
    }
    return existing;
  } catch (error) {
    console.warn('Lettura dei clienti gia\' presenti fallita:', error);
    return null;
  }
}

/**
 * Riporta su Shopify le date di nascita che vivono solo sul database del
 * merchant.
 *
 * Chi va riscritto lo decide `planBirthdateWriteback`, che di rete non sa
 * niente ed e' testabile da solo; qui restano la chiamata e cio' che si fa
 * quando va storta.
 *
 * E va storta senza fermare niente: i clienti sono gia' scritti sul database
 * del merchant, e il valore che non e' arrivato a Shopify e' ancora dov'era.
 * Alla corsa successiva Shopify sara' ancora vuoto e si ritenta. Far fallire la
 * sincronizzazione dei clienti per una riscrittura che e' un di piu' vorrebbe
 * dire perdere il molto per il poco.
 */
async function writeBackBirthdates(
  shopifyClient: ShopifyAPIClient,
  target: BirthdateWriteTarget,
  optedIn: readonly ShopifyCustomer[],
  stored: ReadonlyMap<number, string | null> | null,
): Promise<void> {
  const { writes, invalid } = planBirthdateWriteback(optedIn, stored);

  // Quello che il merchant ha scritto e non e' una data non si manda a Shopify
  // "corretto a naso": si nomina. Senza questa riga la sua cella resterebbe a
  // meta' per sempre e nessuno saprebbe dirgli perche'.
  if (invalid.length > 0) {
    console.warn(
      `[data di nascita] ${invalid.length} valori non riconoscibili come data sul database del merchant, non riscritti su Shopify (clienti: ${invalid.slice(0, 10).join(', ')})`,
    );
  }

  if (writes.length === 0) return;

  try {
    const { written, errors } = await shopifyClient.setCustomerBirthdates(writes, target);
    if (errors.length > 0) {
      console.warn(
        `[data di nascita] Shopify ha rifiutato ${errors.length} scritture: ${errors.slice(0, 3).join('; ')}`,
      );
    }
    console.log(`[data di nascita] ${written} riportate su Shopify dal database del merchant`);
  } catch (error) {
    console.warn(
      '[data di nascita] riscrittura su Shopify non riuscita:',
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Insieme degli shopify_variant_id gia' presenti nella tabella prodotti, in
 * pagine da 1000 (limite PostgREST). Serve solo al dettaglio: le varianti che
 * non compaiono qui sono le aggiunte di questa corsa.
 *
 * null quando la lettura non riesce: si rinuncia al dettaglio delle aggiunte
 * piuttosto che dichiarare "aggiunto" tutto il catalogo.
 */
async function fetchExistingVariantIds(
  supabase: SupabaseClient,
  tableName: string,
): Promise<Set<number> | null> {
  const ids = new Set<number>();
  const pageSize = 1000;
  let from = 0;

  try {
    for (;;) {
      const { data, error } = await supabase
        .from(tableName)
        .select('shopify_variant_id')
        .range(from, from + pageSize - 1);

      if (error) return null;
      if (!data || data.length === 0) break;

      for (const row of data) {
        if (row.shopify_variant_id != null) ids.add(row.shopify_variant_id as number);
      }
      if (data.length < pageSize) break;
      from += pageSize;
    }
  } catch (error) {
    console.warn('Lettura delle varianti gia\' presenti fallita:', error);
    return null;
  }

  return ids;
}

/** Esito della sync clienti: totale come prima, piu' il dettaglio raccolto. */
interface CustomerSyncResult {
  total: number;
  events: SyncEventBuffer;
}

/**
 * Syncs customers from Shopify into the merchant's Supabase `customers` table.
 * Paginated upsert keyed on shopify_customer_id. When `updatedAtMin` is provided
 * only customers changed since then are fetched (incremental periodic check);
 * otherwise every customer is synced (initial bulk).
 *
 * Caller is responsible for the plan entitlement check (customersSyncEnabled).
 * Returns the number of customers upserted.
 */
async function syncCustomers(
  shopifyClient: ShopifyAPIClient,
  supabase: SupabaseClient,
  tableName: string,
  updatedAtMin?: string,
  /**
   * Il metafield da cui leggere la data di nascita, scelto dal merchant.
   * `null` = non ne ha scelto nessuno, quindi non la si chiede nemmeno e la
   * colonna sul suo database resta com'e'.
   */
  birthdateMetafield?: MetafieldKey | null,
  /**
   * Dove riscrivere la data che vive solo sul database del merchant, o `null`
   * se non si riscrive (permesso mancante, campo non scelto, campo che non e'
   * quello standard). Deciso da `birthdateWritebackTarget` a monte.
   */
  birthdateTarget?: BirthdateWriteTarget | null,
): Promise<CustomerSyncResult> {
  let total = 0;
  let nextPageInfo: string | null = null;
  // Raccoglitore locale, con lo stesso tetto per categoria: su un negozio da
  // centomila clienti tenere una riga di dettaglio per ognuno vorrebbe dire
  // portarsele tutte in memoria fino alla fine della corsa.
  const events = createEventBuffer();

  do {
    const { customers, nextPageInfo: nextPage } = await shopifyClient.getCustomers({
      limit: 250,
      pageInfo: nextPageInfo || undefined,
      updatedAtMin,
      birthdateMetafield: birthdateMetafield ?? null,
    });

    if (!customers || customers.length === 0) break;

    // Due destini diversi per due categorie diverse.
    const page = customers as ShopifyCustomer[];
    const optedIn = page.filter(isCustomerOptedIn);
    const revoked = page.filter((c) => !isCustomerOptedIn(c));
    const rows = optedIn.map(transformCustomer);
    const revokedIds = revoked.map((c) => c.id);

    const alreadyPresent = await fetchExistingCustomers(
      supabase,
      tableName,
      optedIn.map((c) => c.id),
    );

    const chunkSize = 1000;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await supabase.from(tableName).upsert(chunk, {
        onConflict: 'shopify_customer_id',
        ignoreDuplicates: false,
      });

      if (error) {
        throw new Error(`Supabase customer upsert failed: ${error.message}`);
      }
    }

    // La meta' che mancava alla regola: Shopify vince quando ha un valore, ma
    // quando non ce l'ha il valore del merchant non si limita a sopravvivere —
    // torna indietro, sul metafield di Shopify, dove anche i temi, i segmenti e
    // le automazioni possono vederlo. Solo i consenzienti: chi ha detto di no
    // non e' in questo elenco, e non deve esserci.
    //
    // Dopo l'upsert e non prima, per il motivo opposto a quello che verrebbe in
    // mente: non perche' l'upsert cambi qualcosa qui — `alreadyPresent` e'
    // stato letto prima ed e' la fotografia giusta — ma perche' una riscrittura
    // che fallisse a meta' non deve lasciare indietro la scrittura sul database
    // del merchant, che e' il compito principale di questa corsa.
    if (birthdateTarget) {
      await writeBackBirthdates(shopifyClient, birthdateTarget, optedIn, alreadyPresent);
    }

    // Dopo l'upsert: un upsert fallito lancia, e non ha aggiunto nessuno.
    if (alreadyPresent) {
      for (const customer of optedIn) {
        // Solo il conteggio: dei clienti non si tiene nessuna riga di dettaglio
        // sul database dell'applicazione (vedi `count` in job-events.ts).
        events.count('customer', alreadyPresent.has(customer.id) ? 'updated' : 'added');
      }
    }

    // Chi non ha acconsentito non entra: nessuna insert. Ma se una riga sua e'
    // gia' su Supabase — sincronizzata quando il consenso c'era — va marcata,
    // perche' il proxy decide il 403 leggendo proprio questa colonna. Una
    // `update` non crea righe: sui clienti mai sincronizzati e' un no-op.
    if (revokedIds.length > 0) {
      // Una sola colonna, e nessun dato cancellato: la riga resta la fotografia
      // del giorno in cui il consenso c'era. Quello che cambia e' l'uso — da qui
      // in avanti la sincronizzazione non la aggiorna piu' e il proxy si rifiuta
      // di servirla. Il perche' per esteso sta in `consent-withdrawal.ts`.
      const { rows: suspendedRows, error: revokeError } = await runReturningRows<{
        shopify_customer_id?: number | null;
      }>(
        supabase
          .from(tableName)
          .update(WITHDRAWN_CUSTOMER_FIELDS)
          .in('shopify_customer_id', revokedIds) as unknown as ReturningBuilder,
        'shopify_customer_id',
      );

      if (revokeError) {
        // Non fatale: gli opt-in sono gia' scritti, la corsa successiva ritenta.
        console.warn('Marcatura dei consensi revocati fallita:', revokeError.message);
      } else {
        // Sospesi sono solo quelli che la update ha davvero toccato: chi non era
        // mai stato sincronizzato non ha perso nessun accesso, e mostrarlo nel
        // dettaglio farebbe sembrare successo qualcosa che non e' successo.
        const suspendedIds = new Set(
          suspendedRows
            .map((row) => row.shopify_customer_id)
            .filter((id): id is number => id != null),
        );

        for (const customer of revoked) {
          if (!suspendedIds.has(customer.id)) continue;
          events.count('customer', 'suspended');
        }
      }
    }

    total += rows.length;
    nextPageInfo = nextPage;
  } while (nextPageInfo);

  return { total, events };
}

/**
 * Sincronizza i clienti se — e solo se — il piano corrente li include.
 *
 * Regge da sola il passaggio di piano in entrambe le direzioni:
 * - salendo a un piano che include i clienti la tabella puo' non esistere (al
 *   collegamento viene creata solo se il piano di allora la prevedeva): qui
 *   viene creata al volo e popolata da zero, senza sync manuale;
 * - scendendo a un piano che non li include non si scrive piu' nulla, e le
 *   righe gia' presenti restano dove sono (lo storico non si butta).
 *
 * Se la tabella manca e non si riesce a crearla, i clienti vengono saltati con
 * un avviso: la sync dei prodotti deve arrivare in fondo comunque.
 */
async function syncCustomersIfEnabled(opts: {
  shopId: string;
  config: Parameters<typeof ensureCustomersTable>[1];
  customersSyncEnabled: boolean;
  shopifyClient: ShopifyAPIClient;
  supabase: SupabaseClient;
  updatedAtMin?: string;
  /**
   * La riga del negozio, per due cose sole: da quale metafield leggere la data
   * di nascita, e se il negozio ci ha concesso di scriverla. Si passa il
   * negozio e non i due valori gia' estratti perche' chi chiama ce l'ha in
   * mano, e perche' i due viaggiano sempre insieme.
   */
  shop?: {
    scopes?: string | null;
    birthdateMetafieldNamespace?: string | null;
    birthdateMetafieldKey?: string | null;
  } | null;
}): Promise<CustomerSyncResult> {
  if (!opts.customersSyncEnabled) return { total: 0, events: createEventBuffer() };

  const table = await ensureCustomersTable(opts.shopId, opts.config, opts.supabase);
  if (table.status === 'unavailable') {
    console.warn(
      `Tabella clienti non disponibile per lo shop ${opts.shopId}: sync clienti saltata`,
    );
    return { total: 0, events: createEventBuffer() };
  }

  // Tabella ancora vuota (appena creata, o creata in una corsa precedente): non
  // c'e' nessuno storico da aggiornare in delta, quindi si ignora updatedAtMin e
  // si recuperano TUTTI i clienti. E' il caso dell'upgrade di piano, dove il
  // delta lascerebbe la tabella quasi vuota.
  const updatedAtMin = table.empty ? undefined : opts.updatedAtMin;

  const birthdateMetafield = birthdateMetafieldOf(opts.shop);

  return syncCustomers(
    opts.shopifyClient,
    opts.supabase,
    opts.config.tableNameCustomers,
    updatedAtMin,
    birthdateMetafield,
    // Il permesso si constata, non si tenta: un negozio installato quando
    // l'app leggeva soltanto non ha dato `write_customers`, e ogni mutation
    // tornerebbe indietro con un 403 a ogni corsa. Senza permesso si legge e
    // basta, che e' esattamente il comportamento di prima.
    birthdateWritebackTarget(
      birthdateMetafield,
      hasCustomerWriteAccess(opts.shop?.scopes),
    ),
  );
}

interface OrderSyncResult {
  total: number;
  events: ReturnType<typeof createEventBuffer>;
}

/**
 * Gli ordini del negozio, una pagina alla volta.
 *
 * Due tabelle da riempire insieme: l'ordine e le sue righe. Le righe si
 * scrivono dopo l'ordine — se l'upsert dell'ordine fallisce, la corsa si ferma
 * li' e non restano righe orfane che nessuna query saprebbe raggruppare.
 *
 * Nessun conto di margine qui dentro: il profitto nasce quando lo si guarda,
 * incrociando queste righe con il costo che vive nei prodotti.
 */
async function syncOrders(
  shopifyClient: ShopifyAPIClient,
  supabase: SupabaseClient,
  updatedAtMin?: string,
): Promise<OrderSyncResult> {
  let total = 0;
  let nextPageInfo: string | null = null;
  const events = createEventBuffer();

  do {
    const { orders, nextPageInfo: nextPage } = await shopifyClient.getOrders({
      pageInfo: nextPageInfo || undefined,
      updatedAtMin,
    });

    if (!orders || orders.length === 0) break;

    const converted = orders
      .map((order) => orderToRows(order))
      .filter((rows): rows is NonNullable<typeof rows> => rows !== null);

    if (converted.length > 0) {
      const orderRows = converted.map((c) => c.order);
      const { error: ordersError } = await supabase
        .from('orders')
        .upsert(orderRows, { onConflict: 'shopify_order_id', ignoreDuplicates: false });

      if (ordersError) {
        throw new Error(`Supabase order upsert failed: ${ordersError.message}`);
      }

      const lineRows = converted.flatMap((c) => c.lines);
      // A blocchi come i clienti: un ordine da cento righe moltiplica in fretta,
      // e PostgREST ha un tetto a quante ne accetta in una volta.
      const chunkSize = 1000;
      for (let i = 0; i < lineRows.length; i += chunkSize) {
        const { error: linesError } = await supabase
          .from('order_lines')
          .upsert(lineRows.slice(i, i + chunkSize), {
            onConflict: 'shopify_line_id',
            ignoreDuplicates: false,
          });

        if (linesError) {
          throw new Error(`Supabase order line upsert failed: ${linesError.message}`);
        }
      }

      // Solo il conteggio, come per i clienti: degli ordini non si tiene
      // nessuna riga di dettaglio sul database dell'applicazione.
      for (const _ of converted) events.count('order', 'updated');
      total += converted.length;
    }

    nextPageInfo = nextPage;
  } while (nextPageInfo);

  return { total, events };
}

/**
 * Gli ordini si sincronizzano solo se il negozio ce l'ha concesso.
 *
 * Il permesso si da' all'installazione: chi ha installato l'app prima che gli
 * ordini esistessero non l'ha dato, e tentare comunque significherebbe far
 * fallire l'intera corsa — prodotti compresi — per una funzione che quel
 * negozio non ha nemmeno chiesto.
 */
async function syncOrdersIfEnabled(opts: {
  shopId: string;
  /** La risposta della policy, non gli scope grezzi: chi decide e' uno solo. */
  ordersEnabled: boolean;
  config: Parameters<typeof ensureOrdersTables>[1];
  shopifyClient: ShopifyAPIClient;
  supabase: SupabaseClient;
  updatedAtMin?: string;
}): Promise<OrderSyncResult> {
  if (!opts.ordersEnabled) return { total: 0, events: createEventBuffer() };

  const tables = await ensureOrdersTables(opts.shopId, opts.config, opts.supabase);
  if (tables.status === 'unavailable') {
    console.warn(
      `Tabelle ordini non disponibili per lo shop ${opts.shopId}: sync ordini saltata`,
    );
    return { total: 0, events: createEventBuffer() };
  }

  // Tabelle appena create: non c'e' storico da aggiornare in delta, e si
  // recupera tutto. E' il caso di chi concede il permesso oggi su un negozio
  // che vende da anni — ed e' esattamente il caso in cui il lifetime serve.
  const updatedAtMin = tables.empty ? undefined : opts.updatedAtMin;

  return syncOrders(opts.shopifyClient, opts.supabase, updatedAtMin);
}

/**
 * Legge tutti gli shopify_product_id già presenti nella tabella prodotti del
 * merchant, in pagine da 1000 (limite PostgREST). Serve a conoscere quanti
 * prodotti distinti esistono per far rispettare il tetto del piano anche nella
 * sync incrementale.
 */
async function fetchExistingProductIds(
  supabase: SupabaseClient,
  tableName: string,
): Promise<Set<number>> {
  const ids = new Set<number>();
  const pageSize = 1000;
  let from = 0;

  for (;;) {
    const { data, error } = await supabase
      .from(tableName)
      .select('shopify_product_id')
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Impossibile leggere i product id esistenti: ${error.message}`);
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (row.shopify_product_id != null) ids.add(row.shopify_product_id as number);
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return ids;
}

/**
 * Process periodic sync check for a shop
 * Task 11: Implements incremental sync with delta detection
 *
 * Fetches only products updated since last sync, detects orphaned variants,
 * and uses separated upserts to avoid NULL-conflict bug:
 * - Variant rows: onConflict: 'shopify_variant_id'
 * - Non-variant rows: onConflict: 'shopify_product_id'
 */
/**
 * Il margine che si toglie al confine incrementale.
 *
 * Non e' prudenza generica: `updated_at` lo scrive Shopify sui suoi server,
 * l'inizio della corsa lo scriviamo noi sui nostri, e due macchine diverse non
 * hanno mai esattamente la stessa ora. Senza margine, una modifica avvenuta a
 * cavallo del confine cadrebbe dalla parte sbagliata e non verrebbe raccolta.
 */
const CLOCK_SKEW_MARGIN_MS = 60_000;

export async function processPeriodicSyncCheck(shopId: string): Promise<void> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { supabaseConfig: true },
  });

  if (!shop || !shop.supabaseConfig) {
    console.log(`Shop ${shopId} not configured for periodic sync`);
    return;
  }

  // Piano del negozio: tetto prodotti (maxProducts, null = illimitato) e
  // abilitazione sync clienti. Letto prima dei controlli perche' serve anche a
  // loro, e leggerlo una volta sola evita di interrogare il listino due volte
  // per ogni negozio a ogni giro del cron.
  const plan = await findPlanByName(shop.currentPlan);
  const maxProducts = plan?.maxProducts ?? null;

  // Le condizioni che prima erano due — collegamento e autorizzazione — piu'
  // quella che non c'era: la disinstallazione. Il giro del cron gia' filtrava i
  // negozi disinstallati nella sua query, ma qui non ci si arriva solo da li':
  // ci si arriva anche drenando la coda, dove di un job resta il solo shopId e
  // nessun filtro. Un negozio che aveva disinstallato con un lavoro ancora in
  // coda si vedeva sincronizzare dopo essersene andato.
  const caps = shopCapabilitiesWithPlan(shop, plan);
  if (!can(caps, 'sync_products')) {
    console.log(`Shop ${shopId} non autorizzato: sync automatica sospesa`);
    return;
  }

  const shopifyClient = await ShopifyAPIClient.forShop(shop.shopDomain);
  const supabase = createSupabaseClient(shop.supabaseConfig);

  // Get last periodic sync timestamp
  const lastSyncJob = await prisma.syncJob.findFirst({
    where: {
      shopId: shop.id,
      jobType: 'periodic_check',
      status: 'completed',
    },
    orderBy: {
      completedAt: 'desc',
    },
  });

  // Il confine e' l'INIZIO della corsa precedente, non la sua fine.
  //
  // Con la fine si perdevano dati, in silenzio. Una corsa che comincia alle
  // 10:00 e finisce alle 10:03 legge la pagina di un prodotto alle 10:01; se
  // quel prodotto viene modificato alle 10:02, il suo `updated_at` e' anteriore
  // alle 10:03 — e la corsa dopo, che chiede "tutto cio' che e' cambiato dopo
  // le 10:03", non lo vede. Non lo vedra' nessuna corsa successiva: quella
  // modifica non arrivera' mai su Supabase, e niente lo segnala.
  //
  // Ripartendo dall'inizio si rileggono anche cose gia' sincronizzate — la
  // sovrapposizione vale quanto e' durata la corsa — ma non costa niente:
  // sono upsert, riscrivere la stessa riga con lo stesso contenuto e' un
  // aggiornamento a vuoto. Rileggere di piu' e' il prezzo di non perdere.
  const previousRunStart = lastSyncJob?.startedAt;
  const lastSyncTime = previousRunStart
    ? // Un minuto di margine perche' i due orologi non sono lo stesso: il
      // `updated_at` lo scrive Shopify sulle sue macchine, `startedAt` lo
      // scriviamo noi sulle nostre, e qualche secondo di scarto fra i due
      // basterebbe a far ricadere una modifica appena sotto il confine.
      new Date(previousRunStart.getTime() - CLOCK_SKEW_MARGIN_MS)
    : shop.supabaseConfig.updatedAt;

  // Create sync job
  const syncJob = await prisma.syncJob.create({
    data: {
      shopId: shop.id,
      jobType: 'periodic_check',
      status: 'running',
    },
  });

  // Dettaglio della corsa (cosa e' entrato, cosa e' uscito): vive fuori dal try
  // perche' anche il percorso di errore deve poterlo salvare.
  const collector = createEventCollector();

  try {
    // Prima di scrivere: le tabelle devono essere alla versione che l'app si
    // aspetta. E' qui che l'allineamento avviene per la maggior parte dei
    // negozi, senza che nessuno debba cliccare nulla.
    await applyMerchantSchemaUpdate(shop.id);
    await requireProductsTable(shop.id, shop.supabaseConfig, supabase);

    let totalProducts = 0;
    let totalVariants = 0;
    let nextPageInfo: string | null = null;

    // Per far rispettare il tetto del piano anche in delta: insieme dei prodotti
    // già presenti. I prodotti nuovi oltre il limite non vengono aggiunti; quelli
    // già presenti continuano ad aggiornarsi. null = piano illimitato (nessun cap).
    const existingProductIds = maxProducts == null
      ? null
      : await fetchExistingProductIds(supabase, shop.supabaseConfig.tableNameProducts);

    do {
      // Fetch updated products since last sync (delta)
      const { products, nextPageInfo: nextPage } = await shopifyClient.getProducts({
        limit: 250,
        pageInfo: nextPageInfo || undefined,
        updatedAtMin: lastSyncTime.toISOString(),
      });

      if (products.length === 0) break;

      // Il cost_per_item vive sull'InventoryItem: senza questo la sync scriverebbe
      // sempre cost_per_item null, azzerando anche i valori inseriti a mano.
      await enrichVariantCosts(shopifyClient, products);

      // Process each product individually for delta detection. Anche qui dal
      // piu' vecchio: quando il tetto e' saturo passano solo gli aggiornamenti
      // ai prodotti gia' presenti, e fra i nuovi ha la precedenza chi c'era da
      // piu' tempo su Shopify.
      for (const product of sortByCreatedAtAsc(products as ShopifyProduct[])) {
        // Tetto del piano: se il prodotto è nuovo e il limite è già saturo,
        // non aggiungerlo (gli aggiornamenti ai prodotti esistenti passano).
        if (
          existingProductIds != null &&
          !existingProductIds.has(product.id) &&
          existingProductIds.size >= (maxProducts as number)
        ) {
          continue;
        }

        // Solo righe idonee: le varianti senza costo non vanno scritte e, se
        // presenti da prima, devono risultare "orfane" e quindi cancellate.
        const eligibleRows = filterEligibleProductRows(transformProduct(product));
        const currentVariantIds = new Set(
          eligibleRows.map(r => r.shopify_variant_id).filter((id): id is number => id != null)
        );

        // Fetch existing rows from Supabase for this product
        const { data: existingRows, error: existingRowsError } = await supabase
          .from(shop.supabaseConfig.tableNameProducts)
          .select('shopify_variant_id')
          .eq('shopify_product_id', product.id);

        // Le varianti gia' presenti secondo questa stessa lettura: nessuna query
        // in piu' per sapere quali righe idonee sono nuove. Se la lettura e'
        // fallita non si distingue nulla — una risposta vuota per errore farebbe
        // passare per "aggiunto" un catalogo che c'era gia'.
        const knownVariantIds = existingRowsError
          ? null
          : new Set(
              (existingRows || [])
                .map((row) => row.shopify_variant_id as number | null)
                .filter((id): id is number => id != null),
            );
        const addedRows =
          knownVariantIds == null
            ? []
            : eligibleRows.filter(
                (row) =>
                  row.shopify_variant_id != null &&
                  !knownVariantIds.has(row.shopify_variant_id),
              );

        // Riconcilia: elimina le righe del prodotto il cui variant_id non è più
        // presente in Shopify. Copre sia le varianti rimosse sia le transizioni
        // multi→single (le vecchie righe variante diventano orfane). Include
        // eventuali righe legacy con variant_id NULL create prima di questo fix.
        //
        // Ma prima una condizione che qui mancava, ed e' costata varianti vere:
        // cancellare per differenza ha senso solo se `currentVariantIds` e'
        // davvero l'elenco delle varianti di Shopify. Se l'elenco e' troncato o
        // interrotto a meta' — connessione annidata non esaurita, una pagina
        // andata storta — la differenza non descrive cio' che il merchant ha
        // tolto, descrive cio' che noi non abbiamo chiesto. Senza la prova di
        // completezza si aggiorna e basta: qualche riga obsoleta di troppo si
        // sistema alla corsa dopo, una variante cancellata no.
        const variantsAreComplete = product.variants_complete === true;
        if (!variantsAreComplete) {
          console.warn(
            `Elenco varianti incompleto per il prodotto ${product.id}: riconciliazione saltata, nessuna cancellazione`,
          );
        }

        const orphanedVariantIds = !variantsAreComplete
          ? []
          : (existingRows || [])
              .map(row => row.shopify_variant_id as number | null)
              .filter((id): id is number => id != null && !currentVariantIds.has(id));
        // Le righe con variant_id NULL invece non le decide nessun confronto:
        // sono resti di una vecchia versione dell'app, irraggiungibili
        // dall'upsert (in SQL NULL non entra mai in conflitto con NULL) e
        // destinate a duplicarsi. Vanno via comunque, elenco completo o no.
        const hasLegacyNullRows = (existingRows || []).some(row => row.shopify_variant_id == null);

        if (orphanedVariantIds.length > 0) {
          const { rows: removedRows, error: deleteError } = await runReturningRows<RemovedProductRow>(
            supabase
              .from(shop.supabaseConfig.tableNameProducts)
              .delete()
              .eq('shopify_product_id', product.id)
              .in('shopify_variant_id', orphanedVariantIds) as unknown as ReturningBuilder,
            REMOVED_PRODUCT_COLUMNS,
          );

          if (deleteError) {
            console.warn(`Could not delete orphaned variants for product ${product.id}:`, deleteError);
          } else {
            collectRemovedProducts(collector, removedRows);
          }
        }
        if (hasLegacyNullRows) {
          const { rows: removedRows, error: deleteError } = await runReturningRows<RemovedProductRow>(
            supabase
              .from(shop.supabaseConfig.tableNameProducts)
              .delete()
              .eq('shopify_product_id', product.id)
              .is('shopify_variant_id', null) as unknown as ReturningBuilder,
            REMOVED_PRODUCT_COLUMNS,
          );

          if (deleteError) {
            console.warn(`Could not delete legacy null-variant row for product ${product.id}:`, deleteError);
          } else {
            collectRemovedProducts(collector, removedRows);
          }
        }

        // Se non resta alcuna variante idonea non c'è nulla da scrivere e non si
        // consuma quota. Con l'elenco completo la riconciliazione sopra ha già
        // ripulito il prodotto; con l'elenco incompleto le righe restano dove
        // sono, che è il punto: "non ho visto varianti idonee" non è "non ce ne
        // sono".
        if (eligibleRows.length === 0) continue;

        // Upsert delle sole righe idonee con la chiave univoca.
        const { error } = await supabase
          .from(shop.supabaseConfig.tableNameProducts)
          .upsert(eligibleRows, {
            onConflict: 'shopify_variant_id',
            ignoreDuplicates: false,
          });

        if (error) {
          console.error(`Periodic sync upsert error for product ${product.id}:`, error);
          continue;
        }

        collectAddedProducts(collector, addedRows);

        totalProducts++;
        totalVariants += eligibleRows.length;
        // Aggiorna il conteggio prodotti distinti (no-op se già presente).
        if (existingProductIds != null) existingProductIds.add(product.id);
      }

      nextPageInfo = nextPage;

    } while (nextPageInfo);

    // Incremental customer sync (delta) if the shop's plan includes customer sync
    const customers = await syncCustomersIfEnabled({
      shopId: shop.id,
      config: shop.supabaseConfig,
      customersSyncEnabled: can(caps, 'sync_customers'),
      shopifyClient,
      supabase,
      updatedAtMin: lastSyncTime.toISOString(),
      shop,
    });
    const totalCustomers = customers.total;
    collector.absorb(customers.events);

    // Gli ordini viaggiano con la stessa corsa: sono la stessa fotografia del
    // negozio, e due sincronizzazioni sfalsate darebbero un profitto calcolato
    // su prodotti di ieri e ordini di oggi.
    const orders = await syncOrdersIfEnabled({
      shopId: shop.id,
      ordersEnabled: can(caps, 'sync_orders'),
      config: shop.supabaseConfig,
      shopifyClient,
      supabase,
      updatedAtMin: lastSyncTime.toISOString(),
    });
    collector.absorb(orders.events);

    // Mark completed
    const eventCounters = await collector.flush(syncJob.id);
    await prisma.syncJob.update({
      where: { id: syncJob.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        productsSynced: totalProducts,
        variantsSynced: totalVariants,
        customersSynced: totalCustomers,
        ...eventCounters,
      },
    });

    await pruneOldEvents(shop.id);

    console.log(`Periodic sync check completed: ${totalProducts} products checked, ${totalVariants} variants synced, ${totalCustomers} customers synced`);

  } catch (error) {
    // Anche una corsa interrotta ha fatto qualcosa prima di fermarsi: il
    // dettaglio raccolto fin li' e' esattamente cio' che spiega dove si e' rotta.
    const eventCounters = await collector.flush(syncJob.id);
    await prisma.syncJob.update({
      where: { id: syncJob.id },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errors: {
          message: error instanceof Error ? error.message : 'Unknown error',
        },
        ...eventCounters,
      },
    });

    console.error('Periodic sync check failed:', error);
    throw error;
  }
}

/**
 * Process initial bulk sync for a shop
 * Task 10: Syncs ALL products from Shopify to Supabase with pagination
 *
 * CRITICAL: Uses separated upserts to avoid NULL conflict bug:
 * - Variant rows (shopify_variant_id != NULL): upsert with onConflict: 'shopify_variant_id'
 * - Non-variant rows (shopify_variant_id = NULL): upsert with onConflict: 'shopify_product_id'
 *
 * This prevents infinite duplicates for single-variant products (where shopify_variant_id = NULL
 * and SQL NULL != NULL means onConflict never matches).
 */
export async function processInitialBulkSync(
  shopId: string,
  // Opzionale: l'allineamento automatico dopo un cambio di piano parte dal cron,
  // senza un job BullMQ a cui riportare l'avanzamento.
  job?: ProgressReporter,
): Promise<void> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { supabaseConfig: true },
  });

  if (!shop || !shop.supabaseConfig) {
    throw new Error(`Shop ${shopId} not configured for sync`);
  }

  // Piano del negozio: definisce il tetto di prodotti sincronizzabili
  // (maxProducts) e se la sync dei clienti è inclusa. null = illimitato.
  // Letto qui e non piu' sotto perche' la policy lo vuole sapere.
  const plan = await findPlanByName(shop.currentPlan);
  const maxProducts = plan?.maxProducts ?? null;

  // Come nella corsa periodica, e per la stessa ragione: qui si arriva anche
  // dal drain della coda, che di un negozio conosce solo l'id. I due messaggi
  // restano distinti perche' distinte sono le cause, e chi legge un log deve
  // poter capire se manca il database o manca il permesso.
  const caps = shopCapabilitiesWithPlan(shop, plan);
  const denial = denialOf(caps, 'sync_products');
  if (denial === 'not_connected') {
    throw new Error(`Shop ${shopId} not configured for sync`);
  }
  if (denial !== null) {
    throw new Error(`Shop ${shopId} non autorizzato all'uso dell'app`);
  }

  const shopifyClient = await ShopifyAPIClient.forShop(shop.shopDomain);
  const supabase = createSupabaseClient(shop.supabaseConfig);

  // Create sync job record
  const syncJob = await prisma.syncJob.create({
    data: {
      shopId: shop.id,
      jobType: 'initial_bulk',
      status: 'running',
    },
  });

  let totalProducts = 0;
  let totalVariants = 0;
  let nextPageInfo: string | null = null;
  // Quanti prodotti sono arrivati con l'elenco delle varianti troncato o
  // interrotto. Basta che ne esista uno perche' la premessa della spazzata
  // finale — "tutto cio' che doveva restare e' stato riscritto adesso" — sia
  // falsa. Vedi il commento sulla spazzata.
  let productsWithIncompleteVariants = 0;

  // Dettaglio della corsa (cosa e' entrato, cosa e' uscito): vive fuori dal try
  // perche' anche il percorso di errore deve poterlo salvare.
  const collector = createEventCollector();

  try {
    // Prima di scrivere: le tabelle devono essere alla versione che l'app si
    // aspetta. E' qui che l'allineamento avviene per la maggior parte dei
    // negozi, senza che nessuno debba cliccare nulla.
    await applyMerchantSchemaUpdate(shop.id);
    await requireProductsTable(shop.id, shop.supabaseConfig, supabase);

    // Fotografia di cosa c'era prima di partire: serve solo al dettaglio, per
    // distinguere le varianti nuove da quelle che l'upsert si limita ad
    // aggiornare. Da qui in poi l'insieme si arricchisce da solo.
    const knownVariantIds = await fetchExistingVariantIds(
      supabase,
      shop.supabaseConfig.tableNameProducts,
    );

    // Riconciliazione, non ripopolamento da zero: la tabella NON viene svuotata,
    // cosi' resta leggibile per tutta la sync (con l'azzeramento il tracciamento
    // leggeva zero prodotti per l'intera durata) e non si distrugge nulla su un
    // progetto gia' popolato. Le righe non toccate da questa corsa vengono
    // spazzate alla fine confrontando `synced_at` con questo istante.
    const runStartedAt = new Date().toISOString();
    const syncStartedAtMs = Date.now();

    do {
      // Fetch products batch (250 per page)
      const { products, nextPageInfo: nextPage } = await shopifyClient.getProducts({
        limit: 250,
        pageInfo: nextPageInfo || undefined,
      });

      if (products.length === 0) break;

      // Il cost_per_item vive sull'InventoryItem: popolalo prima di trasformare,
      // altrimenti verrebbe scritto sempre null su Supabase.
      await enrichVariantCosts(shopifyClient, products);

      // Trasforma, filtra le idonee e applica il tetto DOPO il filtro: un prodotto
      // consuma quota solo se ha ≥1 variante idonea.
      //
      // Dal piu' vecchio al piu' recente: e' l'ordine in cui la quota del piano
      // va spesa. Shopify pagina gia' per id crescente (cioe' per creazione),
      // quindi qui si riordina la pagina appena scaricata e l'insieme resta in
      // ordine anche fra pagine diverse.
      const allRows = [];
      // Le righe la cui variante non c'era prima: si registrano dopo l'upsert,
      // perche' un upsert fallito non ha aggiunto niente.
      const addedRows: SupabaseProductRow[] = [];
      for (const product of sortByCreatedAtAsc(products as ShopifyProduct[])) {
        if (maxProducts != null && totalProducts >= maxProducts) break;
        // Si conta PRIMA di qualunque scarto: un prodotto le cui varianti sono
        // arrivate a meta' puo' benissimo sembrare senza righe idonee, e uscire
        // di scena qui sotto senza che nessuno sappia piu' che era monco. E'
        // esattamente il caso in cui la spazzata finale gli porterebbe via le
        // righe buone.
        if (product.variants_complete !== true) productsWithIncompleteVariants++;
        const eligibleRows = filterEligibleProductRows(transformProduct(product));
        if (eligibleRows.length === 0) continue; // nessuna variante idonea: niente quota
        if (knownVariantIds != null) {
          for (const row of eligibleRows) {
            if (row.shopify_variant_id == null) continue;
            if (knownVariantIds.has(row.shopify_variant_id)) continue;
            knownVariantIds.add(row.shopify_variant_id);
            addedRows.push(row);
          }
        }
        allRows.push(...eligibleRows);
        totalProducts++;
        totalVariants += eligibleRows.length;
      }

      // Ogni riga ha ora un shopify_variant_id reale (anche i prodotti a
      // variante singola) → un solo upsert con la chiave univoca, senza
      // separare variant/non-variant.
      if (allRows.length > 0) {
        const chunkSize = 1000;
        for (let i = 0; i < allRows.length; i += chunkSize) {
          const chunk = allRows.slice(i, i + chunkSize);

          const { error } = await supabase
            .from(shop.supabaseConfig.tableNameProducts)
            .upsert(chunk, {
              onConflict: 'shopify_variant_id',
              ignoreDuplicates: false,
            });

          if (error) {
            throw new Error(`Supabase products upsert failed: ${error.message}`);
          }
        }
      }

      collectAddedProducts(collector, addedRows);

      // Update job progress
      await job?.updateProgress({
        products: totalProducts,
        variants: totalVariants,
      });

      await prisma.syncJob.update({
        where: { id: syncJob.id },
        data: {
          productsSynced: totalProducts,
          variantsSynced: totalVariants,
        },
      });

      // Limite del piano raggiunto: interrompi la paginazione.
      if (isProductLimitReached(totalProducts, maxProducts)) break;

      nextPageInfo = nextPage;

    } while (nextPageInfo);

    // Spazzata: le righe con synced_at anteriore all'inizio corsa sono quelle che
    // la scansione non ha toccato, cioe' esattamente le due categorie da togliere
    // — prodotti non piu' presenti su Shopify e varianti che hanno perso il
    // cost_per_item. Una sola query, indipendente dal numero di prodotti.
    //
    // Sta QUI di proposito: ci si arriva solo se la paginazione e' terminata
    // regolarmente (anche per raggiunto tetto del piano). Se una pagina lancia,
    // il controllo salta al catch e non si cancella nulla: meglio qualche riga
    // obsoleta che perdere prodotti veri per un errore di rete.
    //
    // Le righe con synced_at NULL sopravvivono (in SQL un confronto con NULL non
    // e' mai vero): non le ha scritte l'app, non le tocchiamo.
    //
    // E la stessa prudenza vale un gradino piu' in basso, dove il guasto e' meno
    // vistoso di una pagina che lancia: la spazzata poggia tutta sull'idea che
    // "non riscritto adesso" significhi "non esiste piu' su Shopify". Se anche un
    // solo prodotto e' arrivato con l'elenco delle varianti monco, quelle che non
    // abbiamo letto non sono state riscritte pur essendo vivissime, e la spazzata
    // le porterebbe via tutte in una query — silenziosamente, e per l'intero
    // catalogo. Allora si salta: le righe davvero obsolete resteranno un giro in
    // piu', che e' un prezzo senza paragone rispetto a varianti perse.
    if (productsWithIncompleteVariants > 0) {
      console.warn(
        `Spazzata dei prodotti obsoleti saltata: ${productsWithIncompleteVariants} prodotti con elenco varianti incompleto in questa corsa`,
      );
    } else {
      const { rows: sweptRows, error: sweepError } = await runReturningRows<RemovedProductRow>(
        supabase
          .from(shop.supabaseConfig.tableNameProducts)
          .delete()
          .lt('synced_at', runStartedAt) as unknown as ReturningBuilder,
        REMOVED_PRODUCT_COLUMNS,
      );

      if (sweepError) {
        // Non fatale: i prodotti idonei sono gia' stati scritti. Le righe obsolete
        // verranno rimosse alla corsa successiva.
        console.warn('Spazzata dei prodotti obsoleti fallita:', sweepError);
      } else {
        collectRemovedProducts(collector, sweptRows);
      }
    }

    // Sync customers if the shop's plan includes customer sync
    const customers = await syncCustomersIfEnabled({
      shopId: shop.id,
      config: shop.supabaseConfig,
      customersSyncEnabled: can(caps, 'sync_customers'),
      shopifyClient,
      supabase,
      shop,
    });
    const totalCustomers = customers.total;
    collector.absorb(customers.events);

    const orders = await syncOrdersIfEnabled({
      shopId: shop.id,
      ordersEnabled: can(caps, 'sync_orders'),
      config: shop.supabaseConfig,
      shopifyClient,
      supabase,
    });
    collector.absorb(orders.events);

    // Mark sync job as completed
    const eventCounters = await collector.flush(syncJob.id);
    await prisma.syncJob.update({
      where: { id: syncJob.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        customersSynced: totalCustomers,
        ...eventCounters,
      },
    });

    // Il piano con cui questa sync e' stata eseguita: se in futuro currentPlan
    // differisce, la dashboard sa che c'e' altro da sincronizzare e riabilita il
    // pulsante. Si riallinea da solo a ogni sync completata.
    await prisma.shop.update({
      where: { id: shop.id },
      data: { lastSyncedPlan: shop.currentPlan },
    });

    await pruneOldEvents(shop.id);

    // Quanto e' durata davvero, in chiaro nel log.
    //
    // Serve a separare due cose che dal browser sembrano una sola: il tempo
    // della sincronizzazione e il tempo che ci mette a cominciare — la coda, il
    // risveglio della funzione, il giro fino al drain. Se qui si leggono due
    // secondi e chi guarda ne aspetta novanta, il lavoro non c'entra e va
    // cercato altrove; senza questa riga si finisce per ottimizzare la parte
    // sbagliata.
    console.log(
      `Bulk sync completed in ${Date.now() - syncStartedAtMs}ms: ` +
        `${totalProducts} products, ${totalVariants} variants, ${totalCustomers} customers`,
    );

  } catch (error) {
    // Anche una corsa interrotta ha fatto qualcosa prima di fermarsi: il
    // dettaglio raccolto fin li' e' esattamente cio' che spiega dove si e' rotta.
    const eventCounters = await collector.flush(syncJob.id);

    // Mark sync job as failed
    await prisma.syncJob.update({
      where: { id: syncJob.id },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errors: {
          message: error instanceof Error ? error.message : 'Unknown error',
        },
        ...eventCounters,
      },
    });

    console.error('Bulk sync failed:', error);
    throw error;
  }
}

/**
 * Process manual sync for a shop
 * Task 10: Reuses initial bulk sync logic
 */
export async function processManualSync(shopId: string, job?: ProgressReporter): Promise<void> {
  // Manual sync reuses the same logic as initial bulk sync
  await processInitialBulkSync(shopId, job);
}

/**
 * Process retry of a failed webhook.
 *
 * Deferred: no producer currently enqueues 'retry-failed-webhook' jobs. The
 * type and worker branch exist so the retry pipeline can be wired up in a later
 * phase without reshaping the queue contract. Throws if invoked prematurely.
 */
export async function processRetryWebhook(data: Extract<SyncJobData, { type: 'retry-failed-webhook' }>): Promise<void> {
  throw new Error('processRetryWebhook not yet implemented');
}
