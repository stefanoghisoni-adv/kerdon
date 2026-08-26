import { prisma } from '~/db.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQueryRows } from '~/lib/supabase-management.server';
import { hasOrdersAccess } from '~/lib/sync/orders-access';
import {
  customersInRangeSQL,
  lifetimeProfitSQL,
  previousRange,
} from './customers-query';

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
}

export interface CustomersReport {
  rows: CustomerRow[];
  /** La valuta con cui il negozio vende. */
  currency: string;
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
  const before = previousRange(opts.from, opts.to);

  const [current, previous, lifetime] = await Promise.all([
    runQueryRows<RangeRow>(token, ref, customersInRangeSQL({ ...opts, limit: opts.limit })),
    runQueryRows<RangeRow>(token, ref, customersInRangeSQL({ ...before, limit: opts.limit })),
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
    };
  });

  return {
    rows,
    currency: current.find((row) => row.currency)?.currency ?? 'EUR',
    unavailable: null,
  };
}
