import { prisma } from '../../db.server';
import { nextSyncAt } from './next-sync';

/**
 * Quando e' avvenuta l'ultima sincronizzazione e quando avverra' la prossima.
 *
 * Le due date non hanno la stessa origine, e non e' una svista:
 *
 * - **l'ultima** e' la corsa completata piu' recente fra quelle che aggiornano
 *   davvero i dati, quindi anche la sincronizzazione completa iniziale. Dire
 *   "Mai" a un merchant che ha appena visto scriversi il catalogo sarebbe falso;
 * - **la prossima** si calcola invece dalla sola corsa periodica, perche' e' su
 *   quella che si regola il giro programmato. Prendere come riferimento la corsa
 *   iniziale sposterebbe la previsione di ore.
 */
export interface SyncTiming {
  lastSync: string | null;
  nextSync: string | null;
}

/** Le due date grezze, come stanno sul database. */
export interface SyncRuns {
  lastRunAt: Date | null;
  lastPeriodicAt: Date | null;
}

/** I tipi di corsa che il merchant riconosce come "sincronizzazione". */
const SYNC_JOB_TYPES = ['periodic_check', 'initial_bulk'];

/**
 * Gli stati che contano come "e' avvenuta".
 *
 * `completed_with_repairs` c'e' dentro, e la ragione e' che qui si risponde a
 * "quando i tuoi dati si sono allineati l'ultima volta": una corsa che ha
 * scritto quasi tutto si e' allineata, e dire "Mai" a chi ha appena visto
 * riempirsi le sue tabelle sarebbe falso. Che sia rimasto qualcosa da rimettere
 * a posto si legge dove si legge lo stato, non da questa data.
 */
const DONE_STATUSES = ['completed', 'completed_with_repairs'];

/**
 * La lettura, da sola. Separata dal calcolo perche' non dipende dal piano: la
 * dashboard puo' cosi' avviarla insieme a tutte le altre, senza pagare un
 * round-trip in piu' solo per aspettare di sapere la cadenza.
 */
export async function loadSyncRuns(shopId: string): Promise<SyncRuns> {
  const [lastRun, lastPeriodic] = await Promise.all([
    prisma.syncJob.findFirst({
      where: { shopId, jobType: { in: SYNC_JOB_TYPES }, status: { in: DONE_STATUSES } },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true },
    }),
    prisma.syncJob.findFirst({
      where: { shopId, jobType: 'periodic_check', status: { in: DONE_STATUSES } },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true },
    }),
  ]);

  return {
    lastRunAt: lastRun?.completedAt ?? null,
    lastPeriodicAt: lastPeriodic?.completedAt ?? null,
  };
}

/** Il calcolo, senza database: date pronte da mandare al browser. */
export function syncTimingFrom(
  runs: SyncRuns,
  frequencyHours: number | null,
  now: Date = new Date(),
): SyncTiming {
  return {
    lastSync: runs.lastRunAt?.toISOString() ?? null,
    nextSync: nextSyncAt(runs.lastPeriodicAt, frequencyHours, now)?.toISOString() ?? null,
  };
}

export async function loadSyncTiming(
  shopId: string,
  frequencyHours: number | null,
  now: Date = new Date(),
): Promise<SyncTiming> {
  return syncTimingFrom(await loadSyncRuns(shopId), frequencyHours, now);
}
