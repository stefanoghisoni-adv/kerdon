// app/lib/webhooks/handle-order.server.ts
//
// Cosa succede a un ordine quando la notizia che e' cambiato e' gia' al sicuro.
//
// E' il corpo che stava dentro `webhooks.orders` e `webhooks.orders.delete`,
// spostato dopo la ricevuta. Tre topic passano di qui — `orders/create`,
// `orders/updated`, `refunds/create` — e fanno la stessa cosa: dicono QUALE
// ordine, e l'ordine si rilegge. Il rimborso e' il caso che rende evidente
// perche' rileggere: e' l'evento in cui l'ordine cambia senza che nessuna riga
// nuova compaia.
//
// PERCHE' ERA PROPRIO QUI CHE FACEVA PIU' DANNO. Questo webhook scatta a ogni
// vendita, ed era il piu' lento di tutti: rilettura GraphQL dell'ordine con
// tutte le sue righe, scrittura dell'ordine, scrittura delle righe,
// cancellazione per differenza, e infine il legame fra browser e cliente. Tutto
// dentro la richiesta, prima di rispondere. Nelle ore di punta un negozio
// spedisce raffiche di consegne, e ogni timeout diventava un ritentativo che
// rifaceva daccapo cio' che era gia' riuscito.
//
// LA TRACCIA RESTA, E ADESSO E' DOPPIA. Il log `[webhook orders]` c'era gia' e
// non si tocca: si legge subito. Il registro dei job pure. Sopra tutti e due
// c'e' ora la riga dell'evento, che dice se il lavoro e' concluso, quante volte
// ci si e' provati e con che errore — cioe' l'unica delle tre a cui si possa
// chiedere "cosa e' rimasto indietro".

import { prisma } from '~/db.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { applyOrderToMerchant, OrderWriteError } from '~/lib/customers/order-write.server';
import { loadLogisticsConfigForWrite } from '~/lib/shipping/load-config.server';
import { denialOf, can, type DenialReason } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import { linkUserToCustomer } from '~/lib/tracking/users.server';
import { provisionUsersTable } from '~/lib/supabase/ensure-users-table.server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClaimedWebhookEvent } from './inbox.server';
import type { WebhookOutcome } from './inbox-model';
import { readOrderTrigger, type OrderTrigger } from './trigger';

/** Com'e' finita, in una forma sola per tutti e tre i canali. */
interface OrderWebhookOutcome {
  shopDomain: string;
  orderId: number | null;
  outcome: 'completed' | 'skipped' | 'failed';
  /** Cos'e' successo, in italiano leggibile: e' quello che si cerca nel log. */
  detail: string;
  lines?: number;
  /** Quante righe obsolete si sono tolte riconciliando. */
  deleted?: number;
  /** `false` = l'elenco delle righe era troncato. Vedi `order-write`. */
  linesComplete?: boolean;
}

/**
 * La riga nel log, sempre con la stessa forma cosi' da poterla ritrovare
 * cercando `[webhook orders]`. Un fallimento va su `console.error` perche' e'
 * l'unico canale che gli strumenti di allerta guardano davvero.
 */
function logOrderWebhook(outcome: OrderWebhookOutcome): void {
  const line = JSON.stringify({
    webhook: 'orders',
    shop: outcome.shopDomain,
    order: outcome.orderId,
    status: outcome.outcome,
    detail: outcome.detail,
    ...(outcome.lines !== undefined ? { lines: outcome.lines } : {}),
    ...(outcome.deleted !== undefined ? { deleted: outcome.deleted } : {}),
    ...(outcome.linesComplete !== undefined ? { lines_complete: outcome.linesComplete } : {}),
    at: new Date().toISOString(),
  });

  if (outcome.outcome === 'failed') console.error(`[webhook orders] ${line}`);
  else console.log(`[webhook orders] ${line}`);
}

/**
 * Il fallimento anche nel registro dei job, dove non scorre via.
 *
 * Solo il fallimento: una riga per ogni ordine riuscito sarebbe una riga per
 * ogni vendita del negozio, cioe' la tabella dei job trasformata in un giornale
 * di cassa che nessuno legge. Il successo si accontenta del log — e' la
 * differenza di volume fra questo webhook e quello dei prodotti a giustificare
 * l'asimmetria.
 *
 * Il dettaglio finisce in `errors` per la stessa ragione per cui ci finisce la
 * traccia GDPR: e' l'unica colonna libera, e questi job non compaiono nel log
 * mostrato al merchant.
 */
