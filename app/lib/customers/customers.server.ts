import { prisma } from '~/db.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQuery, runQueryRows } from '~/lib/supabase-management.server';
import { hasOrdersAccess } from '~/lib/sync/orders-access';
import {
  existingReportTablesSQL,
  missingReportTables,
  missingReportTablesSQL,
} from '~/lib/supabase/report-tables';
import { customersReportSQL, previousRange } from './customers-query';
import { ALL_TIME_START } from '~/lib/dates/ranges';
import {
  forgetReportTables,
  rememberReportTables,
  reportTablesKnown,
} from '~/lib/cache/report-tables-cache.server';
import type { ServerTiming } from '~/lib/timing/server-timing';

/**
 * I clienti con i loro numeri, pronti per la tabella.
 *
 * Tre parti e una fusione qui: il periodo scelto, lo stesso periodo di prima
 * (per dire di quanto e' cambiato) e il profitto di sempre. Al database
 * arrivano in una richiesta sola (`customersReportSQL`): ogni richiesta alla
 * Management API e' un viaggio con la sua attesa, e la tab si apriva pagandone
 * quattro o cinque.
 */

export interface CustomerRow {
  customerId: number;
  firstName: string | null;
  lastName: string | null;
  orders: number;
  /** Profitto nel periodo scelto. */
  profit: number;
  /** Profitto medio per ordine nel periodo. null senza ordini. */
  averageOrderProfit: number | null;
  /** Profitto di sempre, che il periodo non tocca. */
  lifetimeProfit: number;
  /** Quanto e' cambiato il profitto rispetto al periodo precedente. */
  profitChange: number | null;
  /** Righe con un costo, sul totale: dice quanto il numero sia completo. */
  coveredLines: number;
  totalLines: number;
  /** Il cliente e' fra quelli sincronizzati (ha dato consenso al marketing). */
  synced: boolean;
  /**
   * Email e telefono non si mostrano in tabella, ma la riga se li porta: sono i
   * due modi in cui un cliente si ritrova quando del nome non si e' sicuri, e
   * la ricerca lavora sulle righe gia' caricate.
   */
  email: string | null;
  phone: string | null;
}

export interface CustomersReport {
  rows: CustomerRow[];
  /** La valuta con cui il negozio vende. */
  currency: string;
  /**
   * Quanti clienti hanno comprato da sempre (con lo stesso tetto della
   * tabella). Serve alla pagina per accorgersi che il periodo scelto ne lascia
   * fuori qualcuno, e dirlo invece di mostrare meno clienti in silenzio.
   */
  lifetimeCustomers: number;
  /** Perche' non c'e' niente da mostrare, quando non c'e'. */
  unavailable: 'no_orders_access' | 'not_connected' | 'plan_required' | 'failed' | null;
}

interface RangeRow {
  customer_id: number | string;
  first_name: string | null;
  last_name: string | null;
  orders: number | string;
  profit: number | string;
  covered_lines: number | string;
  total_lines: number | string;
  currency: string | null;
  synced: boolean | null;
  email: string | null;
  phone: string | null;
}

interface LifetimeRow {
  customer_id: number | string;
  orders: number | string;
  profit: number | string;
}

/** La riga unica della lettura: le tre parti, ciascuna un array JSON. */
interface ReportRow {
  current_rows: unknown;
  previous_rows: unknown;
  lifetime_rows: unknown;
}

/**
 * Un array JSON come arriva dalla Management API: gia' letto, oppure come
 * testo — dipende da come il tipo `json` viene servito, e non ci si appoggia
 * a uno solo dei due.
 */
