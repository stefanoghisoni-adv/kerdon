import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { prisma } from '~/db.server';
import { invalidateReadContextForDomain } from '~/lib/read-proxy/context.server';

// Il merchant ha disinstallato l'app.
//
// Cosa NON si tocca, ed e' la parte importante: il collegamento al database e i
// dati gia' sincronizzati restano dove sono. Le tabelle stanno nel progetto del
// merchant, sono sue, e chi disinstalla non sta chiedendo di cancellarle — le
// sta solo smettendo di aggiornare. Reinstallando ritrova tutto al suo posto.
//
// Quello che si ferma e' la sincronizzazione: le code e il cron cercano solo i
// negozi con `uninstalledAt` vuoto, quindi segnare la data e' l'interruttore.
//
// Le sessioni invece si cancellano: alla disinstallazione Shopify revoca il
// token, quindi quelle righe non aprono piu' niente e tenerle sarebbe solo un
// segreto morto in un database.

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
    // updateMany e non update: su un negozio che non abbiamo mai avuto non
    // lancia, si limita a non toccare niente. Il webhook arriva anche per
    // installazioni mai completate.
    await prisma.shop.updateMany({
      where: { shopDomain },
      data: { uninstalledAt: new Date() },
    });

    await prisma.session.deleteMany({ where: { shop: shopDomain } });

    // Il proxy di lettura tiene in cache un "puo' leggere" deciso prima di
    // adesso. Il token resta incollato nel container della vetrina anche dopo
    // la disinstallazione, e finche' quella riga non scade continuerebbe a
    // farsi servire i clienti di un negozio che con noi ha chiuso.
    invalidateReadContextForDomain(shopDomain);
  } catch (e) {
    // 200 comunque: un errore qui farebbe ritentare Shopify a ripetizione, e la
    // prossima installazione rimette a posto lo stato da se' (afterAuth azzera
    // uninstalledAt).
    console.error(
      '[webhooks.app.uninstalled]',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
  }

  return json({ ok: true }, { status: 200 });
}
