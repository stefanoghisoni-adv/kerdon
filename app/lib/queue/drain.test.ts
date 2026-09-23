import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('~/db.server', () => ({ prisma: {} }));
vi.mock('~/lib/workers/processors.server', () => ({
  processInitialBulkSync: vi.fn(),
  processManualSync: vi.fn(),
  processPeriodicSyncCheck: vi.fn(),
}));
vi.mock('~/lib/gdpr/process-compliance.server', () => ({
  processComplianceRequest: vi.fn(),
}));
vi.mock('./shop-lock.server', () => ({ runWithShopLease: vi.fn() }));
vi.mock('~/lib/shipping/recompute.server', () => ({ processLogisticsRecompute: vi.fn() }));

import { drainSyncRequests, type Handler } from './drain.server';
import { runWithShopLease } from './shop-lock.server';
import { processManualSync } from '~/lib/workers/processors.server';
import { processLogisticsRecompute } from '~/lib/shipping/recompute.server';
import type { QueueStore } from './queue-store.server';
import {
  LEASE_TTL_MS,
  MAX_ATTEMPTS,
  MAX_RUN_MS,
  holdsLease,
  isClaimable,
  type SyncRequestLease,
  type SyncRequestRow,
} from './queue-model';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Il consumatore della coda.
 *
 * DA DOVE VIENE OGNI PROVA DI QUESTO FILE. Il drenaggio vecchio leggeva i job
 * in attesa da BullMQ e chiamava i processor direttamente: nessuno prendeva
 * possesso di niente, quindi due invocazioni — quella del cron e quella che un
 * gesto manuale innesca subito — potevano lavorare lo stesso job insieme. E su
 * eccezione il job veniva RIMOSSO, quindi i tentativi e il backoff configurati
 * su BullMQ non li applicava nessuno.
 *
 * Il danno peggiore non era il doppione: la corsa completa finisce spazzando le
 * righe con `synced_at` anteriore al proprio inizio, e due corse sovrapposte
 * hanno due inizi diversi — la piu' vecchia porta via quello che la piu'
 * recente ha appena scritto.
 *
 * COME SI PROVA SENZA UN POSTGRES. Con una coda in memoria che applica le
 * stesse regole di queue-model — le stesse che il SQL implementa. Che il SQL le
 * implementi davvero e' provato a parte, leggendo il testo dell'istruzione
 * (queue-store.test.ts): li' si pretende `FOR UPDATE SKIP LOCKED` e la guardia
 * sul gettone.
 */

const ADESSO = new Date('2026-09-05T10:00:00.000Z');

function riga(over: Partial<SyncRequestRow> = {}): SyncRequestRow {
  return {
    id: 'item-1',
    shopId: 'shop-1',
    type: 'manual-sync',
    payload: null,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: ADESSO,
    leaseOwner: null,
    leaseExpiresAt: null,
    fencingToken: 0,
    ...over,
  };
}

/**
 * Una coda in memoria che si comporta come quella su Postgres.
 *
 * La presa e' l'unica parte che conta davvero: si guarda e si prende nello
 * stesso momento, e chi arriva secondo non vede piu' quella riga. Le scritture
 * passano tutte per la stessa guardia su proprietario e gettone.
 */
