import { prisma } from '~/db.server';

/** I soli campi che servono a stabilire lo stato della sincronizzazione. */
export interface LatestBulkJob {
  status: string;
  startedAt: Date;
}

/**
 * L'ultima corsa completa del negozio, comunque lontana nel tempo.
 *
 * Si interroga per tipo invece di pescarla dalle ultime righe di `sync_job`:
 * quelle sono dominate dai controlli periodici, che su un piano a cadenza
 * stretta ne producono a decine, e la corsa completa ci sparisce dentro.
 */
export function latestBulkJob(shopId: string): Promise<LatestBulkJob | null> {
  return prisma.syncJob.findFirst({
    where: { shopId, jobType: 'initial_bulk' },
    orderBy: { startedAt: 'desc' },
    select: { status: true, startedAt: true },
  });
}

/**
 * Quando e' partita l'ultima corsa di QUALUNQUE tipo.
 *
 * E' l'ancora del periodo di calma prima di rinnescare un recupero. Prima si
 * usava la sola corsa completa, e questo apriva il buco da cui passava la
 * tempesta: se la corsa completa non si trovava — perche' non c'era, o perche'
 * era stata spinta fuori dalla finestra letta — il recupero risultava dovuto
 * *sempre*, e la dashboard ne innescava uno a ogni ricarica. Guardando l'ultima
 * riga scritta, qualunque sia, un negozio che ha appena lavorato non viene
 * rimesso al lavoro un secondo dopo.
 */
export async function lastSyncActivityAt(shopId: string): Promise<Date | null> {
  const job = await prisma.syncJob.findFirst({
    where: { shopId },
    orderBy: { startedAt: 'desc' },
    select: { startedAt: true },
  });
  return job?.startedAt ?? null;
}
