import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { isSupabaseCredentialDead } from '~/lib/supabase-management.server';
import { isRinnovoPermessoInCorso } from '~/lib/supabase-oauth.server';
import { noteDatabaseUnreachableForShop } from '~/lib/supabase/database-pause.server';
import { prisma } from '~/db.server';
import { loadShopAverages, loadShopProfit } from '~/lib/customers/profit.server';
import { isCalendarDate } from '~/lib/customers/customers-query';
import { defaultRange } from '~/lib/dates/ranges';
import { comparisonRange, type ComparisonId } from '~/lib/dates/ranges';
import { requireShopCapability } from '~/lib/authz/require-capability.server';

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
/**
 * Il periodo di partenza del negozio, letto solo se serve davvero.
 *
 * Serve quando la URL non porta date valide, che e' il caso raro: la dashboard
 * le manda sempre. Il fuso pero' sta sul database, e pagarlo a ogni chiamata
 * per un ripiego che quasi mai si usa sarebbe una lettura in piu' su ogni
 * aggiornamento della pagina. Quindi si legge solo quando quel ripiego scatta.
 */
async function shopDefaultRange(shopDomain: string): Promise<{ from: string; to: string }> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { ianaTimezone: true },
  });
  return defaultRange(shop?.ianaTimezone ?? null);
}

export async function loader({ request }: LoaderFunctionArgs) {
  // Il profitto si legge dal database del merchant: il permesso viene prima di
  // aprirlo, non dopo. Le date e il confronto si interpretano dopo — leggere
  // una URL non costa niente e non tira fuori nessun dato.
  const { session } = await requireShopCapability(request, 'use_app');

  // Le date arrivano dalla URL, quindi da fuori: quello che non e' una data si
  // ignora e si torna al mese in corso, invece di far fallire la card.
  const params = new URL(request.url).searchParams;
  const from = params.get('from');
  const to = params.get('to');
  const fromAsked = from && isCalendarDate(from) ? from : null;
  const toAsked = to && isCalendarDate(to) ? to : null;
  // Il mese in corso serve solo a tappare i buchi: quando le date ci sono
  // entrambe non si legge niente dal database.
  const fallback =
    fromAsked && toAsked
      ? { from: fromAsked, to: toAsked }
      : await shopDefaultRange(session.shop);
  const range = { from: fromAsked ?? fallback.from, to: toAsked ?? fallback.to };

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
    // Credenziale morta e guasto passeggero si dicono in modo diverso al
    // merchant, perche' sono opposti: il secondo passa da solo, il primo no —
    // finche' non ricollega, quel numero non tornera' mai, e "sara' disponibile
    // dopo la prima sincronizzazione" sarebbe una frase falsa.
    const daRicollegare = isSupabaseCredentialDead(e);
    // Il permesso si sta rinnovando su un'altra richiesta: non e' un guasto ed
    // e' gia' finito quando il merchant ricarica. Se non lo distinguessimo qui
    // finirebbe nel ramo generico, che gli direbbe "dopo la prima
    // sincronizzazione" — una frase falsa per un negozio che sincronizza da
    // mesi.
    const rinnovoInCorso = isRinnovoPermessoInCorso(e);
    console.error(
      '[api.stats.profit]',
      daRicollegare
        ? 'permesso Supabase non piu valido: serve ricollegare'
        : rinnovoInCorso
          ? 'permesso Supabase in rinnovo su un altra richiesta: passeggero'
          : '',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );

    // IL PUNTO IN CUI LA PAUSA DEL DATABASE SI SCOPRE.
    //
    // Qui e non in un loader, e il motivo e' il vincolo: chiedere a Supabase
    // come sta il progetto e' una chiamata di rete verso un terzo, e pagarla a
    // ogni apertura di pagina vorrebbe dire rallentare ogni schermata per una
    // risposta che quasi sempre e' "tutto a posto". Dentro questo `catch`
    // invece la domanda se l'e' gia' posta il fallimento: questa e' la prima
    // lettura del database del merchant che la dashboard fa a ogni apertura, e
    // quando il database e' in pausa e' anche la prima che fallisce.
    //
    // Si aspetta, invece di lasciarla correre da sola: una promessa lasciata
    // in volo su Vercel muore con l'invocazione, e morirebbe proprio nel caso
    // in cui serve. Non puo' far fallire niente (dentro ha il suo `catch`) e
    // non costa niente sul percorso buono, perche' sul percorso buono qui non
    // ci si arriva. Il freno di un minuto e' dentro: la dashboard ricarica le
    // sue card a raffica, e senza quello un database fermo produrrebbe una
    // chiamata a Supabase per ogni giro.
    //
    // Un negozio con la credenziale morta non ci entra: quello e' un altro
    // guasto, con un'altra frase, e interrogare Supabase con un permesso che
    // non vale piu' non direbbe niente di nuovo.
    //
    // E non ci entra nemmeno il rinnovo in corso, per il motivo opposto: li'
    // il database del merchant non e' stato nemmeno interrogato: ci siamo
    // fermati prima, in fila per il permesso. Chiedere a Supabase come sta il
    // progetto vorrebbe dire pagare una chiamata di rete per rispondere a una
    // domanda che nessuno ha fatto — e la pagherebbe con lo stesso permesso
    // che in quel momento non e' disponibile.
    if (!daRicollegare && !rinnovoInCorso) {
      await noteDatabaseUnreachableForShop(session.shop);
    }
    // Un guasto qui non deve spegnere la dashboard: si dice che il numero non
    // c'e', e le card sotto continuano a fare il loro lavoro.
    return json({
      profit: null,
      orders: 0,
      change: null,
      coveredLines: 0,
      totalLines: 0,
      currency: 'EUR',
      unavailable: (daRicollegare
        ? 'reconnect'
        : rinnovoInCorso
          ? 'temporary'
          : 'not_connected') as 'reconnect' | 'temporary' | 'not_connected',
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
