import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { prisma } from '~/db.server';
import { getSyncQueue } from '~/lib/queue/queues.server';
import {
  processPeriodicSyncCheck,
  processInitialBulkSync,
  processManualSync,
} from '~/lib/workers/processors.server';
import { recordEligibilitySnapshotIfMissing } from '~/lib/stats/eligibility-snapshot.server';
import { hasPlanChanged } from '~/components/Dashboard/plan-upgrade';
import { isAuthorized } from '~/utils/authorization.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { SYNC_ACTIVE_CONFIG_FILTER } from '~/lib/sync/sync-active';
import { pruneAccessLog } from '~/lib/read-proxy/access-log.server';

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
    periodicChecks: 0,
    planCatchUps: 0,
    snapshots: 0,
    accessLogPruned: 0,
    errors: [] as string[],
  };

  // Potatura del registro accessi. Prima di tutto il resto e fuori dai cicli:
  // e' una sola query, non dipende da nessun negozio, e messa qui gira anche
  // quando la parte di sync si interrompe a meta'.
  if (!onlyShopId) results.accessLogPruned = await pruneAccessLog();

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
      if (job.data.type === 'manual-sync') {
        await processManualSync(job.data.shopId, job);
      } else if (job.data.type === 'initial-bulk-sync') {
        await processInitialBulkSync(job.data.shopId, job);
      } else if (job.data.type === 'periodic-sync-check') {
        await processPeriodicSyncCheck(job.data.shopId);
      } else {
        // Unknown/deferred job type (e.g. retry-failed-webhook): skip, leave queued
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

    try {
      const plan = await findPlanByName(shop.currentPlan);
      if (!plan) continue;

      // Il piano e' cambiato dopo l'ultima sync completa: allineamento automatico
      // subito, senza aspettare la cadenza del piano e senza che il merchant
      // debba avviare nulla a mano. E' la corsa completa, non il delta, perche'
      // c'e' da recuperare cio' che il piano precedente non copriva (prodotti
      // oltre il vecchio tetto e, se ora inclusa, l'intera tabella clienti).
      // Al termine il bulk riallinea lastSyncedPlan, quindi non si ripete.
      // isAuthorized: senza questo controllo un negozio sospeso finirebbe qui a
      // ogni giro solo per far lanciare il processor e riempire di errori il log.
      if (isAuthorized(shop.authorization) && hasPlanChanged(shop.currentPlan, shop.lastSyncedPlan)) {
        await processInitialBulkSync(shop.id);
        results.planCatchUps++;
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
      if (!due && plan.customersSyncEnabled && isAuthorized(shop.authorization)) {
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
        await processPeriodicSyncCheck(shop.id);
        results.periodicChecks++;
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
