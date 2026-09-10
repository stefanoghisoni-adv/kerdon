// app/lib/webhooks/handle-product.server.ts
//
// Cosa succede a un prodotto quando la notizia che e' cambiato e' gia' al
// sicuro.
//
// E' il corpo che stava dentro `webhooks.products.create` e
// `webhooks.products.delete`, spostato dopo la ricevuta. Le decisioni sono le
// stesse e i commenti che le spiegano sono rimasti: il payload non e' una
// fotografia del prodotto, l'elenco delle varianti si cancella per differenza
// solo quando e' completo, un negozio sospeso non si fa scrivere dentro nemmeno
// le cancellazioni.
//
// LE DUE COSE CHE CAMBIANO. La prima: gli esiti non sono piu' codici HTTP. Dove
// si rispondeva 500 adesso si restituisce `retry` — l'evento torna in attesa
// con il suo distanziamento, e a ritentare siamo noi invece di Shopify. Dove si
// rispondeva 200 senza aver fatto niente si restituisce `done`. La seconda: le
// tre pulizie in coda non sono piu' avvisi nel log, sono passi del lavoro (vedi
// `cleanup.ts`).
//
// PERCHE' RITENTARE E' SICURO. Ogni passo e' idempotente: si rilegge il
// prodotto da Shopify, si fa un upsert sulla chiave della variante, si cancella
// per uguaglianza. Rifare tutto dopo un passo caduto a meta' non produce niente
// di diverso da farlo una volta sola.

import { prisma } from '~/db.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { transformProduct } from '~/lib/transformers/product.server';
import { enrichVariantCosts } from '~/lib/stats/inventory-cost.server';
import { filterEligibleProductRows } from '~/lib/eligibility/product-eligibility';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import { forgetProductScope } from '~/lib/sync/product-scope.server';
import type { ShopifyProduct } from '~/types/shopify';
import type { ClaimedWebhookEvent } from './inbox.server';
import type { WebhookOutcome } from './inbox-model';
import { readProductTrigger } from './trigger';
import { afterCleanupFailure } from './cleanup';

/** Il negozio con il suo collegamento, o niente. */
async function shopFor(shopDomain: string) {
  return prisma.shop.findUnique({
    where: { shopDomain },
    include: { supabaseConfig: true },
  });
}

/**
 * Prodotto creato o aggiornato su Shopify.
 *
 * Del trigger si prende UNA sola cosa: l'id. Tutto il resto — varianti
 * comprese — si rilegge dall'API.
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
export async function handleProductUpsert(
  event: ClaimedWebhookEvent,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  const trigger = readProductTrigger(event.payload);
  if (!trigger) {
    // Nessun prodotto nominato: ritentare non lo farebbe comparire.
    return 'dead_letter';
  }

  const shop = await shopFor(event.shopDomain);
  if (!shop || !shop.supabaseConfig) {
    console.log(`Shop ${event.shopDomain} not configured for sync`);
    return 'done';
  }

  // Il negozio puo' ancora ricevere prodotti nel suo database?
  //
  // Qui si guardava solo se il progetto fosse collegato. Ma il collegamento
  // sopravvive alla sospensione e alla disinstallazione — le tabelle restano
  // dove sono, ed e' giusto cosi' — quindi un negozio bloccato continuava a
  // farsi scrivere dentro a ogni modifica di prodotto. Bastava non passare
  // dalla dashboard: le notifiche arrivano da sole, e nessuno le fermava.
  // Ora la condizione e' una sola, la stessa della corsa periodica.
  if (!can(await shopCapabilities(shop), 'sync_products')) {
    console.log(`Sync not active for shop ${event.shopDomain}`);
    return 'done';
  }

  const shopifyClient = await ShopifyAPIClient.forShop(shop.shopDomain);

  // La rilettura: il prodotto com'e' adesso, con TUTTE le sue varianti
  // (`getProductById` esaurisce la connessione annidata) e con il bit che dice
  // se ci e' riuscito.
  const product = (await shopifyClient.getProductById(
    trigger.productId,
  )) as ShopifyProduct | null;

  if (!product) {
    // Prodotto sparito fra la notifica e la rilettura: a toglierlo dal database
    // ci pensa il webhook di cancellazione, che sa di essere una cancellazione.
    // Qui si tace: non abbiamo letto nulla, e non si cancella su un non-letto.
    console.warn(
      `Prodotto ${trigger.productId} non leggibile su ${event.shopDomain}: nessuna scrittura`,
    );
    return 'done';
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
      `Elenco varianti incompleto per il prodotto ${trigger.productId}: riconciliazione saltata, nessuna cancellazione`,
    );
  }

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
        const esito = afterCleanupFailure(
          'product.orphan-delete',
          `prodotto ${trigger.productId} di ${event.shopDomain}`,
          delAllError,
        );
        if (esito) return esito;
      }
    }
    await registraCorsa(shop.id, { productsSynced: 0, variantsSynced: 0 }, now);
    return 'done';
  }

  // Upsert delle sole righe idonee con la chiave univoca.
  const { error } = await supabase.from(tableName).upsert(rows, {
    onConflict: 'shopify_variant_id',
    ignoreDuplicates: false,
  });

  if (error) {
    console.error('Supabase products upsert error:', error);
    await registraFallimento(shop.id, { message: error.message, code: error.code });
    // L'evento resta da lavorare: la scrittura non e' riuscita, e dichiararla
    // riuscita vuol dire che quel prodotto non torna piu'. Il ritentativo e' un
    // upsert sulla stessa chiave, quindi non fa danni.
    return 'retry';
  }

  // Riconcilia: elimina le righe del prodotto il cui variant_id non è più tra
  // le idonee correnti (varianti rimosse, transizione multi→single, o varianti
  // che hanno perso il costo). Di nuovo: solo con l'elenco completo in mano.
  const currentVariantIds = rows.map((r) => r.shopify_variant_id).filter(Boolean);
  if (canReconcile && currentVariantIds.length > 0) {
    const { error: deleteError } = await supabase
      .from(tableName)
      .delete()
      .eq('shopify_product_id', product.id)
      .not('shopify_variant_id', 'in', `(${currentVariantIds.map((id) => `'${id}'`).join(',')})`);

    if (deleteError) {
      const esito = afterCleanupFailure(
        'product.orphan-delete',
        `varianti obsolete del prodotto ${trigger.productId}`,
        deleteError,
      );
      if (esito) return esito;
    }
  }

  // Righe legacy con variant_id NULL (create prima dell'id reale): rimuovile.
  const { error: legacyDeleteError } = await supabase
    .from(tableName)
    .delete()
    .eq('shopify_product_id', product.id)
    .is('shopify_variant_id', null);

  if (legacyDeleteError) {
    const esito = afterCleanupFailure(
      'product.orphan-delete',
      `righe senza id variante del prodotto ${trigger.productId}`,
      legacyDeleteError,
    );
    if (esito) return esito;
  }

  await registraCorsa(shop.id, { productsSynced: 1, variantsSynced: rows.length }, now);
  return 'done';
}

/**
 * Prodotto cancellato su Shopify.
 *
 * Non si rilegge niente, e non per risparmiare una chiamata: non c'e' piu'
 * niente da rileggere. Del trigger si prende l'identificativo conservato alla
 * ricevuta, ed e' l'unica cosa che ne resta.
 */
