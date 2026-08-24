import { prisma } from '~/db.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQueryRows } from '~/lib/supabase-management.server';
import { hasOrdersAccess } from '~/lib/sync/orders-access';
import { currentMonthRange, previousRange, shopProfitSQL } from './customers-query';

/**
 * Il profitto del negozio nel mese, con quello del mese prima per il confronto.
 *
 * E' il numero per cui il merchant apre l'app: quanto ho guadagnato, e sta
 * salendo o scendendo. Tutto il resto della dashboard — copertura, freschezza,
 * prodotti da sistemare — esiste per dire quanto ci si puo' fidare di questo.
 */

export interface ShopProfit {
  /** Profitto del periodo. null quando non c'e' modo di calcolarlo. */
  profit: number | null;
  orders: number;
  /** Variazione sul periodo precedente, in percentuale. null senza confronto. */
  change: number | null;
  /** Quante righe d'ordine hanno un costo, sul totale: l'affidabilita' del numero. */
  coveredLines: number;
  totalLines: number;
  currency: string;
  /** Perche' non c'e' niente da mostrare, quando non c'e'. */
  unavailable: 'no_orders_access' | 'not_connected' | null;
}

interface ProfitRow {
  orders: number | string;
  profit: number | string;
  covered_lines: number | string;
  total_lines: number | string;
  currency: string | null;
}

function num(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function loadShopProfit(shopDomain: string): Promise<ShopProfit> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    include: { supabaseConfig: true },
  });

  const empty = (unavailable: ShopProfit['unavailable']): ShopProfit => ({
    profit: null,
    orders: 0,
    change: null,
    coveredLines: 0,
    totalLines: 0,
    currency: 'EUR',
    unavailable,
  });

  if (!shop?.supabaseConfig?.connectionVerifiedAt || !shop.supabaseConfig.supabaseProjectRef) {
    return empty('not_connected');
  }
  if (!hasOrdersAccess(shop.scopes)) return empty('no_orders_access');

  const token = await getValidAccessToken(shop.id);
  const ref = shop.supabaseConfig.supabaseProjectRef;
  const range = currentMonthRange();
  const before = previousRange(range.from, range.to);

  const [[current], [previous]] = await Promise.all([
    runQueryRows<ProfitRow>(token, ref, shopProfitSQL(range)),
    runQueryRows<ProfitRow>(token, ref, shopProfitSQL(before)),
  ]);

  const profit = Math.round(num(current?.profit) * 100) / 100;
  const was = previous ? Math.round(num(previous.profit) * 100) / 100 : 0;

  return {
    profit,
    orders: num(current?.orders),
    // Da zero non si calcola una percentuale: qualunque aumento sarebbe
    // "infinito per cento", e il mese scorso a zero e' il caso normale di un
    // negozio appena collegato.
    change: was === 0 ? null : Math.round(((profit - was) / Math.abs(was)) * 1000) / 10,
    coveredLines: num(current?.covered_lines),
    totalLines: num(current?.total_lines),
    currency: current?.currency ?? 'EUR',
    unavailable: null,
  };
}
