import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { loadShopAverages, loadShopProfit } from '~/lib/customers/profit.server';
import { currentMonthRange, isCalendarDate } from '~/lib/customers/customers-query';
import { comparisonRange, type ComparisonId } from '~/lib/dates/ranges';

const COMPARISONS: ComparisonId[] = [
  'none',
  'previousPeriod',
  'previousYear',
  'previousYearWeekday',
];

/**
 * Il profitto del mese, per la dashboard.
 *
 * Rotta a se' e non dentro il loader della pagina: sono due interrogazioni al
 * database del merchant, e farle prima di mostrare qualsiasi cosa ritarderebbe
 * l'intera dashboard per un numero che puo' arrivare un istante dopo.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  // Le date arrivano dalla URL, quindi da fuori: quello che non e' una data si
  // ignora e si torna al mese in corso, invece di far fallire la card.
  const params = new URL(request.url).searchParams;
  const month = currentMonthRange();
  const from = params.get('from');
  const to = params.get('to');
  const range = {
    from: from && isCalendarDate(from) ? from : month.from,
    to: to && isCalendarDate(to) ? to : month.to,
  };

  const asked = params.get('compare') ?? 'none';
  const comparison = (COMPARISONS as string[]).includes(asked)
    ? (asked as ComparisonId)
    : 'none';

  try {
    // Le due domande viaggiano insieme perche' le fa la stessa pagina nello
    // stesso istante: due rotte avrebbero voluto dire due autenticazioni e due
    // risvegli del database per riempire la stessa riga di schermo.
    const [profit, averages] = await Promise.all([
      loadShopProfit(session.shop, {
        range,
        compare: comparisonRange(range, comparison),
      }),
      loadShopAverages(session.shop, range),
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
