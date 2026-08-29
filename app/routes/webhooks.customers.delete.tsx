import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { prisma } from '~/db.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';

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
    const { id: customerId } = payload;

    if (!customerId) {
      console.warn('Customer delete webhook: missing customer id');
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
    if (!can(await shopCapabilities(shop), 'sync_customers')) {
      return json({ ok: true }, { status: 200 });
    }

    const supabase = createSupabaseClient(shop.supabaseConfig);

    const { error } = await supabase
      .from(shop.supabaseConfig.tableNameCustomers)
      .delete()
      .eq('shopify_customer_id', String(customerId));

    if (error) {
      console.error('Supabase customer delete error:', error);
      await prisma.syncJob.create({
        data: {
          shopId: shop.id,
          jobType: 'webhook',
          status: 'failed',
          customersSynced: 0,
          errors: { message: error.message, code: error.code },
        },
      });
    } else {
      await prisma.syncJob.create({
        data: {
          shopId: shop.id,
          jobType: 'webhook',
          status: 'completed',
          customersSynced: 0,
          completedAt: new Date(),
        },
      });
    }

    return json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error('Customer delete webhook error:', error);

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
            customersSynced: 0,
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
