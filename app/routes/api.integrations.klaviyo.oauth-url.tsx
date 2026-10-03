import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import { dictionaryForShop } from '~/lib/i18n/server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { buildAuthorizeUrl } from '~/lib/integrations/klaviyo/oauth.server';

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    return json({ error: 'Shop non trovato' }, { status: 404 });
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
    return json(
      { error: 'Il piano attuale non include la sincronizzazione clienti' },
      { status: 403 },
    );
  }

  const url = buildAuthorizeUrl(shop.id);
  return json({ url });
}
