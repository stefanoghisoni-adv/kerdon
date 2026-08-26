import { prisma } from '~/db.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';

/**
 * Se il piano di questo negozio concede i feed di catalogo.
 *
 * Vive sul server e si chiede a ogni azione che accende un feed, non solo
 * quando si disegna il pulsante: un pulsante disabilitato si riabilita
 * dall'ispettore del browser in tre secondi, e da li' in poi la richiesta
 * arriva identica a quella di chi ha pagato. Il controllo che conta e' questo.
 */
export async function shopCanUseFeeds(shopDomain: string): Promise<boolean> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { currentPlan: true },
  });
  if (!shop) return false;

  const plan = await findPlanByName(shop.currentPlan);
  return plan?.productFeedsEnabled ?? false;
}
