import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { loadShopAverages, loadShopProfit } from '~/lib/customers/profit.server';

/**
 * Il profitto del mese, per la dashboard.
 *
 * Rotta a se' e non dentro il loader della pagina: sono due interrogazioni al
 * database del merchant, e farle prima di mostrare qualsiasi cosa ritarderebbe
 * l'intera dashboard per un numero che puo' arrivare un istante dopo.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  try {
    // Le due domande viaggiano insieme perche' le fa la stessa pagina nello
    // stesso istante: due rotte avrebbero voluto dire due autenticazioni e due
    // risvegli del database per riempire la stessa riga di schermo.
    const [profit, averages] = await Promise.all([
      loadShopProfit(session.shop),
      loadShopAverages(session.shop),
    ]);
    return json({ ...profit, averages });
  } catch (e) {
    console.error(
      '[api.stats.profit]',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    // Un guasto qui non deve spegnere la dashboard: si dice che il numero non
    // c'e', e le card sotto continuano a fare il loro lavoro.
    return json({
      profit: null,
      orders: 0,
      change: null,
      coveredLines: 0,
      totalLines: 0,
      currency: 'EUR',
      unavailable: 'not_connected' as const,
      averages: {
        aov: null,
        aop: null,
        ltv: null,
        ltp: null,
        currency: 'EUR',
        unavailable: 'not_connected' as const,
      },
    });
  }
}
