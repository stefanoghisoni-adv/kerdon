// app/lib/shipping/recompute-inline.server.test.ts
//
// Il ricalcolo dentro il salvataggio. La richiesta dell'utente: "quando
// aggiungiamo un prezzo si aggiornino gia' i calcoli che leggero' in dashboard
// e clienti, senza dover attendere la sincronizzazione". Queste prove fissano
// le tre strade: finito nel budget (niente coda), budget superato (continua in
// coda), guasto (il salvataggio resta riuscito e il ricalcolo va in coda).

import { describe, it as prova, expect, vi, beforeEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

vi.mock('./recompute.server', () => ({ processLogisticsRecompute: vi.fn() }));
vi.mock('./recompute-enqueue.server', () => ({ enqueueLogisticsRecompute: vi.fn() }));
vi.mock('~/lib/queue/shop-lock.server', () => ({ runWithShopLease: vi.fn() }));

import { processLogisticsRecompute } from './recompute.server';
import { enqueueLogisticsRecompute } from './recompute-enqueue.server';
import { runWithShopLease } from '~/lib/queue/shop-lock.server';
import {
  INLINE_RECOMPUTE_BUDGET_MS,
  INLINE_RECOMPUTE_MAX_RUN_MS,
  recomputeLogisticsAfterSave,
} from './recompute-inline.server';

const leaseFinto = { assertHeld: vi.fn(), signal: new AbortController().signal };

beforeEach(() => {
  vi.clearAllMocks();
  // Il lucchetto libero: esegue il lavoro e dice 'eseguito', come quello vero.
  (runWithShopLease as any).mockImplementation(async (_shop: string, run: any) => {
    await run(leaseFinto);
    return 'eseguito';
  });
  (enqueueLogisticsRecompute as any).mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('recomputeLogisticsAfterSave', () => {
  prova('finito dentro il budget: numeri aggiornati e nessun job accodato', async () => {
    (processLogisticsRecompute as any).mockResolvedValue('completed');

    await expect(recomputeLogisticsAfterSave('shop-1')).resolves.toBe('updated');

    expect(enqueueLogisticsRecompute).not.toHaveBeenCalled();
    // La stessa funzione del job, con il budget corto della richiesta, il
    // possesso del negozio e un id di corsa per la chiave della continuazione.
    const [shop, ctx] = (processLogisticsRecompute as any).mock.calls[0];
    expect(shop).toBe('shop-1');
    expect(ctx.budgetMs).toBe(INLINE_RECOMPUTE_BUDGET_MS);
    expect(ctx.lease).toBe(leaseFinto);
    expect(ctx.signal).toBe(leaseFinto.signal);
    expect(ctx.jobId).toMatch(/^in-linea:/);
    // Il tetto del lucchetto stacca una corsa che si incastra a meta' pagina.
    expect((runWithShopLease as any).mock.calls[0][2]).toMatchObject({ maxRunMs: INLINE_RECOMPUTE_MAX_RUN_MS });
  });

  prova('il budget sta ben dentro la durata di una funzione Vercel', () => {
    expect(INLINE_RECOMPUTE_BUDGET_MS).toBeLessThanOrEqual(15_000);
    expect(INLINE_RECOMPUTE_MAX_RUN_MS).toBeGreaterThan(INLINE_RECOMPUTE_BUDGET_MS);
    expect(INLINE_RECOMPUTE_MAX_RUN_MS).toBeLessThanOrEqual(60_000);
  });

  prova('budget superato: la continuazione e\' gia\' in coda, i numeri arrivano a breve', async () => {
    (processLogisticsRecompute as any).mockResolvedValue('continued');

    await expect(recomputeLogisticsAfterSave('shop-1')).resolves.toBe('pending');

    // La continuazione la accoda la funzione a pagine stessa, dal suo cursore:
    // un ricalcolo da zero in piu' rifarebbe le pagine gia' scritte.
    expect(enqueueLogisticsRecompute).not.toHaveBeenCalled();
  });

  prova('errore del ricalcolo: non solleva, accoda il ricalcolo e dice "a breve"', async () => {
    (processLogisticsRecompute as any).mockRejectedValue(new Error('Management API 500'));

    await expect(recomputeLogisticsAfterSave('shop-1')).resolves.toBe('pending');

    expect(enqueueLogisticsRecompute).toHaveBeenCalledWith('shop-1');
  });

  prova('anche un guasto del lucchetto stesso ripiega sulla coda', async () => {
    (runWithShopLease as any).mockRejectedValue(new Error('owner db giu\''));

    await expect(recomputeLogisticsAfterSave('shop-1')).resolves.toBe('pending');
    expect(enqueueLogisticsRecompute).toHaveBeenCalledWith('shop-1');
  });

  prova('negozio occupato da una sincronizzazione o da un ricalcolo: si accoda dopo di lui', async () => {
    (runWithShopLease as any).mockResolvedValue('occupato');

    await expect(recomputeLogisticsAfterSave('shop-1')).resolves.toBe('pending');
    expect(processLogisticsRecompute).not.toHaveBeenCalled();
    expect(enqueueLogisticsRecompute).toHaveBeenCalledWith('shop-1');
  });

  prova('lucchetto non disponibile: si accoda', async () => {
    (runWithShopLease as any).mockResolvedValue('non-disponibile');

    await expect(recomputeLogisticsAfterSave('shop-1')).resolves.toBe('pending');
    expect(enqueueLogisticsRecompute).toHaveBeenCalledWith('shop-1');
  });

  prova('niente da ricalcolare adesso (database fermo, niente ordini): nessuna promessa sui numeri, ma la coda riprova', async () => {
    (processLogisticsRecompute as any).mockResolvedValue('skipped');

    await expect(recomputeLogisticsAfterSave('shop-1')).resolves.toBeNull();
    // Come prima di questo cambio: il job ricontrolla quando parte (lo schema
    // puo' essersi allineato, il database riacceso).
    expect(enqueueLogisticsRecompute).toHaveBeenCalledWith('shop-1');
  });

  prova('il budget e l orologio si possono iniettare', async () => {
    (processLogisticsRecompute as any).mockResolvedValue('completed');
    const clock = () => 0;

    await recomputeLogisticsAfterSave('shop-1', { budgetMs: 5, clock });

    expect((processLogisticsRecompute as any).mock.calls[0][1]).toMatchObject({ budgetMs: 5, clock });
  });
});
