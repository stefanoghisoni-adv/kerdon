// app/lib/webhooks/handle-customer.server.ts
//
// Cosa succede a un cliente quando la notizia che e' cambiato e' gia' al
// sicuro.
//
// E' il corpo che stava dentro `webhooks.customers.create` e
// `webhooks.customers.delete`, spostato dopo la ricevuta. La regola sul
// consenso e' la stessa parola per parola — consenziente: riga completa; non
// consenziente: nessuna insert, e quel che c'era si svuota di cio' che
// identifica la persona — e cosi' la regola sulle cancellazioni, che valgono
// solo per un negozio che potrebbe anche scrivere.
//
// LA COSA CHE CAMBIA DAVVERO: IL CLIENTE SI RILEGGE. Prima l'anagrafica
// arrivava dal corpo del webhook e si scriveva quella. Adesso della consegna si
// conserva il solo identificativo, e nome, email, telefono e indirizzo si
// rileggono da Shopify quando si lavora. Due motivi, e il secondo da solo
// basterebbe.
//
// Il primo e' che il corpo di un webhook e' vecchio quanto l'istante in cui e'
// stato spedito: due modifiche ravvicinate arrivano in due buste, e se la
// seconda viene lavorata per prima — un ritentativo, un drenaggio — si scrive
// sopra la piu' recente la piu' vecchia. Rileggendo, l'ultima lavorazione
// scrive sempre lo stato corrente, in qualunque ordine arrivino.
//
// Il secondo e' che `webhook_events` sta nel database owner e la riga vive una
// settimana: conservare li' l'anagrafica di una persona vorrebbe dire tenere
// dati personali in un posto che nessuna cancellazione attraversa. Vedi
// `trigger.ts`.
//
// Se fra la notifica e la rilettura il cliente e' sparito, non si scrive e non
// si cancella: non abbiamo letto niente, e su un non-letto non si decide niente.
// A toglierlo ci pensa il webhook di cancellazione, che sa di esserlo.

import { prisma } from '~/db.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { transformCustomer } from '~/lib/transformers/customer.server';
import { withdrawConsentFor } from '~/lib/customers/consent-withdrawal';
import { isCustomerOptedIn } from '~/lib/stats/customer-consent-stats';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import type { ShopifyCustomer } from '~/types/shopify';
import type { ClaimedWebhookEvent } from './inbox.server';
import type { WebhookOutcome } from './inbox-model';
import { readCustomerTrigger } from './trigger';

async function shopFor(shopDomain: string) {
  return prisma.shop.findUnique({
    where: { shopDomain },
    include: { supabaseConfig: true },
  });
}

/** Cliente creato o aggiornato su Shopify. */
export async function handleCustomerUpsert(
  event: ClaimedWebhookEvent,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  const trigger = readCustomerTrigger(event.payload);
  if (!trigger) return 'dead_letter';

  const shop = await shopFor(event.shopDomain);
  if (!shop || !shop.supabaseConfig) {
    console.log(`Shop ${event.shopDomain} not configured for sync`);
    return 'done';
  }

  // Il collegamento e il piano si guardavano gia', una condizione per volta;
  // l'autorizzazione no, e nemmeno la disinstallazione. Erano proprio quelle
  // due a mancare ovunque, ed erano le uniche che il merchant non poteva
  // cambiare da se': un negozio sospeso continuava a farsi scrivere i clienti
  // dentro, senza nessun gesto suo, perche' le notifiche arrivano da sole.
  // Ora la domanda e' una: questo negozio puo' sincronizzare i clienti?
  if (!can(await shopCapabilities(shop), 'sync_customers')) {
    console.log(`Customer sync not enabled for shop ${event.shopDomain}`);
    return 'done';
  }

  const shopifyClient = await ShopifyAPIClient.forShop(shop.shopDomain);

  // La data di nascita NON si chiede, ed e' una scelta e non una dimenticanza:
  // questo webhook non l'ha mai scritta, e chiederla adesso vorrebbe dire far
  // scrivere una colonna in piu' a una strada che nessuno ha rivisto per
  // quello. Senza il campo, il transformer non nomina la colonna e chi ce
  // l'aveva scritta se la tiene. La riempie la corsa periodica, che quella
  // strada la conosce.
  const customer = (await shopifyClient.getCustomerById(trigger.customerId, {
    birthdateMetafield: null,
  })) as ShopifyCustomer | null;

  if (!customer) {
    console.warn(
      `Cliente ${trigger.customerId} non leggibile su ${event.shopDomain}: nessuna scrittura`,
    );
    return 'done';
  }

  const supabase = createSupabaseClient(shop.supabaseConfig);
  const table = shop.supabaseConfig.tableNameCustomers;

  // Consenziente: riga completa. Non consenziente: nessuna insert, e la riga
  // che gia' c'era viene svuotata di cio' che identifica la persona — resta
  // con il consenso a false, che e' cio' su cui il proxy decide il 403.
  // No-op su un cliente mai sincronizzato: una update non crea righe.
  const { error } = isCustomerOptedIn(customer)
    ? await supabase.from(table).upsert(transformCustomer(customer), {
        onConflict: 'shopify_customer_id',
        ignoreDuplicates: false,
      })
    : await withdrawConsentFor(supabase, table, [customer.id]);

  if (error) {
    console.error('Supabase customer upsert error:', error);
    await registraFallimento(shop.id, { message: error.message, code: error.code });
    // Il database del merchant non ha accettato la scrittura: quasi sempre e'
    // passeggero, e l'evento resta da lavorare. Il ritentativo e' un upsert
    // sulla stessa chiave, quindi non fa danni.
    return 'retry';
  }

  await prisma.syncJob.create({
    data: {
      shopId: shop.id,
      jobType: 'webhook',
      status: 'completed',
      customersSynced: 1,
      completedAt: now,
    },
  });

  return 'done';
}

/** Cliente cancellato su Shopify: dell'identificativo non resta altro. */
export async function handleCustomerDelete(
  event: ClaimedWebhookEvent,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  const trigger = readCustomerTrigger(event.payload);
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
  if (!can(await shopCapabilities(shop), 'sync_customers')) return 'done';

  const supabase = createSupabaseClient(shop.supabaseConfig);

  const { error } = await supabase
    .from(shop.supabaseConfig.tableNameCustomers)
    .delete()
    .eq('shopify_customer_id', String(trigger.customerId));

  if (error) {
    console.error('Supabase customer delete error:', error);
    await registraFallimento(shop.id, { message: error.message, code: error.code });
    // Una cancellazione non riuscita e' il fallimento che meno di tutti si puo'
    // dichiarare riuscito: resterebbero nel database del merchant i dati di una
    // persona che Shopify considera cancellata. Cancellare due volte lo stesso
    // cliente non fa danni.
    return 'retry';
  }

  await prisma.syncJob.create({
    data: {
      shopId: shop.id,
      jobType: 'webhook',
      status: 'completed',
      customersSynced: 0,
      completedAt: now,
    },
  });

  return 'done';
}

/** Vedi `handle-product`: la traccia non deve poter far cadere l'esito. */
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
        customersSynced: 0,
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
