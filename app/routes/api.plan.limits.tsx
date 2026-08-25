import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { samePlanName } from '~/lib/billing/plan-name';
import { BASE_CURRENCY } from '~/lib/billing/money';
import { resolveShopPricing } from '~/lib/billing/shop-pricing.server';
import { wantedCurrency } from '~/lib/i18n/preferences';

/**
 * Piano in uso e listino, per l'avviso sul limite prodotti.
 *
 * Solo database: nessuna chiamata a Shopify. L'avviso compare su tre pagine
 * diverse, e farlo costare una lettura del catalogo ogni volta lo renderebbe un
 * peso proprio dove il merchant sta facendo altro. Il conteggio dei prodotti
 * arriva dalla readiness, che ha gia' la sua cache.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { supabaseConfig: true },
  });
  if (!shop) {
    return json({ connected: false, currentPlan: null, plans: [], currency: BASE_CURRENCY });
  }

  const plans = await prisma.plan.findMany();

  // Anche qui i prezzi escono nella valuta del negozio: l'avviso propone un
  // piano e ne scrive il costo, e un costo in una valuta che il merchant non
  // usa e' peggio di nessun costo.

  const reserved = shop.partnerName
    ? await prisma.partnerPlanPrice.count({ where: { partnerName: shop.partnerName } })
    : 0;
  const pricing = await resolveShopPricing(
    plans.map((p) => ({
      planName: p.planName,
      maxProducts: p.maxProducts,
      maxCustomers: p.maxCustomers,
      customersSyncEnabled: p.customersSyncEnabled,
    })),
    { preferredCurrency: wantedCurrency(shop), hasReservedPrice: reserved > 0 },
  );

  return json({
    // Il tetto prodotti parla di una sincronizzazione che senza database non
    // esiste: chi mostra l'avviso deve poter tacere finche' il collegamento non
    // c'e'. La regola sta qui e non nelle tre pagine che lo ospitano, cosi' non
    // puo' valere in una e non nelle altre.
    connected: !!shop.supabaseConfig?.connectionVerifiedAt,
    currentPlanName: shop.currentPlan,
    currency: pricing.currency,
    plans: pricing.plans,
    currentPlan: pricing.plans.find((p) => samePlanName(p.planName, shop.currentPlan)) ?? null,
  });
}
