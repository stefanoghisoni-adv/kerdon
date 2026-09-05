import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * La chiusura di una corsa, dal lato del database.
 *
 * Quello che si prova qui e' una regola sola, e vale la pena scriverla per
 * esteso perche' e' l'intera correzione: il confine incrementale e le righe
 * delle risorse rimaste indietro si scrivono NELLO STESSO commit. Se le
 * riparazioni non entrano, il confine non si muove; e se il processo muore
 * prima del commit, non e' successo niente — la corsa dopo rilegge la stessa
 * finestra e riscopre gli stessi guasti da sola.
 */

const transazioni: unknown[][] = [];

vi.mock('~/db.server', () => ({
  prisma: {
    syncRepair: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn((args: unknown) => ({ op: 'upsert', args })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn((args: unknown) => ({ op: 'updateMany', args })),
      groupBy: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    syncJob: {
      update: vi.fn((args: unknown) => ({ op: 'jobUpdate', args })),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    $transaction: vi.fn(async (ops: unknown[]) => {
      transazioni.push(ops);
      return ops;
    }),
  },
}));

import { prisma } from '~/db.server';
import { commitSyncRun, loadWatermark, pushableRepairs } from './repair-outbox.server';
import { createRepairLedger, type OpenRepair } from './repair-ledger';

const INIZIO = new Date('2026-03-01T10:00:00Z');
const PARTENZA = new Date('2026-03-01T08:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  transazioni.length = 0;
});

describe('la chiusura di una corsa', () => {
  it('senza niente in sospeso scrive il confine fino al proprio inizio', async () => {
    const esito = await commitSyncRun({
      shopId: 'shop-1',
      syncJobId: 'job-1',
      runStartedAt: INIZIO,
      deltaFloor: PARTENZA,
      ledger: createRepairLedger(),
      existing: [],
      counters: { productsSynced: 3 },
      now: INIZIO,
    });

    expect(esito.status).toBe('completed');
    expect(esito.watermarkAt).toEqual(INIZIO);
    expect(prisma.syncJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        status: 'completed',
        watermarkAt: INIZIO,
        repairsOpened: 0,
        productsSynced: 3,
      }),
    });
  });

  it('con una risorsa indietro il confine non la scavalca, e la corsa e\' parziale', async () => {
    const registro = createRepairLedger();
    registro.open({
      resourceType: 'product',
      resourceId: '77',
      operation: 'upsert',
      sourceUpdatedAt: new Date('2026-03-01T09:15:00Z'),
      reason: 'scrittura rifiutata',
      recoveredByDelta: true,
    });

    const esito = await commitSyncRun({
      shopId: 'shop-1',
      syncJobId: 'job-1',
      runStartedAt: INIZIO,
      deltaFloor: PARTENZA,
      ledger: registro,
      existing: [],
      counters: {},
      now: INIZIO,
    });

    expect(esito.status).toBe('completed_with_repairs');
    expect(esito.watermarkAt).toEqual(new Date('2026-03-01T09:15:00Z'));
    expect(esito.openRepairs).toBe(1);
  });

  it('riparazioni e confine viaggiano nella stessa transazione, e le riparazioni per prime', async () => {
    // L'ordine non e' cosmetico: se la scrittura delle riparazioni fallisce, la
    // transazione cade tutta e il confine resta dov'era. Un confine avanzato
    // senza il suo registro e' il guasto da cui e' partito tutto.
    const registro = createRepairLedger();
    registro.open({
      resourceType: 'customer',
      resourceId: '9',
      operation: 'consent_revoke',
      sourceUpdatedAt: new Date('2026-03-01T09:00:00Z'),
      reason: 'marcatura non riuscita',
      recoveredByDelta: true,
    });

    await commitSyncRun({
      shopId: 'shop-1',
      syncJobId: 'job-1',
      runStartedAt: INIZIO,
      deltaFloor: PARTENZA,
      ledger: registro,
      existing: [],
      counters: {},
      now: INIZIO,
    });

    expect(transazioni).toHaveLength(1);
    const operazioni = transazioni[0] as { op: string }[];
    expect(operazioni.map((o) => o.op)).toEqual(['upsert', 'jobUpdate']);
  });

  it('una riparazione chiusa esce dalla transazione come chiusa, non cancellata', async () => {
    // Resta la traccia di una risorsa che era rimasta indietro e di quando e'
    // tornata a posto: cancellarla vorrebbe dire far sparire la storia.
    const registro = createRepairLedger();
    registro.resolve({ resourceType: 'product', resourceId: '5', operation: 'upsert' });

    const gia: OpenRepair = {
      id: 'r-5',
      resourceType: 'product',
      resourceId: '5',
      operation: 'upsert',
      sourceUpdatedAt: new Date('2026-02-01T00:00:00Z'),
      attempts: 1,
      nextAttemptAt: PARTENZA,
      recoveredByDelta: true,
    };

    const esito = await commitSyncRun({
      shopId: 'shop-1',
      syncJobId: 'job-2',
      runStartedAt: INIZIO,
      deltaFloor: PARTENZA,
      ledger: registro,
      existing: [gia],
      counters: {},
      now: INIZIO,
    });

    expect(prisma.syncRepair.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['r-5'] } },
      data: { status: 'done', resolvedAt: INIZIO, lastError: null },
    });
    // E il confine puo' finalmente avanzare: non c'e' piu' niente da aspettare.
    expect(esito.watermarkAt).toEqual(INIZIO);
    expect(esito.status).toBe('completed');
  });

  it('la lettera morta lascia un allarme con il comando per ripartire', async () => {
    const allarmi: string[] = [];
    const spia = vi.spyOn(console, 'error').mockImplementation((m) => allarmi.push(String(m)));

    const registro = createRepairLedger();
    registro.open({
      resourceType: 'product',
      resourceId: '77',
      operation: 'upsert',
      sourceUpdatedAt: new Date('2026-03-01T09:15:00Z'),
      reason: 'scrittura rifiutata',
      recoveredByDelta: true,
    });

    await commitSyncRun({
      shopId: 'shop-1',
      syncJobId: 'job-1',
      runStartedAt: INIZIO,
      deltaFloor: PARTENZA,
      ledger: registro,
      existing: [
        {
          id: 'r-77',
          resourceType: 'product',
          resourceId: '77',
          operation: 'upsert',
          sourceUpdatedAt: new Date('2026-03-01T09:15:00Z'),
          // Al quinto la pazienza e' finita.
          attempts: 4,
          nextAttemptAt: PARTENZA,
          recoveredByDelta: true,
        },
      ],
      counters: {},
      now: INIZIO,
    });

    spia.mockRestore();
    expect(allarmi.some((a) => a.startsWith('[riparazioni] ALLARME'))).toBe(true);
    expect(allarmi.some((a) => a.includes('repairs:replay'))).toBe(true);
  });
});

