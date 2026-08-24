import { prisma } from '~/db.server';
import { resolveSyncState } from '~/components/Dashboard/sync-state';
import {
  allStepsComplete,
  resolveStepStates,
  type StepInput,
} from '~/components/Dashboard/stepper-state';

/**
 * A che punto e' la configurazione di un negozio, letto dal database.
 *
 * La dashboard lo sa gia' per conto suo, ma non e' l'unica a doverlo sapere: il
 * menu di navigazione cambia forma finche' la configurazione e' aperta, e le
 * altre pagine non devono essere raggiungibili. Se ognuno se lo ricalcolasse a
 * modo suo, prima o poi due parti dell'app direbbero cose diverse sullo stesso
 * negozio.
 *
 * Tutto quello che serve sta sul database: nessuna chiamata a Shopify, perche'
 * questo viene letto a ogni apertura di ogni pagina.
 */
export async function loadSetupInput(shopDomain: string): Promise<StepInput | null> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    include: { supabaseConfig: true, supabaseOAuthToken: true },
  });
  if (!shop) return null;

  const connectedAt = shop.supabaseConfig?.connectionVerifiedAt ?? null;

  // Le corse recenti servono solo a sapere se la prima sincronizzazione di
  // QUESTO collegamento e' arrivata in fondo.
  const recentJobs = await prisma.syncJob.findMany({
    where: { shopId: shop.id },
    orderBy: { startedAt: 'desc' },
    take: 10,
    select: { jobType: true, status: true, startedAt: true },
  });

  // Vale per il collegamento di adesso, non per uno precedente: e' la stessa
  // regola che governa i passi nella dashboard.
  const forThisConnection = (moment: Date | null) =>
    moment != null && connectedAt != null && moment >= connectedAt;

  return {
    accountConnected: shop.supabaseOAuthToken !== null,
    databaseConnected: connectedAt != null,
    trackingChecked: forThisConnection(shop.trackingCheckedAt),
    planConfirmed:
      forThisConnection(shop.planConfirmedAt) &&
      resolveSyncState(recentJobs, connectedAt) === 'completed',
  };
}

/**
 * La configurazione non ha piu' niente da chiedere.
 *
 * Si attraversa una volta sola: appena arriva in fondo la si registra, e da
 * quel momento la risposta viene da li'. Ricalcolarla ogni volta dai dati
 * significava rimandare il merchant a rifare i passi ogni volta che cambiava
 * database — perche' il piano risultava confermato per il collegamento di
 * prima. Si torna al punto di partenza solo scollegando l'account, che e'
 * l'unico gesto che disfa davvero tutto.
 *
 * Un negozio che non risulta ancora sul database e' all'inizio di tutto,
 * quindi non e' concluso: e' il primo istante dell'installazione.
 */
export async function isSetupComplete(shopDomain: string): Promise<boolean> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true, setupCompletedAt: true },
  });
  if (!shop) return false;
  if (shop.setupCompletedAt != null) return true;

  const input = await loadSetupInput(shopDomain);
  const complete = input != null && allStepsComplete(resolveStepStates(input));

  // Prima volta che arriva in fondo: si segna, e non si ripassa piu' di qui.
  // Best effort — se la scrittura fallisce la risposta resta giusta, si
  // riproverà alla prossima apertura.
  if (complete) {
    prisma.shop
      .update({ where: { id: shop.id }, data: { setupCompletedAt: new Date() } })
      .catch(() => {});
  }

  return complete;
}
