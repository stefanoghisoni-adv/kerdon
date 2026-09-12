// app/routes/api.stats.customers.tsx
import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { countMarketingConsent } from '~/lib/stats/customer-consent-stats';
import {
  getCustomerStatsCache,
  setCustomerStatsCache,
} from '~/lib/cache/stats-cache.server';
import type { ShopifyCustomer } from '~/types/shopify';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { requireShopCapability } from '~/lib/authz/require-capability.server';

export async function loader({ request }: LoaderFunctionArgs) {
  // Prima del piano e prima della cache: qui si contano i clienti del negozio
  // interrogando Shopify pagina per pagina, e un negozio fermo — prova finita,
  // sospeso, in cancellazione — non deve arrivarci nemmeno per un conteggio.
  const { shop } = await requireShopCapability(request, 'use_app');

  // Il piano non include i clienti: nessuna chiamata a Shopify, la card e' bloccata.
  const plan = await findPlanByName(shop.currentPlan);
  if (!plan?.customersSyncEnabled) {
    return json({ enabled: false, totalCustomers: 0, optIn: 0, optOut: 0, cached: false });
  }

  // Cache-then-refresh, come /api/stats/products: risposta immediata dalla cache e
  // ricalcolo live innescato dal client quando vede cached:true.
  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  if (!refresh) {
    const cached = await getCustomerStatsCache(shop.id);
    if (cached) {
      return json({
        enabled: true,
        totalCustomers: cached.totalCustomers,
        optIn: cached.optIn,
        optOut: cached.optOut,
        cached: true,
      });
    }
  }

  const client = await ShopifyAPIClient.forShop(shop.shopDomain);

  let optIn = 0;
  let optOut = 0;
  let pageInfo: string | undefined;

  do {
    const { customers, nextPageInfo } = await client.getCustomers({ limit: 250, pageInfo });
    const counts = countMarketingConsent((customers ?? []) as ShopifyCustomer[]);
    optIn += counts.optIn;
    optOut += counts.optOut;
    pageInfo = nextPageInfo ?? undefined;
  } while (pageInfo);

  const result = { totalCustomers: optIn + optOut, optIn, optOut };
  await setCustomerStatsCache(shop.id, result);

  return json({ enabled: true, ...result, cached: false });
}
