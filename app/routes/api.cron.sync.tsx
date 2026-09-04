import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { prisma } from '~/db.server';
import { getSyncQueue } from '~/lib/queue/queues.server';
import {
  processPeriodicSyncCheck,
  processInitialBulkSync,
  processManualSync,
} from '~/lib/workers/processors.server';
import { withShopSyncLock } from '~/lib/queue/shop-lock.server';
import { recordEligibilitySnapshotIfMissing } from '~/lib/stats/eligibility-snapshot.server';
import { hasPlanChanged } from '~/components/Dashboard/plan-upgrade';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilitiesWithPlan } from '~/lib/authz/shop-capabilities.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { SYNC_ACTIVE_CONFIG_FILTER } from '~/lib/sync/sync-active';
import { pruneAccessLog } from '~/lib/read-proxy/access-log.server';
import { drainPendingCancellations } from '~/lib/billing/cancel-outbox.server';
import { unauthenticated } from '~/shopify.server';
import { pruneAnonymousUsers } from '~/lib/tracking/users.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import {
  drainComplianceRequests,
  processComplianceRequest,
  pruneExpiredExports,
} from '~/lib/gdpr/process-compliance.server';

/**
 * Cron-triggered sync endpoint (replaces the long-running BullMQ worker on the
 * zero-cost stack: Vercel Free has no long-running processes).
 *
 * Invoked in GET with `Authorization: Bearer CRON_SECRET` by:
 * - Vercel Cron (daily safety run, vercel.json)
 * - GitHub Actions (every 30 min, .github/workflows/sync-cron.yml)
 *
 * On each run it (1) drains jobs the UI enqueued into BullMQ (manual /
 * initial-bulk / periodic) and (2) runs periodic checks for shops whose plan
 * interval has elapsed. A single failing shop/job never aborts the whole run.
 */
// Distanza minima fra due tentativi di provvedere la tabella clienti quando il
// piano la include ma non risulta ancora creata.
const CUSTOMERS_RETRY_MS = 3_600_000;