async function recordOrderWebhookFailure(
  shopId: string,
  outcome: OrderWebhookOutcome,
): Promise<void> {
  try {
    await prisma.syncJob.create({
      data: {
        shopId,
        jobType: 'webhook',
        status: 'failed',
        completedAt: new Date(),
        errors: {
          message: outcome.detail,
          order_webhook: {
            order: outcome.orderId,
            ...(outcome.lines !== undefined ? { lines: outcome.lines } : {}),
            ...(outcome.linesComplete !== undefined
              ? { lines_complete: outcome.linesComplete }
              : {}),
          },
        },
      },
    });
  } catch (error) {
    // Se nemmeno la traccia si riesce a scrivere resta il log applicativo, che
    // e' esattamente il motivo per cui i due canali esistono entrambi.
    console.error(
      `[webhook orders] traccia non salvata per ${outcome.shopDomain}:`,
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
  }
}

/**
 * Un ordine che va ripreso in mano, e non e' un fallimento.
 *
 * L'elenco delle righe era troncato: si e' scritto quel che c'era e non si e'
 * cancellato niente, quindi puo' essere rimasta indietro una riga che l'ordine
 * non ha piu'. Ci torna la corsa periodica, che dell'ordine rilegge sempre
 * tutte le righe — e' `order.stale-lines` nella tassonomia, riparabile e
 * recuperato dal delta, quindi NON un motivo per ritentare il webhook: il
 * ritentativo rileggerebbe lo stesso elenco troncato.
 *
 * Va nel registro e non solo nel log per una ragione precisa: e' l'elenco degli
 * ordini di cui SAPPIAMO che i numeri sono provvisori. Senza, l'unico modo di
 * ritrovarli sarebbe rileggere tutto il negozio sperando che basti.
 */
async function recordOrderRepairPending(
  shopId: string,
  orderId: number | null,
  reason: string,
): Promise<void> {
  try {
    await prisma.syncJob.create({
      data: {
        shopId,
        jobType: 'order_repair_pending',
        status: 'completed',
        completedAt: new Date(),
        errors: { message: reason, order_repair: { order: orderId } },
      },
    });
  } catch (error) {
    console.error(
      `[webhook orders] riparazione in sospeso non registrata per l ordine ${orderId}:`,
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
  }
}

/** I due canali insieme: e' cosi' che si chiude ogni strada di questo handler. */
async function saveOrderWebhookOutcome(
  shopId: string | null,
  outcome: OrderWebhookOutcome,
): Promise<void> {
  logOrderWebhook(outcome);
  if (outcome.outcome === 'failed' && shopId) {
    await recordOrderWebhookFailure(shopId, outcome);
  }
}

/**
 * Lega al cliente il browser che ha riempito il carrello.
 *
 * L'identificativo viaggia come attributo di carrello privato — il nome
 * comincia con un underscore, e Shopify per quello non lo mostra ne' al cliente
 * ne' sulla conferma d'ordine — e arriva nella busta del webhook dentro
 * `note_attributes`. E' l'unica cosa per cui la ricevuta resta insostituibile:
 * gli attributi del carrello in GraphQL non ci sono, e la rilettura canonica
 * non li porterebbe. Per questo, e solo per questo, il trigger conservato se lo
 * porta dietro.
 *
 * Si esce in silenzio in due casi, ed e' giusto cosi': un ordine senza account
 * cliente (acquisto come ospite) non ha nessuno a cui legare il browser, e un
 * ordine senza l'attributo viene da un negozio che il tracciamento non l'ha
 * ancora configurato. Nessuno dei due e' un errore da segnalare.
 *
 * RESTA BEST EFFORT, ED E' L'UNICO PASSO CHE LO RESTA. Non e' una dimenticanza:
 * un negozio che non ha mai configurato il tracciamento non ha la tabella dei
 * visitatori, e trasformare quel caso in un ritentativo vorrebbe dire mandare
 * in lettera morta — dopo cinque tentativi — ordini che sono stati scritti
 * benissimo. Un legame mancato si recupera alla prossima identificazione o al
 * prossimo ordine; un ordine dichiarato non consegnato no.
 */
async function linkVisitorToCustomer(
  shopId: string,
  supabase: SupabaseClient,
  trigger: OrderTrigger,
): Promise<void> {
  if (trigger.customerId === null || !trigger.externalId) return;

  try {
    await linkUserToCustomer(
      supabase,
      { externalId: trigger.externalId, shopifyCustomerId: trigger.customerId },
      () => provisionUsersTable(shopId, supabase),
    );
  } catch (error) {
    console.warn(
      '[webhook orders] legame browser-cliente non riuscito:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
  }
}

/**
 * Perche' un ordine non e' stato scritto, detto in italiano.
 *
 * Il registro degli ordini lo legge chi deve capire cosa e' successo a un
 * ordine che non si trova, quindi il motivo della policy non basta cosi' com'e':
 * `plan_required` non dice niente a chi guarda. Le prime due frasi sono quelle
 * che c'erano prima, parola per parola: chi ha imparato a riconoscerle in un
 * registro non deve reimpararle.
 */
const ORDER_SKIP_DETAIL: Record<DenialReason, string> = {
  not_connected: 'nessun progetto collegato e verificato: non c e dove scrivere',
  scope_required: 'permesso sugli ordini non concesso',
  unknown_shop: 'negozio non riconosciuto',
  erasing: 'cancellazione dei dati del negozio in corso: non si scrive piu nulla',
  uninstalled: 'app disinstallata: la sincronizzazione e ferma',
  not_authorized: 'uso dell app sospeso: la sincronizzazione e ferma',
  tracking_suspended: 'tracciamento sospeso',
  plan_required: 'funzione non compresa nel piano',
  trial_expired:
    'periodo di prova terminato: la sincronizzazione riparte scegliendo un piano',
};

/** Un ordine creato, aggiornato o rimborsato: si rilegge e si riscrive. */
export async function handleOrderUpsert(
  event: ClaimedWebhookEvent,
  _now: Date = new Date(),
): Promise<WebhookOutcome> {
  const shopDomain = event.shopDomain;
  const trigger = readOrderTrigger(event.payload);

  // Senza id non c'e' un ordine da rileggere, e non esiste ripiego che non sia
  // indovinare quale. Ritentare non lo farebbe comparire.
  if (!trigger) {
    await saveOrderWebhookOutcome(null, {
      shopDomain,
      orderId: null,
      outcome: 'skipped',
      detail: 'payload senza id ordine',
    });
    return 'dead_letter';
  }

  const orderId = trigger.orderId;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    include: { supabaseConfig: true },
  });
  const shopId = shop?.id ?? null;

  if (!shop?.supabaseConfig) {
    await saveOrderWebhookOutcome(shopId, {
      shopDomain,
      orderId,
      outcome: 'skipped',
      detail: ORDER_SKIP_DETAIL.not_connected,
    });
    return 'done';
  }

  // Le due condizioni che si guardavano qui — il progetto collegato e il
  // permesso sugli ordini — erano giuste ma incomplete: mancavano
  // l'autorizzazione all'uso dell'app e la disinstallazione, e mancavano
  // proprio qui, dove il merchant non deve fare niente perche' arrivi una
  // notifica. Un negozio sospeso continuava a vedersi scrivere ogni ordine.
  //
  // Il motivo del rifiuto non si butta: e' quello che finisce nel registro, ed
  // e' l'unica cosa che poi permette di capire perche' un ordine non c'e'.
  const denial = denialOf(await shopCapabilities(shop), 'sync_orders');
  if (denial) {
    await saveOrderWebhookOutcome(shopId, {
      shopDomain,
      orderId,
      outcome: 'skipped',
      detail: ORDER_SKIP_DETAIL[denial],
    });
    return 'done';
  }

  // La rilettura canonica: l'ordine com'e' adesso, con tutte le sue righe, con
  // la quantita' corrente e il netto di riga che il payload non ha.
  const shopifyClient = await ShopifyAPIClient.forShop(shop.shopDomain);
  const order = await shopifyClient.getOrderById(orderId);

  if (!order) {
    // Ordine sparito fra la notifica e la rilettura, o fuori dalla finestra che
    // il negozio ci concede. Non si scrive e non si cancella: non abbiamo letto
    // niente, e su un non-letto non si decide niente. Della ricevuta si conserva
    // l'unica cosa che ha — l'identificativo — perche' quell'ordine resti
    // ritrovabile invece di sparire in silenzio.
    await recordOrderRepairPending(
      shop.id,
      orderId,
      'ordine non piu leggibile su Shopify: nessuna scrittura, identificativo conservato',
    );
    await saveOrderWebhookOutcome(shopId, {
      shopDomain,
      orderId,
      outcome: 'skipped',
      detail: 'ordine non piu leggibile su Shopify',
    });
    return 'done';
  }

  const supabase = createSupabaseClient(shop.supabaseConfig);

  // Le tariffe, una volta per evento: servono al costo logistico che si scrive
  // sull'ordine. Se non si leggono il costo resta zero, e l'ordine si scrive
  // lo stesso — e' lui la ragione per cui questo handler esiste.
  const logisticsConfig = await loadLogisticsConfigForWrite(shop.id);

  let written;
  try {
    written = await applyOrderToMerchant({ supabase, order, logisticsConfig });
  } catch (error) {
    if (error instanceof OrderWriteError) {
      await saveOrderWebhookOutcome(shopId, {
        shopDomain,
        orderId,
        outcome: 'failed',
        detail:
          error.step === 'order'
            ? `ordine non scritto: ${error.message}`
            : `righe non scritte: ${error.message}`,
        lines: order.lines.length,
        linesComplete: order.lines_complete,
      });
      // Il database del merchant non ha accettato la scrittura, e quasi sempre
      // e' passeggero. L'evento resta da lavorare: sono upsert sulle stesse
      // chiavi, quindi il ritentativo non fa danni.
      return 'retry';
    }
    throw error;
  }

  if (!written) {
    await saveOrderWebhookOutcome(shopId, {
      shopDomain,
      orderId,
      outcome: 'skipped',
      detail: 'ordine non convertibile in righe',
    });
    return 'done';
  }

  // Riconciliazione non finita: o l'elenco delle righe era troncato, o la
  // cancellazione di quelle obsolete non e' riuscita. Nessuno dei due e' un
  // motivo per non scrivere: si scrive quel che c'e', non si cancella niente
  // alla cieca, e si dichiara che qualcuno deve tornarci sopra. Ci torna la
  // corsa periodica, che dell'ordine rilegge sempre tutte le righe.
  if (written.repairPending) {
    console.warn(
      `[webhook orders] riconciliazione non conclusa per l ordine ${orderId} (${shopDomain}): scritte le prime ${written.lines}, nessuna cancellazione a rischio, ci torna la corsa periodica`,
    );
    await recordOrderRepairPending(shop.id, orderId, 'riconciliazione delle righe rimandata');
  }

  // Il legame piu' forte che esiste fra un browser e una persona, e arriva
  // gratis: nella stessa busta ci sono l'id del cliente Shopify e
  // l'identificativo del browser che ha riempito quel carrello. Non serve che
  // il cliente abbia fatto login, non serve che si sia iscritto a niente,
  // basta che abbia comprato.
  //
  // I due pezzi vengono dalla STESSA busta — sono i due campi che il trigger
  // conserva insieme — o si rischierebbe di attaccare il browser di un ordine
  // al cliente di un altro.
  //
  // Dopo la scrittura dell'ordine e non prima: l'ordine e' cio' per cui questo
  // handler esiste, e una riga di `users` non deve poterlo rallentare ne' farlo
  // fallire. `linkVisitorToCustomer` non solleva mai.
  await linkVisitorToCustomer(shop.id, supabase, trigger);

  await saveOrderWebhookOutcome(shopId, {
    shopDomain,
    orderId,
    outcome: 'completed',
    detail: 'ordine riletto e riscritto',
    lines: written.lines,
    deleted: written.deleted,
    linesComplete: order.lines_complete,
  });

  return 'done';
}

/**
 * Un ordine cancellato da Shopify.
 *
 * E' l'unico dei topic sugli ordini che NON rilegge niente, e non per
 * risparmiare una chiamata: non c'e' piu' niente da rileggere. Del trigger si
 * prende l'identificativo minimo — l'id, e basta, conservato alla ricevuta
 * proprio perche' dopo non sarebbe piu' ricavabile da nessuna parte — e con
 * quello si tolgono l'ordine e le sue righe dal database del merchant.
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
export async function handleOrderDelete(
  event: ClaimedWebhookEvent,
  _now: Date = new Date(),
): Promise<WebhookOutcome> {
  const shopDomain = event.shopDomain;
  const trigger = readOrderTrigger(event.payload);

  if (!trigger) {
    console.warn('[webhook orders/delete] payload senza id ordine');
    return 'dead_letter';
  }

  const orderId = trigger.orderId;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    include: { supabaseConfig: true },
  });

  if (!shop?.supabaseConfig) return 'done';
  if (!can(await shopCapabilities(shop), 'sync_orders')) return 'done';

  const supabase = createSupabaseClient(shop.supabaseConfig);

  const { error: linesError } = await supabase
    .from('order_lines')
    .delete()
    .eq('shopify_order_id', orderId);

  if (linesError) {
    console.error(
      `[webhook orders/delete] righe dell ordine ${orderId} non rimosse: ${linesError.message}`,
    );
    // Le righe sono rimaste e continuerebbero a portare margine: l'evento resta
    // da lavorare. Cancellare due volte lo stesso ordine non fa danni.
    return 'retry';
  }

  const { error: orderError } = await supabase
    .from('orders')
    .delete()
    .eq('shopify_order_id', orderId);

  if (orderError) {
    console.error(
      `[webhook orders/delete] ordine ${orderId} non rimosso: ${orderError.message}`,
    );
    return 'retry';
  }

  console.log(
    `[webhook orders/delete] ${JSON.stringify({ shop: shopDomain, order: orderId, status: 'completed' })}`,
  );
  return 'done';
}