function codaInMemoria(iniziali: SyncRequestRow[]) {
  const righe = iniziali.map((r) => ({ ...r }));
  const trova = (id: string) => righe.find((r) => r.id === id)!;

  const scrivi = (
    lease: SyncRequestLease,
    modifica: (r: SyncRequestRow) => void,
  ): Promise<boolean> => {
    const r = trova(lease.id);
    if (!r || !holdsLease(r, lease)) return Promise.resolve(false);
    modifica(r);
    return Promise.resolve(true);
  };

  const store: QueueStore = {
    async claim({ owner, now, limit = 10, shopId = null }) {
      const presi: Array<{ row: SyncRequestRow; lease: SyncRequestLease }> = [];
      for (const r of righe) {
        if (presi.length >= limit) break;
        if (shopId !== null && r.shopId !== shopId) continue;
        if (!isClaimable(r, now)) continue;

        r.status = 'processing';
        r.leaseOwner = owner;
        r.fencingToken += 1;
        r.attempts += 1;
        r.leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_MS);
        presi.push({
          row: { ...r },
          lease: { id: r.id, owner, fencingToken: r.fencingToken },
        });
      }
      return presi;
    },
    complete: (lease, now) =>
      scrivi(lease, (r) => {
        r.status = 'completed';
        r.leaseOwner = null;
        r.leaseExpiresAt = null;
        void now;
      }),
    reschedule: (lease, nextAttemptAt) =>
      scrivi(lease, (r) => {
        r.status = 'queued';
        r.nextAttemptAt = nextAttemptAt;
        r.leaseOwner = null;
        r.leaseExpiresAt = null;
      }),
    release: (lease, nextAttemptAt) =>
      scrivi(lease, (r) => {
        r.status = 'queued';
        r.nextAttemptAt = nextAttemptAt;
        r.leaseOwner = null;
        r.leaseExpiresAt = null;
        r.attempts -= 1;
      }),
    deadLetter: (lease) =>
      scrivi(lease, (r) => {
        r.status = 'dead_letter';
        r.leaseOwner = null;
        r.leaseExpiresAt = null;
      }),
    heartbeat: (lease, now) =>
      scrivi(lease, (r) => {
        r.leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_MS);
      }),
  };

  return { store, righe, trova };
}

let errorSpy: any;
let warnSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  (runWithShopLease as any).mockImplementation(
    async (_shopId: string, run: (lease: unknown) => Promise<void>) => {
      await run({ shopId: _shopId, assertHeld: async () => undefined });
      return 'eseguito';
    },
  );
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

describe('due drenaggi simultanei', () => {
  /**
   * Il guasto d'origine. Prima non c'era nessuna presa: `getJobs('waiting')`
   * restituiva lo stesso job a tutti e due, che poi chiamavano i processor.
   */
  it('vedono lo stesso item, ma uno solo lo lavora', async () => {
    const coda = codaInMemoria([riga({ type: 'compliance-request', shopId: null, payload: { requestId: 'r1' } })]);
    const lavorato = vi.fn(async () => undefined);
    const handlers = { 'compliance-request': lavorato as Handler };

    const [uno, due] = await Promise.all([
      drainSyncRequests({ store: coda.store, handlers, clock: () => ADESSO }),
      drainSyncRequests({ store: coda.store, handlers, clock: () => ADESSO }),
    ]);

    expect(lavorato).toHaveBeenCalledTimes(1);
    expect(uno.claimed + due.claimed).toBe(1);
    expect(uno.completed + due.completed).toBe(1);
    expect(coda.trova('item-1').status).toBe('completed');
  });

  it('si spartiscono un lotto invece di rifarlo due volte', async () => {
    const coda = codaInMemoria([
      riga({ id: 'a', type: 'compliance-request', shopId: null, payload: { requestId: 'r1' } }),
      riga({ id: 'b', type: 'compliance-request', shopId: null, payload: { requestId: 'r2' } }),
    ]);
    const lavorato = vi.fn(async () => undefined);
    const handlers = { 'compliance-request': lavorato as Handler };

    await Promise.all([
      drainSyncRequests({ store: coda.store, handlers, clock: () => ADESSO }),
      drainSyncRequests({ store: coda.store, handlers, clock: () => ADESSO }),
    ]);

    expect(lavorato).toHaveBeenCalledTimes(2);
    expect(coda.righe.every((r) => r.status === 'completed')).toBe(true);
  });
});

