import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { orderIdFromReceipt, type WebhookOrderPayload } from '~/lib/customers/order-webhook-payload';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';

/**
 * Un ordine cancellato da Shopify.
 *
 * E' l'unico dei topic sugli ordini che NON rilegge niente, e non per
 * risparmiare una chiamata: non c'e' piu' niente da rileggere. Della ricevuta si
 * prende l'identificativo minimo — l'id, e basta — e con quello si tolgono
 * l'ordine e le sue righe dal database del merchant.
 *
 * Perche' toglierli davvero. Un ordine cancellato non e' un ordine annullato:
 * l'annullato resta, con la sua data, e a escluderlo dal profitto ci pensa il
 * conto. Il cancellato invece su Shopify non esiste piu', e lasciarlo qui
 * significa un profitto che il merchant non ritrova da nessuna parte e non puo'
 * spiegarsi — con l'aggravante che nessuna corsa periodica lo toglierebbe mai,
 * perche' la corsa legge cio' che c'e' e non sa cosa e' sparito.
 *
 * Prima le righe e poi l'ordine, al contrario della scrittura: se ci si ferma a
 * meta' resta un ordine senza righe — visibile, correggibile, e che non porta
 * margine — invece di righe che nessuna query saprebbe raggruppare.
 *
 * La condizione e' la stessa della scrittura, e non e' una svista: verrebbe da
 * lasciar passare sempre una cancellazione, ma la copia del merchant si ferma
 * tutta insieme. Se le aggiunte sono bloccate e le rimozioni no, quel che resta
 * non e' piu' la fotografia di niente — e' un archivio che si svuota da solo.
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

  let orderId: number | null = null;

  try {
    let payload: WebhookOrderPayload;
    try {
      payload = JSON.parse(body) as WebhookOrderPayload;
    } catch {
      // Definitivo, non passeggero: lo stesso JSON malformato non diventera'
      // valido riprovandolo.
      console.error('[webhook orders/delete] corpo del webhook illeggibile');
      return json({ ok: true }, { status: 200 });
    }

    orderId = orderIdFromReceipt(payload);
    if (orderId === null) {
      console.warn('[webhook orders/delete] payload senza id ordine');
      return json({ ok: true }, { status: 200 });
    }

    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { supabaseConfig: true },
    });

    if (!shop?.supabaseConfig) return json({ ok: true }, { status: 200 });
    if (!can(await shopCapabilities(shop), 'sync_orders')) {
      return json({ ok: true }, { status: 200 });
    }

    const supabase = createSupabaseClient(shop.supabaseConfig);

    const { error: linesError } = await supabase
      .from('order_lines')
      .delete()
      .eq('shopify_order_id', orderId);

    if (linesError) {
      console.error(
        `[webhook orders/delete] righe dell ordine ${orderId} non rimosse: ${linesError.message}`,
      );
      // 500: le righe sono rimaste e continuerebbero a portare margine. Shopify
      // riprova, e cancellare due volte lo stesso ordine non fa danni.
      return json({ error: 'order_delete_failed' }, { status: 500 });
    }

    const { error: orderError } = await supabase
      .from('orders')
      .delete()
      .eq('shopify_order_id', orderId);

    if (orderError) {
      console.error(
        `[webhook orders/delete] ordine ${orderId} non rimosso: ${orderError.message}`,
      );
      return json({ error: 'order_delete_failed' }, { status: 500 });
    }

    console.log(
      `[webhook orders/delete] ${JSON.stringify({ shop: shopDomain, order: orderId, status: 'completed' })}`,
    );
    return json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error(
      `[webhook orders/delete] ordine ${orderId} su ${shopDomain}:`,
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
    // Un guasto nostro non deve costare l'evento: qui l'evento e' l'unica
    // notizia che quell'ordine non esiste piu', e non arrivera' una seconda
    // volta se non chiedendola.
    return json({ error: 'processing_failed' }, { status: 500 });
  }
}