export async function loader({ request }: LoaderFunctionArgs) {
  const authHeader = request.headers.get('Authorization');
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // La corsia veloce: un negozio indicato vuol dire "drena la sua coda e
  // basta". Ci si arriva da un gesto manuale — il pulsante di sincronizzazione,
  // o il recupero dopo un cambio di piano — e in quel momento la potatura del
  // registro e il giro su tutti i negozi sono lavoro che qualcuno sta
  // aspettando senza averlo chiesto. Restano dovuti, e li fa il giro completo,
  // che parte comunque dal cron.
  const onlyShopId = new URL(request.url).searchParams.get('shopId');

  const results = {
    drained: 0,
    /** Job lasciati in coda perche' quel negozio era gia' in lavorazione. */
    skippedLocked: 0,
    periodicChecks: 0,
    planCatchUps: 0,
    snapshots: 0,
    accessLogPruned: 0,
    anonymousUsersPruned: 0,
    complianceProcessed: 0,
    complianceFailed: 0,
    /** Abbonamenti sostituiti che si e' finalmente riusciti a chiudere. */
    subscriptionsCancelled: 0,
    expiredExportsPruned: 0,
    errors: [] as string[],
  };

  // Potatura del registro accessi. Prima di tutto il resto e fuori dai cicli:
  // e' una sola query, non dipende da nessun negozio, e messa qui gira anche
  // quando la parte di sync si interrompe a meta'.
  if (!onlyShopId) results.accessLogPruned = await pruneAccessLog();

  // Le richieste di conformita' rimaste indietro, e le esportazioni scadute.
  // Fuori dal ciclo dei negozi e prima di tutto il resto: qui sotto ci sono i
  // termini di legge di una persona vera, e non devono dipendere da quanto e'
  // lungo il giro delle sincronizzazioni ne' da come e' andato. Il drenaggio
  // non guarda la coda: legge le righe, ed e' questo a rendere durevole la
  // presa in carico anche quando Redis era giu' nel momento del webhook.
  if (!onlyShopId) {
    try {
      const compliance = await drainComplianceRequests();
      results.complianceProcessed = compliance.processed;
      results.complianceFailed = compliance.failed;
      results.expiredExportsPruned = await pruneExpiredExports();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Cron compliance drain error:', message);
      results.errors.push(`compliance: ${message}`);
    }
  }

  // Gli abbonamenti sostituiti che la callback non e' riuscita a chiudere.
  //
  // La chiusura vive nella callback, ma proprio quando fallisce li' non si
  // conclude niente: qui si riprende quel che era rimasto segnato. Di norma non
  // trova niente e costa una query; quando trova qualcosa, e' un merchant che
  // altrimenti pagherebbe due abbonamenti.
  if (!onlyShopId) {
    try {
      results.subscriptionsCancelled = await drainPendingCancellations(
        async (shopDomain) => (await unauthenticated.admin(shopDomain)).admin,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Cron billing outbox error:', message);
      results.errors.push(`billing outbox: ${message}`);
    }
  }

  // 1. Drain jobs enqueued from the UI (manual-sync, initial-bulk-sync, periodic-sync-check)
  const syncQueue = await getSyncQueue();
  const queued = await syncQueue.getJobs(['waiting', 'delayed'], 0, 20);
  // In corsia veloce si guardano solo i job di quel negozio: gli altri li
  // prende il giro completo, e intanto chi aspetta non paga il loro tempo.
  const pendingJobs = onlyShopId
    ? queued.filter((job) => job.data?.shopId === onlyShopId)
    : queued;

  for (const job of pendingJobs) {
    try {
      // Un negozio per volta. Questo non e' un Worker di BullMQ — legge i job in
      // attesa e chiama i processor direttamente, senza prendere possesso di
      // niente — quindi due invocazioni possono trovarsi davanti lo stesso
      // lavoro. Da quando un gesto manuale innesca un drain immediato, e' un
      // caso concreto e non piu' teorico.
      //
      // Il danno non sarebbe un doppione innocuo: la corsa completa finisce
      // spazzando le righe con `synced_at` anteriore al proprio inizio, e due
      // corse sovrapposte hanno due inizi diversi — la piu' vecchia porta via
      // quello che la piu' recente ha appena scritto.
      //
      // Se il lucchetto e' occupato il job NON si rimuove: ci sta gia'
      // lavorando qualcun altro, e toglierlo di mezzo qui vorrebbe dire
      // cancellare il lavoro di un altro dalla coda.
      let handled = true;
      if (job.data.type === 'manual-sync') {
        handled = await withShopSyncLock(job.data.shopId, () =>
          processManualSync(job.data.shopId, job),
        );
      } else if (job.data.type === 'initial-bulk-sync') {
        handled = await withShopSyncLock(job.data.shopId, () =>
          processInitialBulkSync(job.data.shopId, job),
        );
      } else if (job.data.type === 'periodic-sync-check') {
        handled = await withShopSyncLock(job.data.shopId, () =>
          processPeriodicSyncCheck(job.data.shopId),
        );
      } else if (job.data.type === 'compliance-request') {
        // Senza lucchetto di negozio: il lucchetto se lo prende, dove serve,
        // process-compliance stesso — e shop/redact non ha nemmeno un negozio
        // a cui legarlo, visto che sta per toglierlo.
        await processComplianceRequest(job.data.requestId);
        handled = true;
      } else {
        // Unknown/deferred job type (e.g. retry-failed-webhook): skip, leave queued
        continue;
      }
      if (!handled) {
        results.skippedLocked++;
        continue;
      }
      await job.remove();
      results.drained++;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Cron drain error for job ${job.id}:`, error);
      results.errors.push(`job ${job.id}: ${message}`);
      // The processor already recorded a 'failed' SyncJob; drop the job and move on
      await job.remove();
    }
  }

  // 2. Periodic check for shops whose plan interval has elapsed
  //
  // Salta del tutto in corsia veloce: e' la parte che costa, ed e' anche quella
  // che con il gesto appena compiuto non c'entra niente.
  if (onlyShopId) return json({ ok: true, ...results });

  const shops = await prisma.shop.findMany({
    where: {
      uninstalledAt: null,
      supabaseConfig: SYNC_ACTIVE_CONFIG_FILTER,
    },
    include: { supabaseConfig: true },
  });

  for (const shop of shops) {
    // Snapshot giornaliero per il grafico: in un try/catch separato perche' una
    // sua rottura non deve impedire la sync vera e propria del negozio.
    try {
      const result = await recordEligibilitySnapshotIfMissing(shop);
      if (result === 'written') results.snapshots++;
    } catch (error) {
      console.error(`Snapshot idoneita' fallito per ${shop.shopDomain}:`, error);
    }

    // Potatura dei browser mai identificati e fermi da oltre un anno. Vive nel
    // giro del cron perche' e' un lavoro che non ha un momento suo: nessuno
    // aspetta il suo esito, e farla altrove vorrebbe dire farla pagare a
    // qualcuno che sta aspettando un'altra cosa.
    //
    // Il filtro tiene fuori le righe legate a un cliente, qualunque sia la loro
    // eta': quelle sono l'elenco dei dispositivi di una persona che dal negozio
    // ci e' passata davvero, ed e' esattamente cio' per cui la tabella esiste.
    // Le altre non diventeranno mai utili — vedi `pruneAnonymousUsers`.
    //
    // In un try/catch suo, come lo snapshot: un progetto che non risponde non
    // deve impedire la sincronizzazione di quel negozio.
    try {
      if (shop.supabaseConfig) {
        results.anonymousUsersPruned += await pruneAnonymousUsers(
          createSupabaseClient(shop.supabaseConfig),
        );
      }
    } catch (error) {
      console.error(`Potatura dei visitatori anonimi fallita per ${shop.shopDomain}:`, error);
    }

    try {
      const plan = await findPlanByName(shop.currentPlan);
      if (!plan) continue;

      // Le stesse capacita' che i processor useranno fra un istante, decise qui
      // una volta sola. Chiederle prima serve a non svegliare un processor solo
      // perche' rifiuti: la query di sopra tiene gia' fuori i disinstallati e
      // gli scollegati, ma non i sospesi.
      const caps = shopCapabilitiesWithPlan(shop, plan);

      // Il piano e' cambiato dopo l'ultima sync completa: allineamento automatico
      // subito, senza aspettare la cadenza del piano e senza che il merchant
      // debba avviare nulla a mano. E' la corsa completa, non il delta, perche'
      // c'e' da recuperare cio' che il piano precedente non copriva (prodotti
      // oltre il vecchio tetto e, se ora inclusa, l'intera tabella clienti).
      // Al termine il bulk riallinea lastSyncedPlan, quindi non si ripete.
      // La capacita' prima del recupero: senza questo controllo un negozio
      // sospeso finirebbe qui a ogni giro solo per far lanciare il processor e
      // riempire di errori il log.
      if (can(caps, 'sync_products') && hasPlanChanged(shop.currentPlan, shop.lastSyncedPlan)) {
        // Stesso lucchetto del drain: questo giro passa su TUTTI i negozi, e
        // puo' incrociare una corsa avviata un istante prima dalla corsia
        // veloce di un gesto manuale.
        if (await withShopSyncLock(shop.id, () => processInitialBulkSync(shop.id))) {
          results.planCatchUps++;
        } else {
          results.skippedLocked++;
        }
        continue;
      }

      const lastCheck = await prisma.syncJob.findFirst({
        where: { shopId: shop.id, jobType: 'periodic_check', status: 'completed' },
        orderBy: { completedAt: 'desc' },
      });

      const intervalMs = plan.maxSyncFrequencyHours * 3600 * 1000;
      let due =
        !lastCheck?.completedAt ||
        Date.now() - lastCheck.completedAt.getTime() >= intervalMs;

      // Piano con clienti inclusi ma tabella clienti mai provveduta: non si
      // aspetta la cadenza del piano (che sul piano base e' di giorni), si
      // riprova alla prima occasione utile. Il nuovo tentativo e' distanziato di
      // almeno un'ora, cosi' un progetto che continua a rifiutare la creazione
      // non si tira dietro una sync completa a ogni giro del cron.
      if (!due && can(caps, 'sync_customers')) {
        const elapsed = Date.now() - (lastCheck?.completedAt?.getTime() ?? 0);
        if (elapsed >= CUSTOMERS_RETRY_MS) {
          const provisioned = await prisma.syncJob.findFirst({
            where: {
              shopId: shop.id,
              OR: [
                { jobType: { in: ['table_create_customers', 'table_create_both'] } },
                { customersSynced: { gt: 0 } },
              ],
            },
            select: { id: true },
          });
          due = provisioned === null;
        }
      }

      if (due) {
        if (await withShopSyncLock(shop.id, () => processPeriodicSyncCheck(shop.id))) {
          results.periodicChecks++;
        } else {
          results.skippedLocked++;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Cron periodic check error for shop ${shop.shopDomain}:`, error);
      results.errors.push(`shop ${shop.shopDomain}: ${message}`);
      // Continue with the next shop: the processor already recorded a 'failed' SyncJob
    }
  }

  return json({ ok: true, ...results });
}