describe('quando il lavoro fallisce', () => {
  /**
   * Un item fallito non si cancella MAI. La coda vecchia chiamava
   * `job.remove()` nel catch: un errore di rete di due secondi perdeva una
   * sincronizzazione per sempre.
   */
  it('un errore transitorio conserva l\'item e lo distanzia', async () => {
    const coda = codaInMemoria([riga({ type: 'compliance-request', shopId: null, payload: { requestId: 'r1' } })]);
    const handlers = {
      'compliance-request': (async () => {
        throw new Error('timeout di rete');
      }) as Handler,
    };

    const esito = await drainSyncRequests({ store: coda.store, handlers, clock: () => ADESSO, random: () => 0 });

    expect(esito.retried).toBe(1);
    expect(esito.deadLettered).toBe(0);

    const dopo = coda.trova('item-1');
    expect(dopo.status).toBe('queued');
    expect(dopo.attempts).toBe(1);
    expect(dopo.nextAttemptAt.getTime()).toBeGreaterThan(ADESSO.getTime());
  });

  it('il ritentativo rilavora davvero l\'item, dopo l\'attesa', async () => {
    const coda = codaInMemoria([riga({ type: 'compliance-request', shopId: null, payload: { requestId: 'r1' } })]);
    let volte = 0;
    const handlers = {
      'compliance-request': (async () => {
        volte++;
        if (volte === 1) throw new Error('primo tentativo, rete giu');
      }) as Handler,
    };

    await drainSyncRequests({ store: coda.store, handlers, clock: () => ADESSO, random: () => 0 });
    // Prima dell'attesa non lo riprende nessuno: e' il backoff che funziona.
    await drainSyncRequests({ store: coda.store, handlers, clock: () => ADESSO });
    expect(volte).toBe(1);

    const dopo = new Date(ADESSO.getTime() + 3_600_000);
    await drainSyncRequests({ store: coda.store, handlers, clock: () => dopo });

    expect(volte).toBe(2);
    expect(coda.trova('item-1').status).toBe('completed');
  });

  /**
   * Oltre la soglia si smette, e si chiama qualcuno. Restare a ritentare in
   * eterno sarebbe peggio: nessuno se ne accorgerebbe.
   */
  it('un errore permanente finisce in lettera morta, con allarme e comando di replay', async () => {
    const coda = codaInMemoria([
      riga({
        type: 'compliance-request',
        shopId: null,
        payload: { requestId: 'r1' },
        attempts: MAX_ATTEMPTS - 1,
      }),
    ]);
    const handlers = {
      'compliance-request': (async () => {
        throw new Error('la tabella non esiste');
      }) as Handler,
    };

    const esito = await drainSyncRequests({ store: coda.store, handlers, clock: () => ADESSO });

    expect(esito.deadLettered).toBe(1);
    expect(coda.trova('item-1').status).toBe('dead_letter');

    const allarme = errorSpy.mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(allarme).toContain('ALLARME');
    expect(allarme).toContain('queue:replay');
  });

  it('quel che finisce nei conteggi e\' redatto', async () => {
    const coda = codaInMemoria([riga({ type: 'compliance-request', shopId: null, payload: { requestId: 'r1' } })]);
    const handlers = {
      'compliance-request': (async () => {
        throw new Error('rifiutato: apikey=abcdef1234567890abcdef');
      }) as Handler,
    };

    const esito = await drainSyncRequests({ store: coda.store, handlers, clock: () => ADESSO });
    expect(esito.errors.join(' ')).not.toContain('abcdef1234567890abcdef');
  });
});

describe('il lucchetto del negozio', () => {
  /**
   * LA PROVA CHE PRIMA SAREBBE FALLITA PER PROGETTO. Con il backend del
   * lucchetto irraggiungibile non deve partire nessuna corsa completa, e quindi
   * nessuna cancellazione: il codice vecchio, in quel caso, proseguiva senza
   * lucchetto e lo faceva apposta.
   */
  it('lucchetto irraggiungibile: nessuna sincronizzazione, nessuna cancellazione', async () => {
    (runWithShopLease as any).mockResolvedValue('non-disponibile');
    const coda = codaInMemoria([riga({ type: 'manual-sync', shopId: 'shop-1' })]);

    const esito = await drainSyncRequests({ store: coda.store, clock: () => ADESSO });

    expect(processManualSync).not.toHaveBeenCalled();
    expect(esito.lockUnavailable).toBe(1);
    expect(esito.completed).toBe(0);

    // E l'item e' ancora li', intatto: il lavoro e' rimandato, non perso.
    const dopo = coda.trova('item-1');
    expect(dopo.status).toBe('queued');
    expect(dopo.attempts).toBe(0);
  });

  /**
   * Un negozio occupato non e' un fallimento: contarlo come tale manderebbe in
   * lettera morta, in cinque giri, un lavoro che nessuno ha mai provato a fare.
   */
  it('negozio occupato: l\'item torna in coda senza consumare un tentativo', async () => {
    (runWithShopLease as any).mockResolvedValue('occupato');
    const coda = codaInMemoria([riga({ type: 'manual-sync', shopId: 'shop-1' })]);

    const esito = await drainSyncRequests({ store: coda.store, clock: () => ADESSO });

    expect(esito.skippedLocked).toBe(1);
    expect(coda.trova('item-1').attempts).toBe(0);
    expect(coda.trova('item-1').status).toBe('queued');
  });

  it('passa al processor il possesso, cosi\' la spazzata puo\' verificarlo', async () => {
    const coda = codaInMemoria([riga({ type: 'manual-sync', shopId: 'shop-1' })]);
    await drainSyncRequests({ store: coda.store, clock: () => ADESSO });

    const [shopId, , lease] = (processManualSync as any).mock.calls[0];
    expect(shopId).toBe('shop-1');
    expect(typeof lease.assertHeld).toBe('function');
  });
});

