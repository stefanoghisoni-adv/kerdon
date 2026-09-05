// app/lib/sync/repair-outbox.server.ts
//
// Dove le riparazioni vivono fra una corsa e l'altra, e come una corsa si
// chiude.
//
// LA REGOLA CHE QUESTO FILE ESISTE PER FAR RISPETTARE. Il confine incrementale
// si scrive nello STESSO commit delle riparazioni. O ci sono tutte e due, o non
// c'e' nessuna delle due. Il caso che questo esclude e' preciso e prima era
// possibile: la corsa scriveva sul database del merchant, poi il processo
// moriva, e il confine restava indietro mentre gli errori ignorati non erano
// scritti da nessuna parte — cioe' l'unico modo di sapere cosa era rimasto
// fuori era leggere i log, se qualcuno li leggeva.
//
// Su un crash a meta' corsa non si perde niente: il confine non e' avanzato, e
// la corsa successiva rilegge la stessa finestra e riscopre gli stessi guasti.
// E' per questo che il registro puo' stare in memoria fino alla chiusura.

import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { redactError } from '~/lib/queue/queue-model';
import {
  MAX_REPAIR_ATTEMPTS,
  nextRepairAttemptAt,
  planRepairCommit,
  type OpenRepair,
  type RepairCommitPlan,
  type RepairLedger,
} from './repair-ledger';
import type { RepairOperation, RepairResourceType } from './failure-taxonomy';
import { runStatusFor, watermarkToCommit, type SyncRunStatus } from './watermark';

/** Una riparazione come sta sul database, con quel che serve a rieseguirla. */
export interface StoredRepair extends OpenRepair {
  details: Record<string, unknown> | null;
  openedByJobId: string | null;
}

const REPAIR_COLUMNS = {
  id: true,
  resourceType: true,
  resourceId: true,
  operation: true,
  sourceUpdatedAt: true,
  recoveredByDelta: true,
  attempts: true,
  nextAttemptAt: true,
  details: true,
  openedByJobId: true,
} as const;

function toStored(riga: {
  id: string;
  resourceType: string;
  resourceId: string;
  operation: string;
  sourceUpdatedAt: Date | null;
  recoveredByDelta: boolean;
  attempts: number;
  nextAttemptAt: Date;
  details: Prisma.JsonValue | null;
  openedByJobId: string | null;
}): StoredRepair {
  return {
    id: riga.id,
    resourceType: riga.resourceType as RepairResourceType,
    resourceId: riga.resourceId,
    operation: riga.operation as RepairOperation,
    sourceUpdatedAt: riga.sourceUpdatedAt,
    recoveredByDelta: riga.recoveredByDelta,
    attempts: riga.attempts,
    nextAttemptAt: riga.nextAttemptAt,
    details:
      riga.details && typeof riga.details === 'object' && !Array.isArray(riga.details)
        ? (riga.details as Record<string, unknown>)
        : null,
    openedByJobId: riga.openedByJobId,
  };
}

/**
 * Tutto cio' che per questo negozio e' ancora da rimettere a posto.
 *
 * Si legge all'inizio della corsa, una volta sola, e serve a due cose che
 * sembrano lontane e sono la stessa: sapere quali risorse la corsa deve
 * ritrovare (e quindi fin dove tenere indietro il confine) e sapere quali sono
 * appena state rimesse a posto, per chiuderle.
 */