export async function handleProductDelete(
  event: ClaimedWebhookEvent,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  const trigger = readProductTrigger(event.payload);
  if (!trigger) return 'dead_letter';

  const shop = await shopFor(event.shopDomain);
  if (!shop?.supabaseConfig) return 'done';

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
  if (!can(await shopCapabilities(shop), 'sync_products')) return 'done';

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
    .eq('shopify_product_id', String(trigger.productId));

  if (error) {
    console.error('Supabase delete error:', error);
    await registraFallimento(shop.id, { message: error.message, code: error.code });
    // Il prodotto e' rimasto nel database del merchant e continuerebbe a
    // comparire nei suoi conti: l'evento resta da lavorare. Cancellare due
    // volte lo stesso prodotto non fa danni.
    return 'retry';
  }

  // Via anche dal registro dell'ambito: un prodotto cancellato che restasse in
  // graduatoria continuerebbe a occupare un posto del tetto, e quel posto e' un
  // prodotto vivo tenuto fuori dalla sincronizzazione per sempre.
  //
  // Era best effort, e non poteva piu' esserlo: senza un posto in cui quel
  // lavoro resti scritto, un fallimento qui non lo recuperava nessuno. Adesso
  // e' un passo, e il ritentativo rifa' anche la cancellazione dei dati del
  // merchant — che e' una `delete` per uguaglianza, quindi non fa danni.
  try {
    await forgetProductScope(shop.id, [trigger.productId]);
  } catch (scopeError) {
    const esito = afterCleanupFailure(
      'product.orphan-delete',
      `registro dell ambito per il prodotto ${trigger.productId}`,
      scopeError,
    );
    if (esito) return esito;
  }

  await registraCorsa(shop.id, { productsSynced: 0, variantsSynced: 0 }, now);
  return 'done';
}

async function registraCorsa(
  shopId: string,
  conteggi: { productsSynced: number; variantsSynced: number },
  now: Date,
): Promise<void> {
  await prisma.syncJob.create({
    data: {
      shopId,
      jobType: 'webhook',
      status: 'completed',
      ...conteggi,
      completedAt: now,
    },
  });
}

/**
 * Il fallimento nel registro dei job.
 *
 * Non solleva: se nemmeno la traccia si riesce a scrivere resta il log
 * applicativo, e soprattutto resta la riga dell'evento con il suo `lastError` —
 * che e' il registro vero di questa storia. Far cadere l'esito del webhook per
 * una riga di diario sarebbe la coda che muove il cane.
 */
async function registraFallimento(
  shopId: string,
  errors: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.syncJob.create({
      data: {
        shopId,
        jobType: 'webhook',
        status: 'failed',
        productsSynced: 0,
        variantsSynced: 0,
        errors: errors as never,
      },
    });
  } catch (error) {
    console.error(
      '[webhook-inbox] traccia del fallimento non salvata:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
  }
}
