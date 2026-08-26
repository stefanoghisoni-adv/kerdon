import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { orderToRows } from '~/lib/customers/order-rows';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import { syncIsActive } from '~/lib/sync/sync-active';
import { hasOrdersAccess } from '~/lib/sync/orders-access';

/**
 * Un ordine appena arrivato, scritto subito.
 *
 * E' l'unica cosa che non aspetta la corsa periodica, e per una ragione sola:
 * un ordine e' il momento in cui i numeri del negozio cambiano davvero. Sapere
 * fra sei ore che si e' venduto qualcosa e' tardi per chi sta guardando come
 * gira una campagna — mentre un prodotto rinominato o un cliente che cambia
 * indirizzo possono benissimo aspettare il giro della notte.
 *
 * Costa poco: un ordine e le sue righe, due scritture. Non e' una
 * sincronizzazione completa e non deve diventarlo — se il webhook si perde,
 * l'ordine lo recupera comunque la corsa periodica, che li rilegge tutti.
 * Questa e' una scorciatoia, non l'unica strada.
 */
export async function action({ request }: ActionFunctionArgs) {
  const body = await request.text();
  const hmac = request.headers.get('X-Shopify-Hmac-Sha256');

  if (!hmac || !verifyWebhook(body, hmac)) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }

  const shopDomain = request.headers.get('X-Shopify-Shop-Domain');
  if (!shopDomain) {
    return json({ error: 'Missing shop domain' }, { status: 400 });
  }

  // Da qui in giu' si risponde sempre 200, qualunque cosa vada storta. Un
  // errore restituito a Shopify fa ritentare la consegna e, dopo abbastanza
  // fallimenti, fa disattivare la sottoscrizione: un problema nostro finirebbe
  // per spegnere il webhook di quel negozio.
  try {
    const order = JSON.parse(body);
    if (!order?.id) return json({ ok: true }, { status: 200 });

    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { supabaseConfig: true },
    });

    if (!shop?.supabaseConfig || !syncIsActive(shop.supabaseConfig)) {
      return json({ ok: true }, { status: 200 });
    }

    // Il permesso sugli ordini si concede riaprendo l'app: finche' manca, le
    // tabelle degli ordini non esistono nemmeno e scriverci fallirebbe.
    if (!hasOrdersAccess(shop.scopes)) {
      return json({ ok: true }, { status: 200 });
    }

    const rows = orderToRows(order);
    // Un ordine senza righe utili — tutto rimborsato, o nessuna riga con un
    // prodotto riconoscibile — non ha niente da scrivere.
    if (!rows) return json({ ok: true }, { status: 200 });

    const supabase = createSupabaseClient(shop.supabaseConfig);

    // Prima l'ordine, poi le righe: al contrario, se l'ordine fallisse,
    // resterebbero righe che nessuna query saprebbe raggruppare.
    const { error: orderError } = await supabase
      .from('orders')
      .upsert([rows.order], { onConflict: 'shopify_order_id', ignoreDuplicates: false });

    if (orderError) {
      console.warn(`[webhook orders] ordine non scritto (${shopDomain}):`, orderError.message);
      return json({ ok: true }, { status: 200 });
    }

    if (rows.lines.length > 0) {
      const { error: linesError } = await supabase
        .from('order_lines')
        .upsert(rows.lines, { onConflict: 'shopify_line_id', ignoreDuplicates: false });

      if (linesError) {
        console.warn(`[webhook orders] righe non scritte (${shopDomain}):`, linesError.message);
      }
    }

    return json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error(
      `[webhook orders] errore su ${shopDomain}:`,
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
    return json({ ok: true }, { status: 200 });
  }
}
