import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import {
  customerIdFromReceipt,
  orderIdFromReceipt,
  type WebhookOrderPayload,
} from '~/lib/customers/order-webhook-payload';
import {
  applyOrderToMerchant,
  OrderWriteError,
} from '~/lib/customers/order-write.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { denialOf, type DenialReason } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { externalIdFromNoteAttributes } from '~/lib/tracking/users';
import { linkUserToCustomer } from '~/lib/tracking/users.server';
import { provisionUsersTable } from '~/lib/supabase/ensure-users-table.server';

/**
 * Un ordine cambiato, riletto e riscritto subito.
 *
 * E' l'unica cosa che non aspetta la corsa periodica, e per una ragione sola:
 * un ordine e' il momento in cui i numeri del negozio cambiano davvero. Sapere
 * fra sei ore che si e' venduto — o che si e' rimborsato — e' tardi per chi sta
 * guardando come gira una campagna, mentre un prodotto rinominato o un cliente
 * che cambia indirizzo possono aspettare il giro della notte.
 *
 * IL PAYLOAD E' UN INNESCO, NON UNA FONTE. Del corpo si prende l'id dell'ordine
 * (e gli attributi del carrello, che solo li' passano); tutto il resto si
 * rilegge da GraphQL. Il perche' sta per esteso in
 * lib/customers/order-webhook-payload, e in breve e' questo: il corpo REST non
 * ha ne' la quantita' corrente ne' il netto di riga, cioe' i due soli valori su
 * cui si puo' fare un margine che sopravviva a un rimborso. Ricostruirli dal
 * payload voleva dire scrivere numeri gonfiati e lasciare che fosse la corsa
 * periodica a correggerli di soppiatto, ore dopo.
 *
 * TRE TOPIC, UNA STRADA: `orders/create`, `orders/updated`, `refunds/create`.
 * Il rimborso e' il caso che rende evidente perche' rileggere — e' l'evento in
 * cui l'ordine cambia senza che nessuna riga nuova compaia — ma la strada e' la
 * stessa: si guarda quale ordine, lo si rilegge, lo si riscrive. La
 * cancellazione dell'ordine ha invece un handler suo, perche' li' non c'e'
 * niente da rileggere (`webhooks.orders.delete`).
 *
 * QUANDO SI RISPONDE COSA. 200 vuol dire "non c'e' niente da riprovare": il
 * corpo illeggibile, l'ordine senza id, il negozio non collegato o sospeso,
 * l'ordine non piu' leggibile su Shopify. 500 vuol dire "riprova": la lettura o
 * la scrittura non riuscite, e tutto cio' che non sappiamo gestire. La
 * differenza non e' formale — un 200 su una scrittura fallita e' un ordine che
 * non torna mai piu', perche' Shopify considera la consegna riuscita e non la
 * ripete.
 *
 * LA TRACCIA. Comunque si risponda, non si tace: ogni esito lascia una riga
 * `[webhook orders]` nel log, e un fallimento lascia anche una riga nel
 * registro dei job. E' lo stesso doppio canale dei webhook GDPR, per lo stesso
 * motivo: il log si legge subito ma scorre via, il registro resta.
 */

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
 * Due casi, diversi fra loro e con lo stesso rimedio. L'elenco delle righe era
 * troncato: si e' scritto quel che c'era e non si e' cancellato niente, quindi
 * puo' essere rimasta indietro una riga che l'ordine non ha piu'. Oppure
 * l'ordine non si e' potuto rileggere affatto: allora dalla ricevuta si conserva
 * l'unica cosa che ha, il suo identificativo.
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
 * ne' sulla conferma d'ordine — e arriva qui dentro `note_attributes`, che e'
 * come la REST chiama gli attributi del carrello. Chi lo pianta e' il
 * tracciamento della vetrina, che l'identificativo ce l'ha gia' nel cookie
 * first-party.
 *
 * E' l'unica cosa per cui la ricevuta resta insostituibile: gli attributi del
 * carrello in GraphQL non ci sono, e la rilettura canonica non li porterebbe.
 *
 * Si esce in silenzio in due casi, ed e' giusto cosi': un ordine senza account
 * cliente (acquisto come ospite) non ha nessuno a cui legare il browser, e un
 * ordine senza l'attributo viene da un negozio che il tracciamento non l'ha
 * ancora configurato. Nessuno dei due e' un errore da segnalare.
 *
 * Tutto best effort: un legame mancato si recupera alla prossima
 * identificazione o al prossimo ordine, un webhook fallito no.
 */
