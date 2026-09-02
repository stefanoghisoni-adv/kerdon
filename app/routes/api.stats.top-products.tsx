import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
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
/**
 * Il mese in corso per il negozio, letto solo se serve davvero.
 *
 * Serve quando la URL non porta date valide, che e' il caso raro: la dashboard
 * le manda sempre. Il fuso pero' sta sul database, e pagarlo a ogni chiamata
 * per un ripiego che quasi mai si usa sarebbe una lettura in piu' su ogni
 * aggiornamento della pagina. Quindi si legge solo quando quel ripiego scatta.
 */
async function shopMonth(shopDomain: string): Promise<{ from: string; to: string }> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { ianaTimezone: true },
  });
  return currentMonthRange(new Date(), shop?.ianaTimezone ?? null);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;

  const raw = params.get('metric') ?? 'cm';
  const metric = isMetric(raw) ? raw : 'cm';

  // Le date arrivano dalla URL, quindi da fuori: quello che non e' una data si
  // ignora e si torna al mese in corso.
  const from = params.get('from');
  const to = params.get('to');
  const fromAsked = from && isCalendarDate(from) ? from : null;
  const toAsked = to && isCalendarDate(to) ? to : null;
  // Il mese in corso serve solo a tappare i buchi: quando le date ci sono
  // entrambe non si legge niente dal database.
  const fallback =
    fromAsked && toAsked
      ? { from: fromAsked, to: toAsked }
      : await shopMonth(session.shop);
  const range = { from: fromAsked ?? fallback.from, to: toAsked ?? fallback.to };

  try {
    return json(await loadTopProducts(session.shop, { ...range, metric, limit: 5 }));
  } catch (e) {
    console.error('[api.stats.top-products]', e instanceof Error ? e.message : 'errore');
    // Come per il profitto: un guasto qui non spegne la dashboard.
    return json({ rows: [], currency: 'EUR', unavailable: 'not_connected' as const });
  }
}
