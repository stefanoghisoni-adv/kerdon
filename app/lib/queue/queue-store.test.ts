import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('~/db.server', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    syncRequest: {
      createMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from '~/db.server';
import {
  COMPLETED_TTL_MS,
  claimStatement,
  enqueueSyncRequest,
  postgresQueueStore,
  pruneSyncRequests,
  replayDeadLetters,
} from './queue-store.server';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * La coda su Postgres.
 *
 * Due cose vanno difese qui piu' di tutte, e sono le due che la coda vecchia
 * non aveva: che la presa sia atomica (nessuno puo' vedere e poi decidere: si
 * vede e si prende in un'istruzione sola) e che nessuna scrittura passi senza
 * il gettone di chi possiede l'item. La prima non si puo' eseguire senza un
 * database, e allora la si legge — il testo del SQL e' parte del contratto.
 */

const ADESSO = new Date('2026-09-05T10:00:00.000Z');
const LEASE = { id: 'item-1', owner: 'A', fencingToken: 3 };

let errorSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.syncRequest.updateMany as any).mockResolvedValue({ count: 1 });
  (prisma.syncRequest.deleteMany as any).mockResolvedValue({ count: 0 });
  (prisma.syncRequest.createMany as any).mockResolvedValue({ count: 1 });
  (prisma.$queryRaw as any).mockResolvedValue([]);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('l\'istruzione che prende possesso', () => {
  const sql = () =>
    claimStatement({ owner: 'A', now: ADESSO, limit: 5, shopId: null }).sql.replace(/\s+/g, ' ');

  /**
   * `SKIP LOCKED` e' il motivo per cui due drenaggi che partono insieme non si
   * aspettano ne' si sovrappongono: il secondo salta le righe che il primo sta
   * gia' prendendo, invece di mettersi in fila dietro di lui o — com'era prima,
   * senza nessun blocco — di lavorarle tutte e due.
   */
  it('salta quel che qualcun altro sta prendendo', () => {
    expect(sql()).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('e\' una sola istruzione: si vede e si prende insieme', () => {
    // Il pooler di Supabase e' in transaction mode: fra una query e l'altra la
    // sessione non e' di nessuno, quindi un "leggi, poi decidi, poi scrivi"
    // darebbe lo stesso item a due invocazioni.
    const istruzioni = sql().split(';').filter((i) => i.trim().length > 0);
    expect(istruzioni).toHaveLength(1);
    expect(sql()).toMatch(/^\s*UPDATE "sync_requests"/);
  });

  it('alza il gettone a ogni presa', () => {
    expect(sql()).toContain('"fencing_token" = r."fencing_token" + 1');
  });

  /**
   * Il tentativo si conta al momento della presa, non alla fine. Contandolo
   * dopo, un item che fa morire il processo prima di poter riferire qualunque
   * cosa girerebbe in tondo per sempre senza avvicinarsi mai alla lettera morta.
   */
  it('conta il tentativo quando prende, non quando finisce', () => {
    expect(sql()).toContain('"attempts" = r."attempts" + 1');
  });

  it('prende sia quel che e\' pronto sia quel che e\' stato abbandonato', () => {
    expect(sql()).toContain('c."status" = \'queued\' AND c."next_attempt_at" <=');
    expect(sql()).toContain('c."status" = \'processing\' AND c."lease_expires_at" <=');
  });

  it('restituisce quello che ha preso, senza una seconda lettura', () => {
    expect(sql()).toContain('RETURNING');
    expect(sql()).toContain('r."fencing_token"');
  });

  it('sa restringersi a un negozio solo, per la corsia veloce', () => {
    const perNegozio = claimStatement({ owner: 'A', now: ADESSO, limit: 5, shopId: 'shop-1' });
    expect(perNegozio.values).toContain('shop-1');
  });
});

describe('le scritture di chi possiede l\'item', () => {
  /**
   * Il caso del deploy a meta' lavoro. Il processo vecchio si risveglia e vuole
   * chiudere: la guardia sul gettone fa toccare zero righe, e la chiusura
   * restituisce `false` invece di far sparire un lavoro che sta facendo qualcun
   * altro.
   */
  it('la chiusura porta id, proprietario e gettone', async () => {
    await postgresQueueStore.complete(LEASE, ADESSO);
    const dove = (prisma.syncRequest.updateMany as any).mock.calls[0][0].where;
    expect(dove).toEqual({ id: 'item-1', leaseOwner: 'A', fencingToken: 3 });
  });

  it('la chiusura dice di no quando il gettone non e\' piu\' il suo', async () => {
    (prisma.syncRequest.updateMany as any).mockResolvedValue({ count: 0 });
    expect(await postgresQueueStore.complete(LEASE, ADESSO)).toBe(false);
  });

  it('anche la riprogrammazione e la lettera morta portano il gettone', async () => {
    await postgresQueueStore.reschedule(LEASE, ADESSO, new Error('x'), ADESSO);
    await postgresQueueStore.deadLetter(LEASE, new Error('x'), ADESSO);
    for (const chiamata of (prisma.syncRequest.updateMany as any).mock.calls) {
      expect(chiamata[0].where).toMatchObject({ leaseOwner: 'A', fencingToken: 3 });
    }
  });

  /**
   * Un item fallito non si cancella MAI. La coda vecchia, su eccezione,
   * chiamava `job.remove()`: i tentativi e il backoff configurati su BullMQ non
   * li applicava nessuno, e un errore di rete di due secondi perdeva una
   * sincronizzazione per sempre.
   */
  it('riprogrammare rimette in coda, non cancella', async () => {
    const fra5min = new Date(ADESSO.getTime() + 300_000);
    await postgresQueueStore.reschedule(LEASE, fra5min, new Error('timeout'), ADESSO);

    expect(prisma.syncRequest.deleteMany).not.toHaveBeenCalled();
    const dati = (prisma.syncRequest.updateMany as any).mock.calls[0][0].data;
    expect(dati.status).toBe('queued');
    expect(dati.nextAttemptAt).toBe(fra5min);
  });

  it('il motivo scritto sulla riga e\' redatto', async () => {
    await postgresQueueStore.reschedule(
      LEASE,
      ADESSO,
      new Error('rifiutato con apikey=abcdef1234567890'),
      ADESSO,
    );
    const dati = (prisma.syncRequest.updateMany as any).mock.calls[0][0].data;
    expect(dati.lastError).not.toContain('abcdef1234567890');
  });

  /**
   * Un negozio occupato non e' un fallimento del lavoro. Contandolo come tale,
   * un negozio che riceve due sincronizzazioni ravvicinate manderebbe la
   * seconda in lettera morta in cinque giri senza che nessuno abbia mai provato
   * a eseguirla.
   */
  it('restituire un item non consumato ridà indietro il tentativo', async () => {
    await postgresQueueStore.release(LEASE, ADESSO, 'negozio occupato');
    const dati = (prisma.syncRequest.updateMany as any).mock.calls[0][0].data;
    expect(dati.attempts).toEqual({ decrement: 1 });
    expect(dati.status).toBe('queued');
  });

  it('il battito rinnova solo se l\'item e\' ancora in lavorazione e ancora nostro', async () => {
    await postgresQueueStore.heartbeat(LEASE, ADESSO);
    const dove = (prisma.syncRequest.updateMany as any).mock.calls[0][0].where;
    expect(dove).toMatchObject({ leaseOwner: 'A', fencingToken: 3, status: 'processing' });
  });

  it('il battito dice di no quando l\'item non e\' piu\' nostro', async () => {
    (prisma.syncRequest.updateMany as any).mockResolvedValue({ count: 0 });
    expect(await postgresQueueStore.heartbeat(LEASE, ADESSO)).toBe(false);
  });
});

describe('l\'accodamento', () => {
  /**
   * Il rifiuto immediato del tipo sconosciuto. Prima l'item entrava, il
   * drenaggio non lo riconosceva e lo saltava con un `continue`: restava in
   * attesa per sempre, e non c'era niente da guardare per accorgersene.
   */
  it('rifiuta subito un tipo sconosciuto, con un allarme', async () => {
    await expect(
      enqueueSyncRequest({
        type: 'retry-failed-webhook' as never,
        shopId: 'shop-1',
        dedupKey: 'x',
      }),
    ).rejects.toThrow(/sconosciuto/i);

    expect(prisma.syncRequest.createMany).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls[0][0]).toContain('ALLARME');
  });

  it('accoda un tipo noto', async () => {
    const esito = await enqueueSyncRequest({
      type: 'manual-sync',
      shopId: 'shop-1',
      dedupKey: 'manual-sync:shop-1:1',
    });
    expect(esito.duplicate).toBe(false);
    expect((prisma.syncRequest.createMany as any).mock.calls[0][0].skipDuplicates).toBe(true);
  });

  /**
   * La deduplica e' una proprieta' del database, non un controllo prima: due
   * richieste arrivate insieme passerebbero tutte e due un controllo, mentre
   * sull'indice unico ne entra una sola.
   */
  it('non aggiunge un secondo item per la stessa chiave, e restituisce il primo', async () => {
    (prisma.syncRequest.createMany as any).mockResolvedValue({ count: 0 });
    (prisma.syncRequest.findUnique as any).mockResolvedValue({ id: 'gia-in-coda' });

    const esito = await enqueueSyncRequest({
      type: 'manual-sync',
      shopId: 'shop-1',
      dedupKey: 'manual-sync:shop-1:1',
    });

    expect(esito).toEqual({ id: 'gia-in-coda', duplicate: true });
  });

  it('porta il payload minimo, non il corpo del lavoro', async () => {
    await enqueueSyncRequest({
      type: 'compliance-request',
      shopId: null,
      payload: { requestId: 'req-1' },
      dedupKey: 'compliance-request:req-1',
    });
    const riga = (prisma.syncRequest.createMany as any).mock.calls[0][0].data[0];
    expect(riga.payload).toEqual({ requestId: 'req-1' });
  });
});

describe('la lettera morta e le pulizie', () => {
  it('il replay riazzera i tentativi: ripartire con il contatore pieno non e\' ripartire', async () => {
    await replayDeadLetters(['item-1'], ADESSO);
    const chiamata = (prisma.syncRequest.updateMany as any).mock.calls[0][0];
    expect(chiamata.where.status).toBe('dead_letter');
    expect(chiamata.where.id).toEqual({ in: ['item-1'] });
    expect(chiamata.data).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('senza id li riprende tutti', async () => {
    await replayDeadLetters(undefined, ADESSO);
    expect((prisma.syncRequest.updateMany as any).mock.calls[0][0].where).toEqual({
      status: 'dead_letter',
    });
  });

  /**
   * La potatura tocca solo le concluse. Quelle in lettera morta sono l'unica
   * traccia di un lavoro che non e' stato fatto: cancellarle dopo una settimana
   * vorrebbe dire far sparire il problema invece di risolverlo.
   */
  it('la potatura non porta via la lettera morta', async () => {
    await pruneSyncRequests(ADESSO);
    const dove = (prisma.syncRequest.deleteMany as any).mock.calls[0][0].where;
    expect(dove.status).toBe('completed');
    expect(dove.completedAt.lt.getTime()).toBe(ADESSO.getTime() - COMPLETED_TTL_MS);
  });
});
