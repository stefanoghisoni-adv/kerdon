import { prisma } from '~/db.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import {
  evaluateShopCapabilities,
  type CapabilityPlan,
  type ShopCapabilities,
} from './capabilities';

/**
 * La policy, applicata a un negozio vero.
 *
 * `capabilities.ts` decide; questo modulo va a prendere i fatti su cui decide.
 * La separazione non e' cerimonia: la decisione dev'essere provabile senza un
 * database, e chi ha gia' la riga dello shop in mano — quasi tutti i loader e
 * tutti i webhook — non deve rileggerla per chiedere un permesso.
 */

/**
 * Le colonne che la policy legge.
 *
 * Chi carica lo shop da se' con una `select` ristretta deve chiedere queste,
 * altrimenti la policy deciderebbe su campi assenti — cioe' negherebbe tutto, o
 * peggio, non compilerebbe. Tenerle in una costante fa si' che aggiungere un
 * fatto alla policy si veda subito in ogni query.
 */
export const CAPABILITY_SHOP_SELECT = {
  uninstalledAt: true,
  authorization: true,
  trackingAuthorization: true,
  scopes: true,
  currentPlan: true,
  supabaseConfig: { select: { connectionVerifiedAt: true } },
} as const;

/** La forma minima di riga shop che la policy sa leggere. */
export interface CapabilityShopRow {
  uninstalledAt: Date | null;
  authorization: string | null;
  trackingAuthorization: string | null;
  scopes: string | null;
  currentPlan: string | null;
  supabaseConfig?: { connectionVerifiedAt: Date | null } | null;
}

/**
 * Le capacita' di un negozio di cui si ha gia' la riga.
 *
 * Un negozio nullo — riga mai creata, dominio sconosciuto — non passa: la
 * policy lo tratta come "non identificato" e nega tutto.
 */
export async function shopCapabilities(
  shop: CapabilityShopRow | null | undefined,
): Promise<ShopCapabilities> {
  if (!shop) return evaluateShopCapabilities(null);
  return shopCapabilitiesWithPlan(shop, await findPlanByName(shop.currentPlan));
}

/**
 * Come sopra, ma con il piano gia' in mano.
 *
 * Serve a chi il piano lo ha appena letto per altri motivi (il cron lo legge
 * per la cadenza, i processor per il tetto dei prodotti): chiedere la policy non
 * deve costare una seconda interrogazione del listino a ogni giro su ogni
 * negozio.
 */
export function shopCapabilitiesWithPlan(
  shop: CapabilityShopRow | null | undefined,
  plan: CapabilityPlan | null | undefined,
): ShopCapabilities {
  if (!shop) return evaluateShopCapabilities(null);
  return evaluateShopCapabilities({
    uninstalledAt: shop.uninstalledAt,
    authorization: shop.authorization,
    trackingAuthorization: shop.trackingAuthorization,
    connectionVerifiedAt: shop.supabaseConfig?.connectionVerifiedAt ?? null,
    scopes: shop.scopes,
    plan: plan ?? null,
  });
}

/** Le capacita' del negozio con questo dominio. Sconosciuto → tutto negato. */
export async function shopCapabilitiesByDomain(
  shopDomain: string,
): Promise<ShopCapabilities> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: CAPABILITY_SHOP_SELECT,
  });
  return shopCapabilities(shop);
}

/** Le capacita' del negozio con questo id. Sconosciuto → tutto negato. */
export async function shopCapabilitiesById(shopId: string): Promise<ShopCapabilities> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: CAPABILITY_SHOP_SELECT,
  });
  return shopCapabilities(shop);
}