describe('il ricalcolo dei costi logistici', () => {
  /**
   * Sotto il lucchetto del negozio come le sincronizzazioni: due ricalcoli
   * sovrapposti potrebbero finire nell'ordine sbagliato, e l'ultimo a scrivere
   * sarebbe quello con le tariffe vecchie.
   */
  it('gira sotto il lucchetto del negozio e riceve possesso e segnale', async () => {
    const coda = codaInMemoria([riga({ type: 'logistics-recompute', shopId: 'shop-1' })]);

    const esito = await drainSyncRequests({ store: coda.store, clock: () => ADESSO });

    expect(esito.completed).toBe(1);
    expect(runWithShopLease).toHaveBeenCalledWith('shop-1', expect.any(Function), expect.anything());
    const [shopId, ctx] = (processLogisticsRecompute as any).mock.calls[0];
    expect(shopId).toBe('shop-1');
    expect(typeof ctx.lease.assertHeld).toBe('function');
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
  });

  it('negozio occupato: torna in coda senza consumare un tentativo', async () => {
    (runWithShopLease as any).mockResolvedValue('occupato');
    const coda = codaInMemoria([riga({ type: 'logistics-recompute', shopId: 'shop-1' })]);

    const esito = await drainSyncRequests({ store: coda.store, clock: () => ADESSO });

    expect(esito.skippedLocked).toBe(1);
    expect(coda.trova('item-1').attempts).toBe(0);
  });
});

describe('il possesso perduto durante il lavoro', () => {
  /**
   * IL DEPLOY A META' LAVORO. Il processo vecchio arriva in fondo, ma nel
   * frattempo il lease e' scaduto e un altro ha ripreso l'item con un gettone
   * maggiore. Dichiararlo completato qui sarebbe la bugia peggiore della coda:
   * l'item sparirebbe mentre un altro processo lo sta ancora eseguendo.
   */
  it('non si dichiara completato con un gettone vecchio', async () => {
    const coda = codaInMemoria([riga({ type: 'compliance-request', shopId: null, payload: { requestId: 'r1' } })]);

    const handlers = {
      'compliance-request': (async () => {
        // Mentre lavoriamo, il lease scade e qualcun altro riprende l'item.
        await coda.store.claim({
          owner: 'processo-nuovo',
          now: new Date(ADESSO.getTime() + LEASE_TTL_MS + 1),
        });
      }) as Handler,
    };

    const esito = await drainSyncRequests({ store: coda.store, handlers, clock: () => ADESSO });

    expect(esito.completed).toBe(0);
    expect(esito.errors.join(' ')).toContain('senza possesso');
    expect(errorSpy.mock.calls.map((c: any[]) => String(c[0])).join('\n')).toContain('ALLARME');

    // L'item resta di chi lo sta lavorando adesso, non chiuso da chi l'ha perso.
    const dopo = coda.trova('item-1');
    expect(dopo.status).toBe('processing');
    expect(dopo.leaseOwner).toBe('processo-nuovo');
  });

  /**
   * Il crash dopo la scrittura verso il merchant: il processo muore prima di
   * poter chiudere, l'item resta 'processing'. Alla scadenza del lease lo
   * riprende qualcun altro — con un gettone maggiore — e lo rifa'. Il rifacimento
   * e' idempotente perche' la sincronizzazione e' fatta di upsert.
   */
  it('un item abbandonato viene ripreso alla scadenza, con un gettone maggiore', async () => {
    const coda = codaInMemoria([
      riga({
        type: 'compliance-request',
        shopId: null,
        payload: { requestId: 'r1' },
        status: 'processing',
        leaseOwner: 'processo-morto',
        leaseExpiresAt: new Date(ADESSO.getTime() - 1),
        fencingToken: 4,
        attempts: 1,
      }),
    ]);
    const lavorato = vi.fn(async () => undefined);

    const esito = await drainSyncRequests({
      store: coda.store,
      handlers: { 'compliance-request': lavorato as Handler },
      clock: () => ADESSO,
    });

    expect(lavorato).toHaveBeenCalledTimes(1);
    expect(esito.completed).toBe(1);
    expect(coda.trova('item-1').fencingToken).toBe(5);
  });

  it('non prende un item il cui possesso e\' ancora valido', async () => {
    const coda = codaInMemoria([
      riga({
        type: 'compliance-request',
        shopId: null,
        status: 'processing',
        leaseOwner: 'chi-sta-lavorando',
        leaseExpiresAt: new Date(ADESSO.getTime() + LEASE_TTL_MS),
      }),
    ]);
    const lavorato = vi.fn(async () => undefined);

    const esito = await drainSyncRequests({
      store: coda.store,
      handlers: { 'compliance-request': lavorato as Handler },
      clock: () => ADESSO,
    });

    expect(esito.claimed).toBe(0);
    expect(lavorato).not.toHaveBeenCalled();
  });
});