async function linkVisitorToCustomer(
  shopId: string,
  supabase: SupabaseClient,
  payload: WebhookOrderPayload,
  shopifyCustomerId: number | null,
): Promise<void> {
  if (shopifyCustomerId === null) return;

  const externalId = externalIdFromNoteAttributes(payload.note_attributes);
  if (!externalId) return;

  try {
    await linkUserToCustomer(
      supabase,
      { externalId, shopifyCustomerId },
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

  let shopId: string | null = null;
  let orderId: number | null = null;

  try {
    let payload: WebhookOrderPayload;
    try {
      payload = JSON.parse(body) as WebhookOrderPayload;
    } catch {
      // Un corpo illeggibile e' un guasto DEFINITIVO, non passeggero: lo stesso
      // JSON malformato non diventera' valido riprovandolo. Rispondere 500
      // qui farebbe insistere Shopify per due giorni e poi spegnere la
      // sottoscrizione, per un evento che comunque non si potrebbe usare.
      // Quindi 200, ed e' l'unica eccezione alla regola piu' sotto.
      //
      // La traccia pero' resta: e' definitivo, non irrilevante — un corpo che
      // non si legge vuol dire che qualcosa a monte non va, e senza una riga
      // scritta da qualche parte nessuno lo saprebbe mai.
      await saveOrderWebhookOutcome(shopId, {
        shopDomain,
        orderId,
        outcome: 'failed',
        detail: 'corpo del webhook illeggibile',
      });
      return json({ ok: true }, { status: 200 });
    }

    orderId = orderIdFromReceipt(payload);

    // Senza id non c'e' un ordine da rileggere, e non esiste ripiego che non
    // sia indovinare quale.
    if (orderId === null) {
      await saveOrderWebhookOutcome(null, {
        shopDomain,
        orderId: null,
        outcome: 'skipped',
        detail: 'payload senza id ordine',
      });
      return json({ ok: true }, { status: 200 });
    }

    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { supabaseConfig: true },
    });
    shopId = shop?.id ?? null;

    if (!shop?.supabaseConfig) {
      await saveOrderWebhookOutcome(shopId, {
        shopDomain,
        orderId,
        outcome: 'skipped',
        detail: ORDER_SKIP_DETAIL.not_connected,
      });
      return json({ ok: true }, { status: 200 });
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
      return json({ ok: true }, { status: 200 });
    }

    // La rilettura canonica: l'ordine com'e' adesso, con tutte le sue righe,
    // con la quantita' corrente e il netto di riga che il payload non ha.
    const shopifyClient = await ShopifyAPIClient.forShop(shop.shopDomain);
    const order = await shopifyClient.getOrderById(orderId);

    if (!order) {
      // Ordine sparito fra la notifica e la rilettura, o fuori dalla finestra
      // che il negozio ci concede. Non si scrive e non si cancella: non abbiamo
      // letto niente, e su un non-letto non si decide niente. Della ricevuta si
      // conserva l'unica cosa che ha — l'identificativo — perche' quell'ordine
      // resti ritrovabile invece di sparire in silenzio.
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
      return json({ ok: true }, { status: 200 });
    }

    const supabase = createSupabaseClient(shop.supabaseConfig);

    let written;
    try {
      written = await applyOrderToMerchant({ supabase, order });
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
        // 500: il database del merchant non ha accettato la scrittura, e quasi
        // sempre e' passeggero. Rispondendo 200 diremmo a Shopify "ricevuto,
        // tutto a posto" per un ordine che non c'e' — e quella consegna non si
        // ripete piu'. La consegna ripetuta non fa danni: sono upsert sulle
        // stesse chiavi.
        return json(
          { error: error.step === 'order' ? 'order_write_failed' : 'lines_write_failed' },
          { status: 500 },
        );
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
      return json({ ok: true }, { status: 200 });
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
      await recordOrderRepairPending(
        shop.id,
        orderId,
        'riconciliazione delle righe rimandata',
      );
    }

    // Il legame piu' forte che esiste fra un browser e una persona, e arriva
    // gratis: nella stessa busta ci sono l'id del cliente Shopify e
    // l'identificativo del browser che ha riempito quel carrello. Non serve che
    // il cliente abbia fatto login, non serve che si sia iscritto a niente,
    // basta che abbia comprato.
    //
    // Il cliente si legge dalla RICEVUTA e non dall'ordine riletto, perche' e'
    // dalla ricevuta che viene anche l'attributo del carrello: i due pezzi del
    // legame devono venire dalla stessa busta, o si rischia di attaccare il
    // browser di un ordine al cliente di un altro.
    //
    // Dopo la scrittura dell'ordine e non prima: l'ordine e' cio' per cui
    // questo handler esiste, e una riga di `users` non deve poterlo rallentare
    // ne' farlo fallire. `linkVisitorToCustomer` non solleva mai.
    await linkVisitorToCustomer(shop.id, supabase, payload, customerIdFromReceipt(payload));

    await saveOrderWebhookOutcome(shopId, {
      shopDomain,
      orderId,
      outcome: 'completed',
      detail: 'ordine riletto e riscritto',
      lines: written.lines,
      deleted: written.deleted,
      linesComplete: order.lines_complete,
    });

    return json({ ok: true }, { status: 200 });
  } catch (error) {
    // Qui si finisce quando cade qualcosa che i passi sopra non sanno gestire:
    // l'API di Shopify che non risponde, il database dell'app irraggiungibile,
    // la chiave del progetto non decifrabile. La traccia deve restare: e'
    // l'errore che per mesi non si e' visto.
    await saveOrderWebhookOutcome(shopId, {
      shopDomain,
      orderId,
      outcome: 'failed',
      detail: error instanceof Error ? error.message : 'errore sconosciuto',
    });
    // 500, non 200: un guasto nostro non deve costare l'evento.
    //
    // Il timore che aveva portato al 200 e' vero ma va misurato: Shopify
    // riprova con attese crescenti per circa quarantott'ore, e disattiva la
    // sottoscrizione solo se in tutto quel tempo non riceve MAI una risposta
    // buona. Due giorni sono tanti per accorgersi di un guasto — e adesso ogni
    // fallimento lascia una traccia, quindi accorgersene e' possibile.
    //
    // I casi in cui davvero non c'e' niente da fare — payload senza id, negozio
    // sconosciuto o non collegato, permessi mancanti, ordine non piu' leggibile
    // — rispondono 200 piu' sopra, e non passano di qui: quelli riprovarli non
    // servirebbe a niente.
    return json({ error: 'processing_failed' }, { status: 500 });
  }
}
