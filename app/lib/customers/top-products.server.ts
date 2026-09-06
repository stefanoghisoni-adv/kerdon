import { prisma } from '~/db.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQueryRows } from '~/lib/supabase-management.server';
import { hasOrdersAccess } from '~/lib/sync/orders-access';
import { topProductsSQL, type Metric } from './top-products';

export interface TopProduct {
  variantId: string;
  productId: string | null;
  title: string;
  variantTitle: string | null;
  orders: number;
  customers: number;
  cm: number;
  aop: number;
  acp: number;
  ltp: number;
}

export interface TopProductsReport {
  rows: TopProduct[];
  currency: string;
  unavailable: 'not_connected' | 'no_orders_access' | null;
}

interface Row {
  variant_id: number | string | null;
  product_id: number | string | null;
  product_title: string | null;
  variant_title: string | null;
  orders: number | string;
  customers: number | string;
  cm: number | string;
  aop: number | string;
  acp: number | string;
  ltp: number | string;
}

function num(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export async function loadTopProducts(
  shopDomain: string,
  opts: { from: string; to: string; metric: Metric; limit?: number },
): Promise<TopProductsReport> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: {
      id: true,
      scopes: true,
      shopCurrency: true,
      // Il fuso serve ai confini del periodo: senza, la classifica conterebbe i
      // giorni in UTC mentre le card accanto li contano nel calendario del
      // negozio.
      ianaTimezone: true,
      supabaseConfig: { select: { supabaseProjectRef: true, connectionVerifiedAt: true } },
    },
  });

  const empty = (unavailable: TopProductsReport['unavailable']): TopProductsReport => ({
    rows: [],
    currency: shop?.shopCurrency ?? 'EUR',
    unavailable,
  });

  const ref = shop?.supabaseConfig?.supabaseProjectRef;
  if (!shop || !ref || !shop.supabaseConfig?.connectionVerifiedAt) return empty('not_connected');
  if (!hasOrdersAccess(shop.scopes)) return empty('no_orders_access');

  const token = await getValidAccessToken(shop.id);
  const rows = await runQueryRows<Row>(
    token,
    ref,
    topProductsSQL({ ...opts, timeZone: shop.ianaTimezone }),
  );

  return {
    rows: rows.map((row) => ({
      variantId: String(row.variant_id ?? ''),
      productId: row.product_id === null ? null : String(row.product_id),
      // Il titolo puo' mancare quando il prodotto e' stato cancellato dal
      // negozio dopo l'ordine: la riga resta, perche' quel profitto e' stato
      // fatto davvero.
      title: row.product_title ?? '—',
      // Shopify chiama cosi' la variante unica: mostrarla direbbe
      // "Maglietta / Default Title".
      variantTitle:
        row.variant_title && row.variant_title !== 'Default Title' ? row.variant_title : null,
      orders: num(row.orders),
      customers: num(row.customers),
      cm: num(row.cm),
      aop: num(row.aop),
      acp: num(row.acp),
      ltp: num(row.ltp),
    })),
    currency: shop.shopCurrency ?? 'EUR',
    unavailable: null,
  };
}
