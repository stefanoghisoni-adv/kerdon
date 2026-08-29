import type { LoaderFunctionArgs } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';

/**
 * L'esportazione, consegnata a chi ha diritto di riceverla.
 *
 * Tre condizioni, e nessuna e' di troppo:
 *
 *  - la sessione dev'essere quella di un amministratore del negozio. E' il
 *    motivo per cui l'esportazione non ha nessun indirizzo pubblico, nemmeno
 *    lungo e casuale: un indirizzo indovinabile o inoltrato per sbaglio
 *    diventa una copia dei dati di una persona che gira senza controllo;
 *  - la richiesta dev'essere di QUEL negozio. Senza questo controllo, l'id di
 *    una richiesta bastera' a un negozio per leggere l'esportazione di un
 *    altro;
 *  - la copia dev'essere ancora dentro la sua finestra. Scaduta, non si
 *    consegna, e non conta che la riga sia ancora li' — il cron la svuota al
 *    giro successivo, e nel frattempo la scadenza vale gia'.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const record = await prisma.complianceRequest.findFirst({
    where: {
      id: params.id,
      shopDomain: session.shop,
      topic: 'customers/data_request',
      status: 'completed',
    },
    select: { export: true, exportExpiresAt: true, customerRef: true },
  });

  if (!record?.export || !record.exportExpiresAt || record.exportExpiresAt.getTime() < Date.now()) {
    throw new Response('Not found', { status: 404 });
  }

  const name = `coreward-data-request-${record.customerRef?.slice(0, 8) ?? 'export'}.json`;

  return new Response(JSON.stringify(record.export, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      // Una copia dei dati di una persona non deve restare in nessuna cache
      // fra qui e il browser di chi la scarica.
      'Cache-Control': 'no-store, private',
    },
  });
}
