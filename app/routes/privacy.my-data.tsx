import type { LoaderFunctionArgs } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { buildShopExport, shopExportFilename } from '~/lib/privacy/shop-export';

/**
 * La copia dei dati del negozio, consegnata a chi l'ha chiesta.
 *
 * Nessun indirizzo pubblico e nessun identificativo nella URL: si consegna al
 * negozio della sessione e a nessun altro. Un indirizzo indovinabile qui
 * varrebbe la configurazione completa di un negozio — quale database, quali
 * tabelle, quale piano — e non c'e' motivo di farlo esistere quando la
 * sessione dice gia' chi sta chiedendo.
 *
 * Quante righe si portano: le ultime, non tutte. Lo storico di un negozio
 * acceso da anni sono decine di migliaia di sincronizzazioni e di accessi, e un
 * file da cento megabyte non e' piu' una copia leggibile — e' una copia che
 * nessuno apre. I tetti sono generosi e dichiarati dentro al file, cosi' chi
 * legge sa di star guardando una finestra e non l'infinito.
 */
const ULTIME_SINCRONIZZAZIONI = 500;
const ULTIMI_ACCESSI = 1000;
const ULTIME_RICHIESTE = 200;

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: {
      supabaseConfig: true,
      trackingSetup: true,
      billingCharges: { orderBy: { createdAt: 'desc' } },
      syncJobs: { orderBy: { startedAt: 'desc' }, take: ULTIME_SINCRONIZZAZIONI },
      complianceRequests: { orderBy: { receivedAt: 'desc' }, take: ULTIME_RICHIESTE },
      customerDataAccessLogs: { orderBy: { createdAt: 'desc' }, take: ULTIMI_ACCESSI },
    },
  });

  if (!shop) throw new Response('Not found', { status: 404 });

  const generatoIl = new Date();
  const contenuto = buildShopExport(
    {
      shop,
      supabaseConfig: shop.supabaseConfig,
      trackingSetup: shop.trackingSetup,
      billingCharges: shop.billingCharges,
      syncJobs: shop.syncJobs,
      complianceRequests: shop.complianceRequests,
      accessLogs: shop.customerDataAccessLogs,
    },
    generatoIl,
  );

  return new Response(JSON.stringify(contenuto, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${shopExportFilename(session.shop, generatoIl)}"`,
      // Non deve restare in nessuna cache fra qui e il browser: dentro c'e' la
      // configurazione completa del negozio.
      'Cache-Control': 'no-store, private',
    },
  });
}
