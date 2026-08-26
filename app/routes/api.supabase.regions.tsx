import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { listRegions, SUPABASE_REGIONS } from '~/lib/supabase-management.server';
import { suggestRegion } from '~/lib/supabase/suggest-region';

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) throw new Response('Shop non trovato', { status: 404 });

  // Quale consigliare: si decide qui perche' qui c'e' il fuso orario del
  // negozio, che il browser non conosce — chi apre l'admin puo' trovarsi
  // ovunque, il negozio no.
  const suggest = (regions: { id: string; name: string }[]) => ({
    regions,
    suggested: suggestRegion(shop.ianaTimezone, regions),
  });

  try {
    const token = await getValidAccessToken(shop.id);
    const regions = await listRegions(token);
    return json(suggest(regions));
  } catch (e) {
    console.error('[api.supabase.regions]', e instanceof Error ? e.message : 'errore sconosciuto');
    // Fallback: restituisci comunque la lista statica per non bloccare il form.
    return json(suggest(SUPABASE_REGIONS));
  }
}
