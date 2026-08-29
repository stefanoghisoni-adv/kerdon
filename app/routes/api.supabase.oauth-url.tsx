import { dictionaryForShop } from '~/lib/i18n/server';
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { signState } from '~/lib/supabase-oauth.server';
import { buildAuthorizeUrl } from '~/lib/supabase-management.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';

export async function action({ request }: ActionFunctionArgs) {
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

  const clientId = process.env.SUPABASE_OAUTH_CLIENT_ID;
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!clientId || !appUrl) {
    return json({ error: 'Integrazione Supabase non configurata' }, { status: 500 });
  }

  const state = signState(shop.id);
  const url = buildAuthorizeUrl({
    clientId,
    redirectUri: `${appUrl}/auth/supabase/callback`,
    state,
  });

  return json({ url });
}