describe('lo spegnimento', () => {
  /**
   * SIGTERM: un deploy, un riavvio, il worker locale che si ferma. Senza
   * ascoltarlo l'item resterebbe 'processing' fino alla scadenza del lease;
   * ascoltandolo lo si restituisce subito.
   */
  it('non prende nemmeno cio\' che non fara\'', async () => {
    const fuori = new AbortController();
    fuori.abort();

    const coda = codaInMemoria([
      riga({ id: 'a', type: 'compliance-request', shopId: null, payload: { requestId: 'r1' } }),
    ]);
    const lavorato = vi.fn(async () => undefined);

    const esito = await drainSyncRequests({
      store: coda.store,
      handlers: { 'compliance-request': lavorato as Handler },
      clock: () => ADESSO,
      signal: fuori.signal,
    });

    expect(lavorato).not.toHaveBeenCalled();
    expect(esito.claimed).toBe(0);
    // La riga e' come prima: nessun tentativo consumato, nessuna presa da
    // aspettare che scada.
    expect(coda.trova('a').status).toBe('queued');
    expect(coda.trova('a').attempts).toBe(0);
    expect(coda.trova('a').leaseOwner).toBeNull();
  });

  /**
   * Un'interruzione che arriva a meta' del lotto: quel che si e' gia' fatto
   * resta fatto, e non si prende altro.
   */
  it('si ferma a meta\' lotto senza lasciare item appesi', async () => {
    const fuori = new AbortController();
    const coda = codaInMemoria([
      riga({ id: 'a', type: 'compliance-request', shopId: null, payload: { requestId: 'r1' } }),
      riga({ id: 'b', type: 'compliance-request', shopId: null, payload: { requestId: 'r2' } }),
      riga({ id: 'c', type: 'compliance-request', shopId: null, payload: { requestId: 'r3' } }),
    ]);

    const handlers = {
      'compliance-request': (async (row: SyncRequestRow) => {
        if (row.id === 'a') fuori.abort();
      }) as Handler,
    };

    const esito = await drainSyncRequests({
      store: coda.store,
      handlers,
      clock: () => ADESSO,
      signal: fuori.signal,
    });

    expect(esito.claimed).toBe(1);
    expect(coda.trova('b').status).toBe('queued');
    expect(coda.trova('b').leaseOwner).toBeNull();
    expect(coda.trova('c').status).toBe('queued');
  });

  it('non lascia ascoltatori appesi su process a ogni giro', async () => {
    const coda = codaInMemoria([]);
    const prima = process.listenerCount('SIGTERM');
    for (let i = 0; i < 5; i++) await drainSyncRequests({ store: coda.store, clock: () => ADESSO });
    expect(process.listenerCount('SIGTERM')).toBe(prima);
  });
});

