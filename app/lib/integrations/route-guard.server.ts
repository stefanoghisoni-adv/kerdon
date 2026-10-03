import { json } from '@remix-run/node';
import type { Shop } from '@prisma/client';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { dictionaryForShop } from '~/lib/i18n/server';

/**
 * Guard per le rotte delle integrazioni che richiedono customersSyncEnabled.
 *
 * Verifica in ordine:
 * 1. Shop esistente
 * 2. Shop non sospeso (use_app capability)
 * 3. Piano con customersSyncEnabled
 *
 * @returns Lo shop se tutte le verifiche passano, altrimenti una Response 403/404
 */
export async function requireCustomersSyncShop(request: Request): Promise<Shop | Response> {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    return json({ error: 'not_found' }, { status: 404 });
  }

  if (!can(await shopCapabilities(shop), 'use_app')) {
    return json(
      {
        error: (await dictionaryForShop(session.shop)).errors.suspended,
        code: 'not_authorized',
      },
      { status: 403 },
    );
  }

  const plan = await findPlanByName(shop.currentPlan);
  if (!plan?.customersSyncEnabled) {
    return json({ error: 'plan_missing_customers_sync' }, { status: 403 });
  }

  return shop;
}

/**
 * Guard base per le rotte delle integrazioni che non richiedono un piano specifico.
 *
 * Verifica solo:
 * 1. Shop esistente
 *
 * Nota: NON verifica use_app né il piano. Questo permette a un merchant sospeso
 * o con un piano downgraded di vedere lo stato della connessione e scollegare
 * l'integrazione, che è la sua via d'uscita (come per Supabase disconnect).
 *
 * @returns Lo shop se esiste, altrimenti una Response 404
 */
export async function requireShop(request: Request): Promise<Shop | Response> {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    return json({ error: 'not_found' }, { status: 404 });
  }

  return shop;
}