export async function loadOpenRepairs(shopId: string): Promise<StoredRepair[]> {
  const righe = await prisma.syncRepair.findMany({
    where: { shopId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    select: REPAIR_COLUMNS,
  });
  return righe.map(toStored);
}

/**
 * Le riparazioni che nessun delta riportera' mai, e che quindi vanno rispinte.
 *
 * Sono due: la data di nascita, che va VERSO Shopify — dove non e' cambiato
 * niente da segnalare, quindi aspettarla nel delta sarebbe aspettare un evento
 * impossibile — e la spazzata delle righe non piu' riscritte, che la corsa
 * incrementale non fa. `nextAttemptAt` tiene il distanziamento.
 */
export function pushableRepairs(aperte: readonly StoredRepair[], now: Date): StoredRepair[] {
  return aperte.filter(
    (r) => !r.recoveredByDelta && r.nextAttemptAt.getTime() <= now.getTime(),
  );
}

export interface RunCounters {
  productsSynced?: number;
  variantsSynced?: number;
  customersSynced?: number;
  productsAdded?: number;
  productsRemoved?: number;
  customersAdded?: number;
  customersUpdated?: number;
  customersSuspended?: number;
}

export interface CommitRunResult {
  status: SyncRunStatus;
  watermarkAt: Date;
  openRepairs: number;
  deadLettered: number;
}

/**
 * Chiude la corsa: riparazioni e confine, insieme.
 *
 * L'ordine dentro la transazione non e' indifferente. Prima le riparazioni,
 * poi il confine: se la scrittura delle riparazioni fallisce, la transazione
 * cade tutta e il confine non si muove — che e' esattamente il
 * comportamento voluto, perche' un confine avanzato senza il suo registro e' il
 * guasto da cui e' partito tutto.
 */
export async function commitSyncRun(opts: {
  shopId: string;
  syncJobId: string;
  runStartedAt: Date;
  /**
   * Da dove questa corsa ha cominciato a leggere Shopify. Serve a decidere fin
   * dove tenere indietro il confine per le risorse che non portano la loro data
   * di modifica: fermarsi all'inizio della corsa non le tratterrebbe.
   */
  deltaFloor: Date;
  ledger: RepairLedger;
  existing: readonly OpenRepair[];
  counters: RunCounters;
  now?: Date;
}): Promise<CommitRunResult> {
  const now = opts.now ?? new Date();
  const piano = planRepairCommit({
    ledger: opts.ledger,
    existing: opts.existing,
    deltaFloor: opts.deltaFloor,
    now,
  });

  const watermarkAt = watermarkToCommit(opts.runStartedAt, piano.holdBackTo);
  const status = runStatusFor(piano.openAfter);

  const scritture: Prisma.PrismaPromise<unknown>[] = [];

  for (const write of piano.writes) {
    const comune = {
      sourceUpdatedAt: write.sourceUpdatedAt,
      recoveredByDelta: write.recoveredByDelta,
      status: write.status,
      attempts: write.attempts,
      nextAttemptAt: write.nextAttemptAt,
      details:
        write.details === undefined
          ? Prisma.DbNull
          : (write.details as Prisma.InputJsonValue),
      lastError: write.lastError.slice(0, 500),
      openedByJobId: opts.syncJobId,
      resolvedAt: null,
    };

    scritture.push(
      prisma.syncRepair.upsert({
        where: {
          shopId_resourceType_resourceId_operation: {
            shopId: opts.shopId,
            resourceType: write.resourceType,
            resourceId: write.resourceId,
            operation: write.operation,
          },
        },
        create: {
          shopId: opts.shopId,
          resourceType: write.resourceType,
          resourceId: write.resourceId,
          operation: write.operation,
          ...comune,
        },
        update: comune,
      }),
    );
  }

  if (piano.resolvedIds.length > 0) {
    scritture.push(
      prisma.syncRepair.updateMany({
        where: { id: { in: piano.resolvedIds } },
        // Chiusa, non cancellata: resta la traccia di una risorsa che era
        // rimasta indietro e di quando e' tornata a posto. La potatura la
        // toglie dopo, come per le richieste concluse della coda.
        data: { status: 'done', resolvedAt: now, lastError: null },
      }),
    );
  }

  scritture.push(
    prisma.syncJob.update({
      where: { id: opts.syncJobId },
      data: {
        status,
        completedAt: now,
        watermarkAt,
        repairsOpened: piano.openAfter,
        ...opts.counters,
      },
    }),
  );

  await prisma.$transaction(scritture);

  segnalaLettereMorte(opts.shopId, piano);

  // Le corse che avevano lasciato qualcosa in sospeso e adesso non ce l'hanno
  // piu': tornano completate. E' quello che toglie "parziale" dall'interfaccia
  // senza che nessuno debba ricalcolarlo a ogni pagina.
  await chiudiCorseParziali(opts.shopId);

  return {
    status,
    watermarkAt,
    openRepairs: piano.openAfter,
    deadLettered: piano.deadLettered.length,
  };
}

function segnalaLettereMorte(shopId: string, piano: RepairCommitPlan): void {
  for (const morta of piano.deadLettered) {
    console.error(
      `[riparazioni] ALLARME ${morta.resourceType} ${morta.resourceId} (${morta.operation}) ` +
        `del negozio ${shopId} fermo dopo ${morta.attempts} tentativi: ${morta.lastError}. ` +
        'Da qui in poi il confine incrementale non lo aspetta piu\': ' +
        `npm run repairs:replay -- ${morta.resourceType} ${morta.resourceId}`,
    );
  }
}

/**
 * Le corse che possono smettere di dirsi parziali.
 *
 * Una corsa resta `completed_with_repairs` finche' esiste una sola riparazione
 * aperta fra quelle che aveva trovato lei. Quando l'ultima si chiude — perche'
 * una corsa successiva ha riscritto quella risorsa, o perche' la spinta e'
 * andata a buon fine — la corsa torna `completed`.
 *
 * Le riparazioni finite in lettera morta NON tolgono il parziale: quella
 * risorsa non e' stata rimessa a posto, e dire il contrario sarebbe la bugia
 * peggiore che questa colonna possa raccontare.
 */
async function chiudiCorseParziali(shopId: string): Promise<void> {
  const parziali = await prisma.syncJob.findMany({
    where: { shopId, status: 'completed_with_repairs' },
    select: { id: true },
  });
  if (parziali.length === 0) return;

  const aperte = await prisma.syncRepair.groupBy({
    by: ['openedByJobId'],
    where: {
      shopId,
      status: { in: ['pending', 'dead_letter'] },
      openedByJobId: { in: parziali.map((j) => j.id) },
    },
    _count: { _all: true },
  });

  const conLavoroAperto = new Set(aperte.map((r) => r.openedByJobId));
  const finite = parziali.filter((j) => !conLavoroAperto.has(j.id)).map((j) => j.id);
  if (finite.length === 0) return;

  await prisma.syncJob.updateMany({
    where: { id: { in: finite } },
    data: { status: 'completed', repairsOpened: 0 },
  });
}

/**
 * Il confine da cui ripartire: l'ultima corsa che se l'e' guadagnato.
 *
 * Si cerca `watermarkAt`, non uno stato. La differenza e' tutta qui: prima si
 * cercava l'ultima corsa `completed`, e `completed` lo diventava anche una
 * corsa che aveva ignorato una manciata di errori — il confine scavalcava
 * risorse che nessuno aveva scritto, e quelle risorse non tornavano piu'.
 *
 * Valgono sia i controlli periodici sia le sincronizzazioni complete: una corsa
 * completa ha letto tutto fino al proprio inizio, quindi e' un confine buono
 * quanto l'altro. Escluderla voleva dire rileggere due volte lo stesso mese.
 */
export async function loadWatermark(shopId: string): Promise<Date | null> {
  const corsa = await prisma.syncJob.findFirst({
    where: {
      shopId,
      jobType: { in: ['periodic_check', 'initial_bulk'] },
      watermarkAt: { not: null },
    },
    orderBy: { watermarkAt: 'desc' },
    select: { watermarkAt: true },
  });
  return corsa?.watermarkAt ?? null;
}

/**
 * Una riparazione spinta e' andata a buon fine.
 */
export async function resolveRepair(id: string, now: Date = new Date()): Promise<void> {
  await prisma.syncRepair.update({
    where: { id },
    data: { status: 'done', resolvedAt: now, lastError: null },
  });
}

/**
 * Una riparazione spinta e' andata storta: si conta il tentativo e si distanzia
 * il prossimo. Oltre la soglia si smette, e lo si dice forte.
 */
export async function failRepairAttempt(
  repair: StoredRepair,
  error: unknown,
  shopId: string,
  now: Date = new Date(),
): Promise<void> {
  const attempts = repair.attempts + 1;
  const esaurita = attempts >= MAX_REPAIR_ATTEMPTS;
  const messaggio = redactError(error);

  await prisma.syncRepair.update({
    where: { id: repair.id },
    data: {
      attempts,
      status: esaurita ? 'dead_letter' : 'pending',
      nextAttemptAt: nextRepairAttemptAt(attempts, now),
      lastError: messaggio.slice(0, 500),
    },
  });

  if (esaurita) {
    console.error(
      `[riparazioni] ALLARME ${repair.resourceType} ${repair.resourceId} ` +
        `(${repair.operation}) del negozio ${shopId} fermo dopo ${attempts} tentativi: ` +
        `${messaggio}. npm run repairs:replay -- ${repair.id}`,
    );
  }
}

/** Per quanto si tengono le riparazioni chiuse prima di toglierle di mezzo. */
export const REPAIR_DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Toglie di mezzo le riparazioni chiuse da un pezzo.
 *
 * Le chiuse e basta. Quelle in lettera morta restano: sono l'unica traccia di
 * una risorsa che non e' stata rimessa a posto, e cancellarle dopo una settimana
 * vorrebbe dire far sparire il problema invece di risolverlo.
 */
export async function pruneRepairs(now: Date = new Date()): Promise<number> {
  const esito = await prisma.syncRepair.deleteMany({
    where: { status: 'done', resolvedAt: { lt: new Date(now.getTime() - REPAIR_DONE_TTL_MS) } },
  });
  return esito.count;
}

/**
 * Le riparazioni ferme in lettera morta.
 *
 * Serve al comando di replay e a chi va a guardare dopo un allarme. Sono
 * l'elenco delle risorse del merchant che non sono allineate e che nessuno sta
 * piu' provando a rimettere a posto.
 */
export async function listDeadRepairs(limit = 50) {
  return prisma.syncRepair.findMany({
    where: { status: 'dead_letter' },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      shopId: true,
      resourceType: true,
      resourceId: true,
      operation: true,
      attempts: true,
      lastError: true,
      updatedAt: true,
    },
  });
}

/**
 * Rimette in lavorazione quel che era stato abbandonato.
 *
 * Azzera i tentativi di proposito: la lettera morta si ripiglia dopo aver
 * aggiustato la causa, e ripartire con il contatore gia' pieno vorrebbe dire un
 * solo tentativo prima di tornare dov'era. Senza `ids` le riprende tutte.
 */
export async function replayDeadRepairs(
  ids?: string[],
  now: Date = new Date(),
): Promise<number> {
  const esito = await prisma.syncRepair.updateMany({
    where: { status: 'dead_letter', ...(ids && ids.length > 0 ? { id: { in: ids } } : {}) },
    data: { status: 'pending', attempts: 0, nextAttemptAt: now, resolvedAt: null },
  });
  return esito.count;
}
