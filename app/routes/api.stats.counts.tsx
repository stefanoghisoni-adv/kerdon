// app/routes/api.stats.counts.tsx
// Conteggi "leggeri" e sempre live: totale prodotti (products/count.json) e
// totale clienti (customers/count.json). Una sola chiamata ciascuno, eseguite in
// parallelo: alimentano subito PlanBanner, card "Prodotti totali"/"Clienti" e
// l'anteprima di sync, senza attendere la paginazione completa della readiness.
import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { requireShopCapability } from '~/lib/authz/require-capability.server';

export async function loader({ request }: LoaderFunctionArgs) {
  // Il permesso prima di tutto: queste due domande a Shopify parlano del
  // catalogo e dell'anagrafica del negozio, e un negozio fermo non deve
  // vederle solo perche' ha chiamato la rotta invece di aprire la dashboard.
  const { shop } = await requireShopCapability(request, 'use_app');

  const plan = await findPlanByName(shop.currentPlan);
  const customersEnabled = plan?.customersSyncEnabled ?? false;

  const client = await ShopifyAPIClient.forShop(shop.shopDomain);

  const [totalProducts, customerCount] = await Promise.all([
    client.getProductsCount(),
    customersEnabled ? client.getCustomersCount() : Promise.resolve(null),
  ]);

  return json({ totalProducts, customersEnabled, customerCount });
}
