import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { transformCustomer } from '~/lib/transformers/customer.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import { isCustomerOptedIn } from '~/lib/stats/customer-consent-stats';
import type { ShopifyCustomer } from '~/types/shopify';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';

export async function action({ request }: ActionFunctionArgs) {
  // Verify HMAC signature
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
    let customer: ShopifyCustomer;
    try {
      customer = JSON.parse(body);
    } catch {
      // Un corpo illeggibile e' un guasto DEFINITIVO, non passeggero: lo stesso
      // JSON malformato non diventera' valido riprovandolo. Rispondere 500
      // qui farebbe insistere Shopify per due giorni e poi spegnere la
      // sottoscrizione, per un evento che comunque non si potrebbe usare.
      // Quindi 200, ed e' l'unica eccezione alla regola qui sotto.
      return json({ ok: true }, { status: 200 });
    }

    if (!customer.id) {
      console.warn('Invalid customer payload: missing id');
      return json({ ok: true }, { status: 200 });
    }

    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      include: { supabaseConfig: true },
    });

    if (!shop || !shop.supabaseConfig) {
      console.log(`Shop ${shopDomain} not configured for sync`);
      return json({ ok: true }, { status: 200 });
    }

    // Il collegamento e il piano si guardavano gia', una condizione per volta;
    // l'autorizzazione no, e nemmeno la disinstallazione. Erano proprio quelle
    // due a mancare ovunque, ed erano le uniche che il merchant non poteva
    // cambiare da se': un negozio sospeso continuava a farsi scrivere i clienti
    // dentro, senza nessun gesto suo, perche' le notifiche arrivano da sole.
    // Ora la domanda e' una: questo negozio puo' sincronizzare i clienti?
    if (!can(await shopCapabilities(shop), 'sync_customers')) {
      console.log(`Customer sync not enabled for shop ${shopDomain}`);
      return json({ ok: true }, { status: 200 });
    }

    const supabase = createSupabaseClient(shop.supabaseConfig);
    const table = shop.supabaseConfig.tableNameCustomers;

    // Consenziente: riga completa. Non consenziente: nessuna insert, solo la
    // marcatura della colonna su cui il proxy decide il 403 (no-op se il cliente
    // non era mai stato sincronizzato).
    const { error } = isCustomerOptedIn(customer)
      ? await supabase.from(table).upsert(transformCustomer(customer), {
          onConflict: 'shopify_customer_id',
          ignoreDuplicates: false,
        })
      : await supabase
          .from(table)
          .update({ accepts_marketing: false })
          .eq('shopify_customer_id', customer.id);

    if (error) {
      console.error('Supabase customer upsert error:', error);
      await prisma.syncJob.create({
        data: {
          shopId: shop.id,
          jobType: 'webhook',
          status: 'failed',
          customersSynced: 0,
          errors: { message: error.message, code: error.code },
        },
      });
      return json({ ok: true }, { status: 200 });
    }

    await prisma.syncJob.create({
      data: {
        shopId: shop.id,
        jobType: 'webhook',
        status: 'completed',
        customersSynced: 1,
        completedAt: new Date(),
      },
    });

    return json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error('Customer webhook processing error:', error);

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
            customersSynced: 0,
            errors: { message: String(error) },
          },
        });
      }
    } catch {
      // Silent fail on logging
    }

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
