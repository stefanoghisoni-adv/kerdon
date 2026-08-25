import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { loadTopProducts } from '~/lib/customers/top-products.server';
import { isMetric } from '~/lib/customers/top-products';
import { currentMonthRange, isCalendarDate } from '~/lib/customers/customers-query';

/**
 * I cinque prodotti che hanno reso di piu', per la dashboard.
 *
 * Rotta a se' come il profitto: e' un'interrogazione al database del merchant,
 * e la dashboard non deve aspettarla per mostrare tutto il resto. Cambiando
 * metrica si torna qui invece di rifare la pagina — sono cinque righe.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;

  const raw = params.get('metric') ?? 'cm';
  const metric = isMetric(raw) ? raw : 'cm';

  // Le date arrivano dalla URL, quindi da fuori: quello che non e' una data si
  // ignora e si torna al mese in corso.
  const month = currentMonthRange();
  const from = params.get('from');
  const to = params.get('to');
  const range = {
    from: from && isCalendarDate(from) ? from : month.from,
    to: to && isCalendarDate(to) ? to : month.to,
  };

  try {
    return json(await loadTopProducts(session.shop, { ...range, metric, limit: 5 }));
  } catch (e) {
    console.error('[api.stats.top-products]', e instanceof Error ? e.message : 'errore');
    // Come per il profitto: un guasto qui non spegne la dashboard.
    return json({ rows: [], currency: 'EUR', unavailable: 'not_connected' as const });
  }
}
