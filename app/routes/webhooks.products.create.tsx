import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { transformProduct } from '~/lib/transformers/product.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { enrichVariantCosts } from '~/lib/stats/inventory-cost.server';
import { filterEligibleProductRows } from '~/lib/eligibility/product-eligibility';
import type { ShopifyProduct } from '~/types/shopify';
import { syncIsActive } from '~/lib/sync/sync-active';

/**
 * Prodotto creato o aggiornato su Shopify.
 *
 * Del corpo del webhook si prende UNA sola cosa: l'id. Tutto il resto —
 * varianti comprese — si rilegge dall'API.
 *
 * Il motivo e' che il payload non e' una fotografia garantita del prodotto:
 * l'elenco delle varianti che Shopify ci spedisce e' troncato, e comunque
 * nessuna documentazione promette che sia integrale. Trattarlo come completo
 * significava cancellare dal database del merchant ogni variante che il webhook
 * non nominava — cioe' esattamente le varianti dei prodotti piu' grandi, quelli
 * a cui il merchant tiene di piu'. Una notifica dice "questo prodotto e'
 * cambiato", non "questo prodotto adesso e' cosi'".
 *
 * Rileggere costa una chiamata in piu', che qui c'era gia' comunque: il costo
 * del venduto vive sull'InventoryItem e nel payload non compare mai.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Verify HMAC signature
  const body = await request.text();
  const hmac = request.headers.get('X-Shopify-Hmac-Sha256');

  if (!hmac || !verifyWebhook(body, hmac)) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Extract shop domain
  const shopDomain = request.headers.get('X-Shopify-Shop-Domain');
  if (!shopDomain) {
    return json({ error: 'Missing shop domain' }, { status: 400 });
  }

  try {
    // Del payload serve solo l'id: le varianti che porta con se' non sono un
    // elenco su cui si possa decidere cosa cancellare.
    const payload = JSON.parse(body) as { id?: number | string };
    const productId = Number(payload?.id);

    if (!Number.isFinite(productId) || productId <= 0) {
      console.warn('Invalid product payload: missing id');
      return json({ ok: true }, { status: 200 });
    }

    // Load shop config
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { supabaseConfig: true },
    });

    if (!shop || !shop.supabaseConfig) {
      console.log(`Shop ${shopDomain} not configured for sync`);
      return json({ ok: true }, { status: 200 }); // Acknowledge anyway
    }

    if (!syncIsActive(shop.supabaseConfig)) {
      console.log(`Sync not active for shop ${shopDomain}`);
      return json({ ok: true }, { status: 200 });
    }

    const shopifyClient = await ShopifyAPIClient.forShop(shop.shopDomain);

    // La rilettura: il prodotto com'e' adesso, con TUTTE le sue varianti
    // (`getProductById` esaurisce la connessione annidata) e con il bit che dice
    // se ci e' riuscito.
    const product = (await shopifyClient.getProductById(productId)) as ShopifyProduct | null;

    if (!product) {
      // Prodotto sparito fra la notifica e la rilettura: a toglierlo dal database
      // ci pensa il webhook di cancellazione, che sa di essere una cancellazione.
      // Qui si tace: non abbiamo letto nulla, e non si cancella su un non-letto.
      console.warn(`Prodotto ${productId} non leggibile su ${shopDomain}: nessuna scrittura`);
      return json({ ok: true }, { status: 200 });
    }

    // Il cost_per_item vive sull'InventoryItem: arricchiamo il costo prima di
    // trasformare, altrimenti ogni update scriverebbe cost_per_item null
    // (variante non idonea → rimossa).
    await enrichVariantCosts(shopifyClient, [product]);

    // Solo righe idonee (con costo).
    const rows = filterEligibleProductRows(transformProduct(product));

    // L'unica condizione che autorizza a cancellare per differenza: sotto c'e'
    // l'elenco vero, non la parte che siamo riusciti a leggere.
    const canReconcile = product.variants_complete === true;
    if (!canReconcile) {
      console.warn(
        `Elenco varianti incompleto per il prodotto ${productId}: riconciliazione saltata, nessuna cancellazione`,
      );
    }

    // Create Supabase client
    const supabase = createSupabaseClient(shop.supabaseConfig);
    const tableName = shop.supabaseConfig.tableNameProducts;

    if (rows.length === 0) {
      // Nessuna variante idonea: rimuovi tutte le righe del prodotto (potrebbe
      // aver perso il costo su tutte le varianti). Solo pero' se l'elenco era
      // completo — "non ho visto varianti idonee" non e' "non ce ne sono", e con
      // un elenco monco questa e' la cancellazione piu' distruttiva di tutte.
      if (canReconcile) {
        const { error: delAllError } = await supabase
          .from(tableName)
          .delete()
          .eq('shopify_product_id', product.id);
        if (delAllError) {
          console.warn('Could not remove rows for now-ineligible product:', delAllError);
        }
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
      return json({ ok: true }, { status: 200 });
    }

    // Upsert delle sole righe idonee con la chiave univoca.
    const { error } = await supabase
      .from(tableName)
      .upsert(rows, {
        onConflict: 'shopify_variant_id',
        ignoreDuplicates: false,
      });

    if (error) {
      console.error('Supabase products upsert error:', error);
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
      return json({ ok: true }, { status: 200 });
    }

    // Riconcilia: elimina le righe del prodotto il cui variant_id non è più tra
    // le idonee correnti (varianti rimosse, transizione multi→single, o varianti
    // che hanno perso il costo). Di nuovo: solo con l'elenco completo in mano.
    const currentVariantIds = rows.map(r => r.shopify_variant_id).filter(Boolean);
    if (canReconcile && currentVariantIds.length > 0) {
      const { error: deleteError } = await supabase
        .from(tableName)
        .delete()
        .eq('shopify_product_id', product.id)
        .not('shopify_variant_id', 'in', `(${currentVariantIds.map(id => `'${id}'`).join(',')})`);

      if (deleteError) {
        console.warn('Could not clean stale variants:', deleteError);
      }
    }

    // Righe legacy con variant_id NULL (create prima dell'id reale): rimuovile.
    const { error: legacyDeleteError } = await supabase
      .from(tableName)
      .delete()
      .eq('shopify_product_id', product.id)
      .is('shopify_variant_id', null);

    if (legacyDeleteError) {
      console.warn('Could not clean legacy null-variant row:', legacyDeleteError);
    }

    // Log successful sync
    await prisma.syncJob.create({
      data: {
        shopId: shop.id,
        jobType: 'webhook',
        status: 'completed',
        productsSynced: 1,
        variantsSynced: rows.length,
        completedAt: new Date(),
      },
    });

    return json({ ok: true }, { status: 200 });

  } catch (error) {
    console.error('Webhook processing error:', error);

    // Try to log failed job (shop config may not exist)
    try {
      const shop = await prisma.shop.findUnique({
        where: { shopDomain: shopDomain || '' },
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

    return json({ ok: true }, { status: 200 });
  }
}
