import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { orderToRows } from '~/lib/customers/order-rows';
import {
  webhookOrderToShopifyOrder,
  type WebhookOrderPayload,
} from '~/lib/customers/order-webhook-payload';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import { denialOf, type DenialReason } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { externalIdFromNoteAttributes } from '~/lib/tracking/users';
import { linkUserToCustomer } from '~/lib/tracking/users.server';
import { provisionUsersTable } from '~/lib/supabase/ensure-users-table.server';

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
 *
 * IL CORPO VA TRADOTTO PRIMA. Shopify manda l'ordine nei nomi della REST
 * (`line_items`, `created_at`, `price`), mentre da qui in giu' tutto e' scritto
 * per la forma normalizzata che produce `getOrders`. La traduzione, e il perche'
 * si traduce invece di rileggere l'ordine dall'API come fanno i prodotti, stanno
 * in lib/customers/order-webhook-payload.
 *
 * LA TRACCIA. Sotto si risponde 200 qualunque cosa vada storta, ed e' giusto
 * cosi' (vedi il commento al `try`), ma rispondere 200 non e' tacere: ogni esito
 * lascia una riga `[webhook orders]` nel log, e un fallimento lascia anche una
 * riga nel registro dei job. E' lo stesso doppio canale dei webhook GDPR, per lo
 * stesso motivo: il log si legge subito ma scorre via, il registro resta. Senza,
 * un handler che risponde sempre "va tutto bene" e' indistinguibile da uno che
 * non ha mai scritto niente — che e' esattamente com'e' stato per un po'.
 */

/** Com'e' finita, in una forma sola per tutti e tre i canali. */
interface OrderWebhookOutcome {
  shopDomain: string;
  orderId: number | null;
  outcome: 'completed' | 'skipped' | 'failed';
  /** Cos'e' successo, in italiano leggibile: e' quello che si cerca nel log. */
  detail: string;
  lines?: number;
  /** `false` = l'elenco delle righe era troncato. Vedi il mapper. */
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
  uninstalled: 'app disinstallata: la sincronizzazione e ferma',
  not_authorized: 'uso dell app sospeso: la sincronizzazione e ferma',
  tracking_suspended: 'tracciamento sospeso',
  plan_required: 'funzione non compresa nel piano',
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

  // Da qui in giu' si risponde sempre 200, qualunque cosa vada storta. Un
  // errore restituito a Shopify fa ritentare la consegna e, dopo abbastanza
  // fallimenti, fa disattivare la sottoscrizione: un problema nostro finirebbe
  // per spegnere il webhook di quel negozio. Rispondere 200 pero' non autorizza
  // a non dire niente, ed e' il compito di `saveOrderWebhookOutcome`.
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
    const order = webhookOrderToShopifyOrder(payload);

    // Senza id non c'e' ordine da riconoscere: alla corsa dopo ne nascerebbe un
    // doppione, quindi si preferisce non scriverlo affatto.
    if (!order) {
      await saveOrderWebhookOutcome(null, {
        shopDomain,
        orderId: null,
        outcome: 'skipped',
        detail: 'payload senza id ordine',
      });
      return json({ ok: true }, { status: 200 });
    }

    orderId = order.id;

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

    // Da qui in poi e' la stessa trasformazione della corsa periodica, sulla
    // stessa forma: e' tutto il senso di aver tradotto il payload prima.
    const rows = orderToRows(order);
    if (!rows) {
      await saveOrderWebhookOutcome(shopId, {
        shopDomain,
        orderId,
        outcome: 'skipped',
        detail: 'ordine non convertibile in righe',
      });
      return json({ ok: true }, { status: 200 });
    }

    // Un elenco troncato non e' un motivo per non scrivere: si scrive quel che
    // c'e', e lo si dichiara per quello che e'. Le righe mancanti arrivano con
    // la corsa periodica, che le rilegge tutte esaurendo la connessione.
    if (order.lines_complete === false) {
      console.warn(
        `[webhook orders] elenco righe troncato per l ordine ${orderId} (${shopDomain}): scritte le prime ${rows.lines.length}, il resto arriva con la corsa periodica`,
      );
    }

    const supabase = createSupabaseClient(shop.supabaseConfig);

