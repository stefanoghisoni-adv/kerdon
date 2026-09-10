import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import { forgetProductScope } from '~/lib/sync/product-scope.server';

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

  try {
    const payload = JSON.parse(body);
    const { id: productId } = payload;

    if (!productId) {
      console.warn('Product delete webhook: missing product id');
      return json({ ok: true }, { status: 200 });
    }

    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { supabaseConfig: true },
    });

    if (!shop?.supabaseConfig) {
      return json({ ok: true }, { status: 200 });
    }

    // Stessa condizione della scrittura, e non e' una svista.
    //
    // Verrebbe da lasciar passare le cancellazioni sempre — togliere una riga
    // sembra sempre innocuo. Ma la copia del merchant si ferma tutta insieme:
    // se le aggiunte sono bloccate e le rimozioni no, quel che resta non e' piu'
    // una fotografia di niente, e' un catalogo che si svuota da solo. Un negozio
    // sospeso deve ritrovare i suoi dati come li aveva lasciati.
    //
    // Cio' che la legge impone di cancellare passa da un'altra parte e non e'
    // toccato da questo controllo: i webhook GDPR non chiedono niente alla
    // policy, e cancellano anche a negozio sospeso o disinstallato.
    if (!can(await shopCapabilities(shop), 'sync_products')) {
      return json({ ok: true }, { status: 200 });
    }

    const supabase = createSupabaseClient(shop.supabaseConfig);

    // Si cancella senza chiedere niente all'ambito, ed e' voluto.
    //
    // "Fuori quota" e "non esiste piu'" sono due cose diverse. Un prodotto che
    // il tetto del piano ha fermato tiene le sue righe — quello e' il punto di
    // tutto il registro dell'ambito — ma tenerle vuol dire non buttarle via
    // perche' sono vecchie, non tenerle anche quando il merchant ha cancellato
    // il prodotto. Se qui si guardasse l'ambito, un prodotto fermo e poi
    // eliminato resterebbe nel database del merchant per sempre: fuori ambito
    // non ci ripassa nessuna corsa, e nessuno verrebbe mai a toglierlo.
    const { error } = await supabase
      .from(shop.supabaseConfig.tableNameProducts)
      .delete()
      .eq('shopify_product_id', String(productId));

    if (error) {
      console.error('Supabase delete error:', error);
      await prisma.syncJob.create({
        data: {
          shopId: shop.id,
          jobType: 'webhook',
          status: 'failed',
          productsSynced: 0,
          variantsSynced: 0,
          errors: { message: error.message, code: error.code },
        },
      });
      // 500: il prodotto e' rimasto nel database del merchant e continuerebbe a
      // comparire nei suoi conti. Shopify riprova, e cancellare due volte lo
      // stesso prodotto non fa danni.
      return json({ error: 'product_delete_failed' }, { status: 500 });
    } else {
      // Via anche dal registro dell'ambito: un prodotto cancellato che restasse
      // in graduatoria continuerebbe a occupare un posto del tetto, e quel
      // posto e' un prodotto vivo tenuto fuori dalla sincronizzazione per
      // sempre. Best effort: la cancellazione dei dati del merchant e' gia'
      // andata a buon fine, e un guasto sulla nostra contabilita' non deve
      // farla ripetere.
      try {
        await forgetProductScope(shop.id, [productId]);
      } catch (scopeError) {
        console.warn(
          `Registro dell'ambito non aggiornato per il prodotto ${productId}:`,
          scopeError instanceof Error ? scopeError.message : scopeError,
        );
      }

      await prisma.syncJob.create({
        data: {
          shopId: shop.id,
          jobType: 'webhook',
          status: 'completed',
          productsSynced: 0,
          variantsSynced: 0,
          completedAt: new Date(),
        },
      });
    }

    return json({ ok: true }, { status: 200 });

  } catch (error) {
    console.error('Delete webhook error:', error);

    try {
      const shop = await prisma.shop.findUnique({
        where: { shopDomain },
      });
      if (shop) {
        await prisma.syncJob.create({
          data: {
            shopId: shop.id,
            jobType: 'webhook',
            status: 'failed',
            productsSynced: 0,
            variantsSynced: 0,
            errors: { message: String(error) },
          },
        });
      }
    } catch {
      // Silent fail on logging
    }

    // 500 anche qui: qui si arriva per i guasti nostri, che sono passeggeri, e
    // un guasto nostro non deve costare la cancellazione.
    return json({ error: 'processing_failed' }, { status: 500 });
  }
}