function jsonRows<T>(value: unknown): T[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

/** Postgres dice cosi' che una tabella non c'e' (codice 42P01). */
function isMissingRelation(error: unknown): boolean {
  return (
    error instanceof Error && /42P01|relation .* does not exist/i.test(error.message)
  );
}

/** I numeri arrivano dal database come stringhe quando sono grandi. */
function num(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function loadCustomersReport(opts: {
  shopDomain: string;
  from: string;
  to: string;
  limit?: number;
  /** Dove annotare quanto ha impiegato ogni fase, se chi chiama lo vuole. */
  timing?: ServerTiming;
}): Promise<CustomersReport> {
  const measure = <T>(name: string, work: () => Promise<T>): Promise<T> =>
    opts.timing ? opts.timing.measure(name, work) : work();

  const shop = await measure('shop', () =>
    prisma.shop.findUnique({
      where: { shopDomain: opts.shopDomain },
      include: { supabaseConfig: true },
    }),
  );

  const empty = (unavailable: CustomersReport['unavailable']): CustomersReport => ({
    rows: [],
    currency: 'EUR',
    lifetimeCustomers: 0,
    unavailable,
  });

  if (!shop?.supabaseConfig?.connectionVerifiedAt || !shop.supabaseConfig.supabaseProjectRef) {
    return empty('not_connected');
  }
  // Senza il permesso non c'e' un solo ordine da leggere: si dice, invece di
  // mostrare una tabella vuota che sembrerebbe un negozio senza clienti.
  if (!hasOrdersAccess(shop.scopes)) return empty('no_orders_access');

  const ref = shop.supabaseConfig.supabaseProjectRef;
  // Il token e il ricordo delle tabelle non dipendono l'uno dall'altro: si
  // chiedono insieme.
  const [token, tablesKnown] = await Promise.all([
    measure('token', () => getValidAccessToken(shop.id)),
    reportTablesKnown(shop.id, ref),
  ]);
  // Il fuso e' del negozio, non della richiesta: si legge dalla sua riga
  // insieme a tutto il resto, cosi' chi chiama non puo' scordarselo.
  const timeZone = shop.ianaTimezone;
  // "Da sempre" non ha un prima: il periodo precedente cadrebbe interamente
  // prima che Shopify esistesse, e sarebbe una query che torna vuota per forza.
  const before = opts.from <= ALL_TIME_START ? null : previousRange(opts.from, opts.to);

  const sql = customersReportSQL({
    current: { from: opts.from, to: opts.to, timeZone },
    previous: before ? { ...before, timeZone } : null,
    limit: opts.limit,
  });
  const ensure = () =>
    measure('ensure', () => ensureReportTables(token, ref, shop.id));
  const read = () => measure('report', () => runQueryRows<ReportRow>(token, ref, sql));

  // Le tabelle si controllano solo quando non si sa gia' che ci sono. Se il
  // ricordo era sbagliato — una tabella sparita dopo — la lettura lo dice con
  // "relation does not exist": si dimentica, si controlla, si rilegge una volta.
  if (!tablesKnown) await ensure();
  let result: ReportRow[];
  try {
    result = await read();
  } catch (error) {
    if (!tablesKnown || !isMissingRelation(error)) throw error;
    await forgetReportTables(shop.id, ref);
    await ensure();
    result = await read();
  }

  const parts = result[0];
  const current = jsonRows<RangeRow>(parts?.current_rows);
  const previous = jsonRows<RangeRow>(parts?.previous_rows);
  const lifetime = jsonRows<LifetimeRow>(parts?.lifetime_rows);

  const beforeByCustomer = new Map(previous.map((row) => [String(row.customer_id), num(row.profit)]));
  const lifetimeByCustomer = new Map(
    lifetime.map((row) => [String(row.customer_id), num(row.profit)]),
  );

  const rows: CustomerRow[] = current.map((row) => {
    const key = String(row.customer_id);
    const profit = round(num(row.profit));
    const orders = num(row.orders);
    const was = beforeByCustomer.get(key);

    return {
      customerId: Number(row.customer_id),
      firstName: row.first_name,
      lastName: row.last_name,
      orders,
      profit,
      averageOrderProfit: orders === 0 ? null : round(profit / orders),
      lifetimeProfit: round(lifetimeByCustomer.get(key) ?? profit),
      // Nessun confronto quando prima non c'era niente: da zero qualunque
      // aumento sarebbe "infinito per cento".
      profitChange:
        was == null || was === 0 ? null : Math.round(((profit - was) / Math.abs(was)) * 1000) / 10,
      coveredLines: num(row.covered_lines),
      totalLines: num(row.total_lines),
      synced: row.synced === true,
      email: row.email,
      phone: row.phone,
    };
  });

  return {
    rows,
    currency: current.find((row) => row.currency)?.currency ?? 'EUR',
    lifetimeCustomers: lifetime.length,
    unavailable: null,
  };
}

/**
 * Provvede alle tabelle che questa lettura richiede, quando ne manca qualcuna.
 *
 * Non e' zelo: le tabelle del merchant nascono al collegamento, e nascono
 * quelle che il negozio meritava allora. Un piano che sale, il permesso sugli
 * ordini concesso dopo, un collegamento a un progetto nuovo fatto in un momento
 * diverso — e la tabella che serve qui non c'e'. La query la cercava lo stesso,
 * Postgres rispondeva "relation does not exist" e la Management API lo girava
 * come un 400 senza una parola dentro: a schermo diventava "non e' stato
 * possibile leggere i clienti", per sempre, senza un gesto che potesse
 * risolverlo.
 *
 * Si fa solo quando non si sa gia' che le tabelle ci sono (vedi
 * `report-tables-cache.server.ts`): il loro esserci cambia quasi mai, e
 * chiederlo a ogni apertura costava una richiesta in piu' alla Management API.
 *
 * Best effort di proposito: se anche la DDL non riuscisse, la lettura
 * parte comunque e il loro errore — adesso parlante — dice cosa e' successo.
 * Fermare qui la lettura aggiungerebbe un modo di fallire senza toglierne uno.
 */
async function ensureReportTables(token: string, ref: string, shopId: string): Promise<void> {
  try {
    const rows = await runQueryRows<{ table_name: string }>(
      token,
      ref,
      existingReportTablesSQL(),
    );
    const existing = rows.map((r) => r.table_name).filter(Boolean);
    const ddl = missingReportTablesSQL(existing);
    if (ddl) {
      console.warn(
        '[customers] tabelle mancanti nel database del merchant, le creo:',
        missingReportTables(existing).join(', '),
      );
      await runQuery(token, ref, ddl);
    }
    // Ci sono, o ci sono appena state messe: le prossime aperture non lo
    // richiedono. Solo l'esito positivo si ricorda — una DDL fallita lascia
    // il controllo da rifare alla prossima apertura.
    await rememberReportTables(shopId, ref);
  } catch (error) {
    console.warn(
      '[customers] verifica delle tabelle non riuscita:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
  }
}

/**
 * Carica nomi ed email per i customer ID specificati dal database del merchant.
 *
 * Usato per arricchire i conflitti con nome/email anche quando il cliente e'
 * fuori dal periodo scelto (quindi non in `rows`).
 *
 * Valida gli IDs internamente: mantiene solo interi positivi, deduplica.
 * Legge dalla tabella customers (non orders): un cliente senza ordini deve
 * comunque avere nome ed email se presente nella tabella.
 *
 * @param shopId L'ID del negozio
 * @param ref Il riferimento Supabase del merchant
 * @param customerIds Array di customer ID (vengono validati internamente)
 * @returns Map di customerId → {firstName, email}
 */
export async function fetchConflictCustomerNames(
  shopId: string,
  ref: string,
  customerIds: number[],
): Promise<Map<number, { firstName: string | null; email: string | null }>> {
  // Valida IDs internamente: solo interi positivi safe, deduplica (I3a)
  const validIds = Array.from(
    new Set(
      customerIds.filter((id) => Number.isSafeInteger(id) && id > 0),
    ),
  );

  // Empty dopo filtering → return senza query
  if (validIds.length === 0) return new Map();

  try {
    const token = await getValidAccessToken(shopId);

    // IDs validati: safe per interpolazione diretta
    const idsString = validIds.join(', ');

    // Query dalla tabella customers direttamente (I3a: clienti senza ordini
    // devono comunque avere nome/email se presenti in customers)
    const sql = `
      SELECT
        shopify_customer_id AS customer_id,
        first_name,
        email_address AS email
      FROM customers
      WHERE shopify_customer_id = ANY(ARRAY[${idsString}])
    `;

    interface NameRow {
      customer_id: number | string; // Management API può ritornare int8 come string
      first_name: string | null;
      email: string | null;
    }

    const rows = await runQueryRows<NameRow>(token, ref, sql);

    // Key con Number(r.customer_id): Management API può ritornare int8 come string
    return new Map(
      rows.map((r) => [
        Number(r.customer_id),
        { firstName: r.first_name, email: r.email },
      ]),
    );
  } catch (error) {
    console.warn(
      '[customers] nomi conflitti non leggibili dal database del merchant:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
    return new Map();
  }
}