    // Prima l'ordine, poi le righe: al contrario, se l'ordine fallisse,
    // resterebbero righe che nessuna query saprebbe raggruppare.
    const { error: orderError } = await supabase
      .from('orders')
      .upsert([rows.order], { onConflict: 'shopify_order_id', ignoreDuplicates: false });

    if (orderError) {
      await saveOrderWebhookOutcome(shopId, {
        shopDomain,
        orderId,
        outcome: 'failed',
        detail: `ordine non scritto: ${orderError.message}`,
        lines: rows.lines.length,
        linesComplete: order.lines_complete,
      });
      return json({ ok: true }, { status: 200 });
    }

    // Il legame piu' forte che esiste fra un browser e una persona, e arriva
    // gratis: nella stessa busta ci sono l'id del cliente Shopify e
    // l'identificativo del browser che ha riempito quel carrello. Non serve che
    // il cliente abbia fatto login, non serve che si sia iscritto a niente,
    // basta che abbia comprato.
    //
    // Dopo la scrittura dell'ordine e non prima: l'ordine e' cio' per cui
    // questo handler esiste, e una riga di `users` non deve poterlo rallentare
    // ne' farlo fallire. `linkVisitorToCustomer` non solleva mai.
    await linkVisitorToCustomer(shop.id, supabase, payload, order.customer_id);

    // Un ordine senza righe si scrive lo stesso: vale per i totali del negozio
    // anche quando non ha nulla da raggruppargli sotto — un ordine di soli
    // servizi, o uno le cui righe sono rimaste fuori perche' senza id.
    if (rows.lines.length > 0) {
      const { error: linesError } = await supabase
        .from('order_lines')
        .upsert(rows.lines, { onConflict: 'shopify_line_id', ignoreDuplicates: false });

      if (linesError) {
        await saveOrderWebhookOutcome(shopId, {
          shopDomain,
          orderId,
          outcome: 'failed',
          detail: `righe non scritte: ${linesError.message}`,
          lines: rows.lines.length,
          linesComplete: order.lines_complete,
        });
        return json({ ok: true }, { status: 200 });
      }
    }

    await saveOrderWebhookOutcome(shopId, {
      shopDomain,
      orderId,
      outcome: 'completed',
      detail: 'ordine e righe scritti',
      lines: rows.lines.length,
      linesComplete: order.lines_complete,
    });

    return json({ ok: true }, { status: 200 });
  } catch (error) {
    // Qui si finisce quando cade qualcosa che i passi sopra non sanno gestire:
    // il corpo illeggibile, il database dell'app irraggiungibile, la chiave del
    // progetto non decifrabile. Shopify si sente rispondere 200 lo stesso, ma la
    // traccia deve restare: e' l'errore che per mesi non si e' visto.
    await saveOrderWebhookOutcome(shopId, {
      shopDomain,
      orderId,
      outcome: 'failed',
      detail: error instanceof Error ? error.message : 'errore sconosciuto',
    });
    // 500, non 200: un guasto nostro non deve costare l'evento.
    //
    // Qui si arriva per cio' che non sappiamo gestire — Supabase irraggiungibile,
    // il database dell'app che non risponde, una chiave non decifrabile. Sono
    // quasi sempre guasti passeggeri, e rispondendo 200 dicevamo a Shopify
    // "ricevuto, tutto a posto": nessun nuovo tentativo, e quell'ordine o quel
    // cliente non tornava mai piu'.
    //
    // Il timore che aveva portato al 200 e' vero ma va misurato: Shopify
    // riprova con attese crescenti per circa quarantott'ore, e disattiva la
    // sottoscrizione solo se in tutto quel tempo non riceve MAI una risposta
    // buona. Due giorni sono tanti per accorgersi di un guasto — e adesso ogni
    // fallimento lascia una traccia, quindi accorgersene e' possibile.
    //
    // I casi in cui davvero non c'e' niente da fare — payload senza id, negozio
    // sconosciuto o non collegato, permessi mancanti — rispondono 200 piu'
    // sopra, e non passano di qui: quelli riprovarli non servirebbe a niente.
    return json({ error: 'processing_failed' }, { status: 500 });
  }
}