describe('lo stato parziale', () => {
  it('se ne va da solo quando l\'ultima riparazione di quella corsa si chiude', async () => {
    // "Parziale finche' le riparazioni non sono finite" dev'essere vero anche
    // dopo: se restasse scritto per sempre, il merchant continuerebbe a leggere
    // di un problema che non c'e' piu'.
    (prisma.syncJob.findMany as any).mockResolvedValue([{ id: 'job-vecchio' }]);
    (prisma.syncRepair.groupBy as any).mockResolvedValue([]);

    await commitSyncRun({
      shopId: 'shop-1',
      syncJobId: 'job-nuovo',
      runStartedAt: INIZIO,
      deltaFloor: PARTENZA,
      ledger: createRepairLedger(),
      existing: [],
      counters: {},
      now: INIZIO,
    });

    expect(prisma.syncJob.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['job-vecchio'] } },
      data: { status: 'completed', repairsOpened: 0 },
    });
  });

  it('resta finche\' una riparazione di quella corsa e\' ancora aperta', async () => {
    (prisma.syncJob.findMany as any).mockResolvedValue([{ id: 'job-vecchio' }]);
    (prisma.syncRepair.groupBy as any).mockResolvedValue([
      { openedByJobId: 'job-vecchio', _count: { _all: 1 } },
    ]);

    await commitSyncRun({
      shopId: 'shop-1',
      syncJobId: 'job-nuovo',
      runStartedAt: INIZIO,
      deltaFloor: PARTENZA,
      ledger: createRepairLedger(),
      existing: [],
      counters: {},
      now: INIZIO,
    });

    expect(prisma.syncJob.updateMany).not.toHaveBeenCalled();
  });

  it('la lettera morta non toglie il parziale', async () => {
    // Quella risorsa non e' stata rimessa a posto: dire "completata" sarebbe la
    // bugia peggiore che questa colonna possa raccontare.
    (prisma.syncJob.findMany as any).mockResolvedValue([{ id: 'job-vecchio' }]);
    (prisma.syncRepair.groupBy as any).mockResolvedValue([
      { openedByJobId: 'job-vecchio', _count: { _all: 1 } },
    ]);

    await commitSyncRun({
      shopId: 'shop-1',
      syncJobId: 'job-nuovo',
      runStartedAt: INIZIO,
      deltaFloor: PARTENZA,
      ledger: createRepairLedger(),
      existing: [],
      counters: {},
      now: INIZIO,
    });

    // Il conteggio comprende anche `dead_letter`, non solo `pending`.
    expect(prisma.syncRepair.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['pending', 'dead_letter'] },
        }),
      }),
    );
  });
});

describe('il confine da cui ripartire', () => {
  it('si chiede per colonna, non per stato della corsa', async () => {
    await loadWatermark('shop-1');

    expect(prisma.syncJob.findFirst).toHaveBeenCalledWith({
      where: {
        shopId: 'shop-1',
        jobType: { in: ['periodic_check', 'initial_bulk'] },
        watermarkAt: { not: null },
      },
      orderBy: { watermarkAt: 'desc' },
      select: { watermarkAt: true },
    });
  });
});

describe('quali riparazioni vanno rispinte', () => {
  const base = {
    resourceType: 'customer' as const,
    resourceId: '1',
    attempts: 1,
    details: null,
    openedByJobId: null,
    sourceUpdatedAt: null,
  };

  it('solo quelle che nessun delta riporterebbe, e solo quando e\' ora', () => {
    const spingibili = pushableRepairs(
      [
        { ...base, id: 'a', operation: 'birthdate_writeback', recoveredByDelta: false, nextAttemptAt: PARTENZA },
        { ...base, id: 'b', operation: 'upsert', recoveredByDelta: true, nextAttemptAt: PARTENZA },
        {
          ...base,
          id: 'c',
          operation: 'birthdate_writeback',
          recoveredByDelta: false,
          // Distanziata: non e' ancora ora.
          nextAttemptAt: new Date('2026-03-01T23:00:00Z'),
        },
      ],
      INIZIO,
    );

    expect(spingibili.map((r) => r.id)).toEqual(['a']);
  });
});
