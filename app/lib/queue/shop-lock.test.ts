import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('~/db.server', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    shopLock: {
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from '~/db.server';
import {
  pruneExpiredShopLocks,
  runWithShopLease,
  withShopSyncLock,
} from './shop-lock.server';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Il lucchetto per negozio.
 *
 * Quello che difende: la corsa completa, alla fine, spazza dal database del
 * merchant le righe con `synced_at` anteriore al proprio inizio. Due corse
 * sovrapposte hanno due istanti d'inizio diversi, e la piu' vecchia porta via
 * le righe che la piu' recente ha appena scritto — senza errori, e con il
 * risultato che si vede solo dopo, come prodotti mancanti.
 *
 * La prova piu' importante di questo file e' quella che prima falliva per
 * progetto: con il backend del lucchetto irraggiungibile NON si esegue niente.
 * La versione su Redis, in quel caso, proseguiva senza lucchetto — e lo faceva
 * apposta.
 */

let errorSpy: any;

function preso(fencingToken = 1) {
  (prisma.$queryRaw as any).mockResolvedValue([{ fencing_token: fencingToken }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  preso();
  (prisma.shopLock.updateMany as any).mockResolvedValue({ count: 1 });
  (prisma.shopLock.deleteMany as any).mockResolvedValue({ count: 1 });
  (prisma.shopLock.findFirst as any).mockResolvedValue({ shopId: 'shop-1' });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.useRealTimers();
});

describe('prendere il lucchetto', () => {
  it('esegue il lavoro quando il negozio e\' libero', async () => {
    const lavoro = vi.fn(async () => undefined);
    expect(await runWithShopLease('shop-1', lavoro)).toBe('eseguito');
    expect(lavoro).toHaveBeenCalledTimes(1);
  });

  /**
   * Zero righe dall'inserimento significa che la riga c'e' gia' e non e'
   * scaduta: qualcun altro sta lavorando su quel negozio. Non e' un errore —
   * e' il risultato voluto.
   */
  it('non esegue niente quando il negozio e\' occupato', async () => {
    (prisma.$queryRaw as any).mockResolvedValue([]);
    const lavoro = vi.fn(async () => undefined);
    expect(await runWithShopLease('shop-1', lavoro)).toBe('occupato');
    expect(lavoro).not.toHaveBeenCalled();
  });

  /**
   * IL CASO CHE PRIMA ANDAVA AL CONTRARIO.
   *
   * Con Redis irraggiungibile il codice vecchio scriveva "si procede senza
   * lucchetto" e proseguiva, motivandolo cosi': "un negozio che non si
   * sincronizza e' un guasto certo, due corse sovrapposte sono un rischio". Il
   * paragone e' sbagliato nel modo piu' costoso: pesa una sincronizzazione
   * rimandata contro delle righe cancellate nel database di un merchant.
   */
  it('NON esegue niente quando il lucchetto non e\' raggiungibile', async () => {
    (prisma.$queryRaw as any).mockRejectedValue(new Error('database irraggiungibile'));
    const lavoro = vi.fn(async () => undefined);

    expect(await runWithShopLease('shop-1', lavoro)).toBe('non-disponibile');
    expect(lavoro).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls[0][0]).toContain('ALLARME');
  });

  it('la forma booleana dice di no sia se occupato sia se irraggiungibile', async () => {
    (prisma.$queryRaw as any).mockResolvedValue([]);
    expect(await withShopSyncLock('shop-1', async () => undefined)).toBe(false);

    (prisma.$queryRaw as any).mockRejectedValue(new Error('giu'));
    expect(await withShopSyncLock('shop-1', async () => undefined)).toBe(false);
  });

  it('non parte se l\'interruzione e\' gia\' arrivata', async () => {
    const fuori = new AbortController();
    fuori.abort();
    const lavoro = vi.fn(async () => undefined);

    expect(await runWithShopLease('shop-1', lavoro, { signal: fuori.signal })).toBe(
      'non-disponibile',
    );
    expect(lavoro).not.toHaveBeenCalled();
  });
});

describe('rilasciare il lucchetto', () => {
  it('lo rilascia anche se il lavoro lancia', async () => {
    await expect(
      runWithShopLease('shop-1', async () => {
        throw new Error('sincronizzazione fallita');
      }),
    ).rejects.toThrow('sincronizzazione fallita');

    expect(prisma.shopLock.deleteMany).toHaveBeenCalledTimes(1);
  });

  /**
   * Il rilascio e' condizionato al gettone: se il lucchetto nel frattempo e'
   * passato a qualcun altro, la DELETE tocca zero righe. Rilasciare per id e
   * basta vorrebbe dire aprire il lucchetto di chi sta lavorando adesso.
   */
  it('rilascia solo il proprio, non quello di chi e\' subentrato', async () => {
    preso(9);
    await runWithShopLease('shop-1', async () => undefined);

    const dove = (prisma.shopLock.deleteMany as any).mock.calls[0][0].where;
    expect(dove.shopId).toBe('shop-1');
    expect(dove.fencingToken).toBe(9);
    expect(typeof dove.owner).toBe('string');
  });

  it('un rilascio che fallisce non nasconde l\'errore del lavoro', async () => {
    (prisma.shopLock.deleteMany as any).mockRejectedValue(new Error('rete'));
    await expect(
      runWithShopLease('shop-1', async () => {
        throw new Error('errore vero');
      }),
    ).rejects.toThrow('errore vero');
  });
});

describe('il battito del cuore', () => {
  /**
   * Un lavoro piu' lungo della scadenza deve tenere il lucchetto. E' quello che
   * permette di tenere la scadenza corta (un minuto invece di dieci): quando
   * un'invocazione muore davvero, il negozio si libera in fretta — ma finche'
   * lavora, non se lo fa togliere da sotto i piedi.
   */
  it('tiene il lucchetto per un lavoro piu\' lungo della scadenza', async () => {
    vi.useFakeTimers();

    let finisci!: () => void;
    const lavoro = new Promise<void>((risolvi) => {
      finisci = risolvi;
    });

    const corsa = runWithShopLease('shop-1', () => lavoro, {
      ttlMs: 3_000,
      heartbeatMs: 1_000,
    });

    // Quattro volte la scadenza, senza mai rilasciare.
    await vi.advanceTimersByTimeAsync(12_000);
    expect((prisma.shopLock.updateMany as any).mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(prisma.shopLock.deleteMany).not.toHaveBeenCalled();

    finisci();
    expect(await corsa).toBe('eseguito');
  });

  it('il rinnovo porta proprietario e gettone', async () => {
    vi.useFakeTimers();
    preso(4);

    let finisci!: () => void;
    const lavoro = new Promise<void>((risolvi) => {
      finisci = risolvi;
    });
    const corsa = runWithShopLease('shop-1', () => lavoro, { ttlMs: 3_000, heartbeatMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_500);
    expect((prisma.shopLock.updateMany as any).mock.calls[0][0].where).toMatchObject({
      shopId: 'shop-1',
      fencingToken: 4,
    });

    finisci();
    await corsa;
  });

  /**
   * Se il rinnovo tocca zero righe il lucchetto e' di qualcun altro: non e' un
   * singhiozzo di rete da riprovare, e' la notizia che il lavoro in corso non
   * ha piu' titolo per scrivere.
   */
  it('interrompe il lavoro quando il lucchetto e\' stato ripreso', async () => {
    vi.useFakeTimers();
    (prisma.shopLock.updateMany as any).mockResolvedValue({ count: 0 });

    let visto: AbortSignal | undefined;
    const corsa = runWithShopLease(
      'shop-1',
      async (lease) => {
        visto = lease.signal;
        await new Promise<void>((risolvi) => setTimeout(risolvi, 5_000));
      },
      { ttlMs: 3_000, heartbeatMs: 1_000 },
    );

    await vi.advanceTimersByTimeAsync(1_100);
    expect(visto?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    await corsa;
  });
});

describe('la verifica prima di cancellare', () => {
  /**
   * `assertHeld` e' quello che i processor chiamano un istante prima della
   * spazzata. Il caso che copre e' preciso: la nostra corsa e' stata lenta, il
   * lease e' scaduto, un'altra corsa e' partita e sta riscrivendo le righe — e
   * noi stavamo per portare via tutto quello che lei ha appena scritto.
   */
  it('lascia passare la scrittura quando il lucchetto e\' ancora nostro', async () => {
    await runWithShopLease('shop-1', async (lease) => {
      await expect(lease.assertHeld()).resolves.toBeUndefined();
    });
  });

  it('ferma la scrittura quando il lucchetto non e\' piu\' nostro', async () => {
    (prisma.shopLock.findFirst as any).mockResolvedValue(null);

    await expect(
      runWithShopLease('shop-1', async (lease) => {
        await lease.assertHeld();
      }),
    ).rejects.toThrow(/non piu' posseduto/);
  });

  it('la verifica chiede al database solo il lucchetto proprio e non scaduto', async () => {
    preso(6);
    await runWithShopLease('shop-1', async (lease) => {
      await lease.assertHeld();
    });

    const dove = (prisma.shopLock.findFirst as any).mock.calls[0][0].where;
    expect(dove).toMatchObject({ shopId: 'shop-1', fencingToken: 6 });
    expect(dove.expiresAt.gt).toBeInstanceOf(Date);
  });

  /**
   * La riconciliazione cancella una volta per prodotto: una query di verifica
   * ciascuna sarebbe un secondo database interrogato quanto quello che stiamo
   * sincronizzando. Entro la finestra ci si fida dello stato che il battito
   * tiene aggiornato.
   */
  it('non interroga il database a ogni verifica ravvicinata', async () => {
    await runWithShopLease('shop-1', async (lease) => {
      for (let i = 0; i < 20; i++) await lease.assertHeld();
    });
    expect((prisma.shopLock.findFirst as any).mock.calls.length).toBe(1);
  });

  it('rifiuta subito, senza interrogare, se il possesso e\' gia\' perduto', async () => {
    const fuori = new AbortController();

    await expect(
      runWithShopLease(
        'shop-1',
        async (lease) => {
          fuori.abort();
          // Un istante perche' l'interruzione arrivi.
          await Promise.resolve();
          await lease.assertHeld();
        },
        { signal: fuori.signal },
      ),
    ).rejects.toThrow(/non piu' posseduto/);
  });
});

describe('il tetto di durata', () => {
  it('interrompe un lavoro che sfora', async () => {
    vi.useFakeTimers();

    let visto: AbortSignal | undefined;
    const corsa = runWithShopLease(
      'shop-1',
      async (lease) => {
        visto = lease.signal;
        await new Promise<void>((risolvi) => setTimeout(risolvi, 10_000));
      },
      { maxRunMs: 2_000, heartbeatMs: 500, ttlMs: 5_000 },
    );

    await vi.advanceTimersByTimeAsync(2_500);
    expect(visto?.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    await corsa;
  });
});

describe('la potatura', () => {
  it('toglie solo i lucchetti scaduti da un pezzo', async () => {
    (prisma.shopLock.deleteMany as any).mockResolvedValue({ count: 3 });
    const adesso = new Date('2026-09-05T10:00:00.000Z');

    expect(await pruneExpiredShopLocks(adesso)).toBe(3);
    const dove = (prisma.shopLock.deleteMany as any).mock.calls[0][0].where;
    expect(dove.expiresAt.lt.getTime()).toBeLessThan(adesso.getTime());
  });
});
