import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('~/db.server', () => ({
  prisma: { syncJob: { create: vi.fn() } },
}));

import { prisma } from '~/db.server';
import {
  recordGdprOutcome,
  saveGdprOutcome,
  tryRecordGdprOutcome,
  trySaveGdprOutcome,
} from './audit.server';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * La traccia durevole, e cosa succede quando non si riesce a scriverla.
 *
 * IL GUASTO CHE QUESTE PROVE ESCLUDONO. La scrittura stava dentro un `catch`
 * che scriveva un `console.error` e lasciava proseguire, con la motivazione
 * accanto: "resta il log applicativo, che e' esattamente il motivo per cui i
 * due canali esistono entrambi". Ma i due canali non sono equivalenti: uno e'
 * una riga in un registro che si conserva, l'altro e' testo in un log a
 * ritenzione breve che nessuno indicizza. Una richiesta di cancellazione
 * dichiarata eseguita la cui unica prova e' un `console.log` e', davanti a chi
 * la chiede, una richiesta non eseguita.
 */

const SHOP = 'negozio.myshopify.com';

const esito = {
  jobType: 'gdpr_redact' as const,
  shopDomain: SHOP,
  steps: [{ table: 'customers', outcome: 'deleted' as const, rows: 1 }],
};

let errorSpy: any;
let logSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.syncJob.create as any).mockResolvedValue({});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe('scrivere la traccia', () => {
  it('la scrive con lo stato che i passi dichiarano', async () => {
    await recordGdprOutcome('shop-1', esito);

    const data = (prisma.syncJob.create as any).mock.calls[0][0].data;
    expect(data.shopId).toBe('shop-1');
    expect(data.status).toBe('completed');
  });

  it('un passo fallito basta a marcare fallita tutta la richiesta', async () => {
    await recordGdprOutcome('shop-1', {
      ...esito,
      steps: [{ table: 'customers', outcome: 'failed', rows: 0, detail: 'timeout' }],
    });

    expect((prisma.syncJob.create as any).mock.calls[0][0].data.status).toBe('failed');
  });

  /**
   * LA RIGA CHE CAMBIA TUTTO. Prima qui c'era un `catch` che inghiottiva
   * l'errore: chi chiamava proseguiva e chiudeva la pratica.
   */
  it('se non riesce a scrivere, solleva', async () => {
    (prisma.syncJob.create as any).mockRejectedValue(new Error('registro non raggiungibile'));

    await expect(recordGdprOutcome('shop-1', esito)).rejects.toThrow(
      'registro non raggiungibile',
    );
  });

  it('saveGdprOutcome propaga: chi non ha la prova non chiude la pratica', async () => {
    (prisma.syncJob.create as any).mockRejectedValue(new Error('registro non raggiungibile'));

    await expect(saveGdprOutcome('shop-1', esito)).rejects.toThrow();
    // Il `console` resta, e resta utile: e' un di piu', mai un sostituto.
    expect(logSpy.mock.calls.flat().join(' ')).toContain('[gdpr]');
  });

  /**
   * `shopId` a null non e' una scappatoia: e' `shop/redact` riuscita, dove il
   * negozio non esiste piu' e la prova sta in `shop_erasure_proofs` — un
   * registro senza chiavi esterne verso `shops`, che al negozio sopravvive.
   */
  it('senza negozio non c e nessuna riga da scrivere, e non e un errore', async () => {
    await expect(saveGdprOutcome(null, esito)).resolves.toBeUndefined();
    expect(prisma.syncJob.create).not.toHaveBeenCalled();
  });
});

describe('la variante che non solleva, per il solo percorso d errore', () => {
  it('inghiotte e segnala, invece di coprire l errore vero', async () => {
    (prisma.syncJob.create as any).mockRejectedValue(new Error('registro non raggiungibile'));

    await expect(tryRecordGdprOutcome('shop-1', esito)).resolves.toBeUndefined();
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('traccia non salvata');
  });

  it('trySave fa lo stesso, e logga comunque', async () => {
    (prisma.syncJob.create as any).mockRejectedValue(new Error('registro non raggiungibile'));

    await expect(trySaveGdprOutcome('shop-1', esito)).resolves.toBeUndefined();
    expect(logSpy.mock.calls.flat().join(' ')).toContain('[gdpr]');
  });
});
