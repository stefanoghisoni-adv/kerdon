import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { requireCustomersSyncShop } from '~/lib/integrations/route-guard.server';
import { buildAuthorizeUrl } from '~/lib/integrations/klaviyo/oauth.server';

export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await requireCustomersSyncShop(request);
  if (shop instanceof Response) return shop;

  const url = buildAuthorizeUrl(shop.id);
  return json({ url });
}