describe('il tetto di durata', () => {
  /**
   * Un lavoro senza tetto, su una funzione serverless, non finisce: lo stronca
   * la piattaforma a meta' di una scrittura, e non resta scritto niente da
   * nessuna parte. Interrompendosi da soli un istante prima, l'item torna in
   * coda con il suo motivo.
   */
  it('interrompe un lavoro che sfora, e non lo dichiara completato', async () => {
    vi.useFakeTimers();

    const coda = codaInMemoria([
      riga({ type: 'compliance-request', shopId: null, payload: { requestId: 'r1' } }),
    ]);

    const handlers = {
      'compliance-request': ((_row, ctx) =>
        new Promise<void>((risolvi) => {
          ctx.signal.addEventListener('abort', () => risolvi(), { once: true });
        })) as Handler,
    };

    const corsa = drainSyncRequests({ store: coda.store, handlers, clock: () => ADESSO });
    await vi.advanceTimersByTimeAsync(MAX_RUN_MS['compliance-request'] + 1_000);
    const esito = await corsa;

    expect(esito.completed).toBe(0);
    // Conta come tentativo e riparte distanziato: se non contasse, si
    // riproverebbe all'infinito senza mai avvicinarsi alla lettera morta.
    expect(esito.retried).toBe(1);
    expect(coda.trova('item-1').status).toBe('queued');
    expect(coda.trova('item-1').attempts).toBe(1);
    expect(coda.trova('item-1').nextAttemptAt.getTime()).toBeGreaterThan(ADESSO.getTime());
    expect(esito.errors.join(' ')).toContain('interrotto');

    vi.useRealTimers();
  });
});

describe('un tipo che nessuno sa lavorare', () => {
  /**
   * Prima il drenaggio faceva `continue` e l'item restava `waiting` per sempre:
   * una coda che accumula lavoro invisibile e' peggio di una che lo rifiuta.
   */
  it('finisce in lettera morta con un allarme, non resta in attesa', async () => {
    const coda = codaInMemoria([riga({ type: 'retry-failed-webhook' })]);

    const esito = await drainSyncRequests({ store: coda.store, clock: () => ADESSO });

    expect(esito.unknownType).toBe(1);
    expect(coda.trova('item-1').status).toBe('dead_letter');
    expect(errorSpy.mock.calls.map((c: any[]) => String(c[0])).join('\n')).toContain(
      'tipo sconosciuto',
    );
  });

  it('lo stesso vale per un lavoro di negozio a cui il negozio manca', async () => {
    const coda = codaInMemoria([riga({ type: 'manual-sync', shopId: null })]);

    await drainSyncRequests({ store: coda.store, clock: () => ADESSO });

    expect(coda.trova('item-1').status).toBe('dead_letter');
    expect(processManualSync).not.toHaveBeenCalled();
  });
});

describe('la corsia veloce', () => {
  it('drena la coda di un negozio solo', async () => {
    const coda = codaInMemoria([
      riga({ id: 'mio', type: 'manual-sync', shopId: 'shop-1' }),
      riga({ id: 'altrui', type: 'manual-sync', shopId: 'shop-2' }),
    ]);

    const esito = await drainSyncRequests({ store: coda.store, clock: () => ADESSO, shopId: 'shop-1' });

    expect(esito.claimed).toBe(1);
    expect(coda.trova('mio').status).toBe('completed');
    expect(coda.trova('altrui').status).toBe('queued');
  });
});

describe('un guasto su un item', () => {
  it('non ferma gli altri', async () => {
    const coda = codaInMemoria([
      riga({ id: 'a', type: 'compliance-request', shopId: null, payload: { requestId: 'r1' } }),
      riga({ id: 'b', type: 'compliance-request', shopId: null, payload: { requestId: 'r2' } }),
    ]);

    const handlers = {
      'compliance-request': (async (row: SyncRequestRow) => {
        if (row.id === 'a') throw new Error('questo negozio no');
      }) as Handler,
    };

    const esito = await drainSyncRequests({ store: coda.store, handlers, clock: () => ADESSO });

    expect(esito.retried).toBe(1);
    expect(esito.completed).toBe(1);
    expect(coda.trova('b').status).toBe('completed');
  });
});
