import { prisma } from '~/db.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQuery, runQueryRows } from '~/lib/supabase-management.server';
import { hasOrdersAccess } from '~/lib/sync/orders-access';
import {
  existingReportTablesSQL,
  missingReportTables,
  missingReportTablesSQL,
} from '~/lib/supabase/report-tables';
import {
  customersInRangeSQL,
  lifetimeProfitSQL,
  previousRange,
} from './customers-query';
import { ALL_TIME_START } from '~/lib/dates/ranges';

/**
 * I clienti con i loro numeri, pronti per la tabella.
 *
 * Tre domande al database e una fusione qui: il periodo scelto, lo stesso
 * periodo di prima (per dire di quanto e' cambiato) e il profitto di sempre.
 * Farne una sola avrebbe voluto dire leggere tre volte le stesse tabelle dentro
 * la stessa istruzione, con tre filtri diversi.
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
}): Promise<CustomersReport> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: opts.shopDomain },
    include: { supabaseConfig: true },
  });

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

  const token = await getValidAccessToken(shop.id);
  const ref = shop.supabaseConfig.supabaseProjectRef;
  // Il fuso e' del negozio, non della richiesta: si legge dalla sua riga
  // insieme a tutto il resto, cosi' chi chiama non puo' scordarselo.
  const timeZone = shop.ianaTimezone;
  // "Da sempre" non ha un prima: il periodo precedente cadrebbe interamente
  // prima che Shopify esistesse, e sarebbe una query che torna vuota per forza.
  const before = opts.from <= ALL_TIME_START ? null : previousRange(opts.from, opts.to);

  await ensureReportTables(token, ref);

  const [current, previous, lifetime] = await Promise.all([
    runQueryRows<RangeRow>(
      token,
      ref,
      customersInRangeSQL({ ...opts, timeZone, limit: opts.limit }),
    ),
    before
      ? runQueryRows<RangeRow>(
          token,
          ref,
          customersInRangeSQL({ ...before, timeZone, limit: opts.limit }),
        )
      : Promise.resolve([] as RangeRow[]),
    runQueryRows<LifetimeRow>(token, ref, lifetimeProfitSQL(opts.limit)),
  ]);

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
 * Best effort di proposito: se anche la DDL non riuscisse, le tre query
 * partono comunque e il loro errore — adesso parlante — dice cosa e' successo.
 * Fermare qui la lettura aggiungerebbe un modo di fallire senza toglierne uno.
 */
async function ensureReportTables(token: string, ref: string): Promise<void> {
  try {
    const rows = await runQueryRows<{ table_name: string }>(
      token,
      ref,
      existingReportTablesSQL(),
    );
    const existing = rows.map((r) => r.table_name).filter(Boolean);
    const ddl = missingReportTablesSQL(existing);
    if (!ddl) return;

    console.warn(
      '[customers] tabelle mancanti nel database del merchant, le creo:',
      missingReportTables(existing).join(', '),
    );
    await runQuery(token, ref, ddl);
  } catch (error) {
    console.warn(
      '[customers] verifica delle tabelle non riuscita:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
  }
}
