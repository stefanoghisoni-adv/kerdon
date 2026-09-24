// app/lib/supabase/auto-resume-setting.server.test.ts
//
// Il caso per cui questo modulo esiste: la tabella non c'e' ancora.
//
// La migrazione la esegue una persona, a mano, su Live e su Test, e fra il
// rilascio del codice e quel momento passa del tempo. In quella finestra ogni
// lettura qui dentro fallisce, e cio' che succede dopo decide se l'app resta in
// piedi o se comincia a riaccendere database senza aver mai chiesto niente a
// nessuno.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const findMany = vi.fn();
const upsert = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    supabaseAutoResume: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      findMany: (...a: unknown[]) => findMany(...a),
      upsert: (...a: unknown[]) => upsert(...a),
    },
  },
}));

import {
  noteAutoResumeChecked,
  readAutoResumeSetting,
  readAutoResumeSettings,
  setAutoResumeEnabled,
} from './auto-resume-setting.server';

/** L'errore che Prisma solleva quando la tabella non esiste nel database. */
function tabellaMancante(): Error & { code: string } {
  const e = new Error(
    'The table `public.supabase_auto_resume` does not exist in the current database.',
  ) as Error & { code: string };
  e.code = 'P2021';
  return e;
}

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({});
});

describe('quando la tabella non c e ancora', () => {
  it('la lettura risponde null, non "acceso"', async () => {
    // E' la differenza che tiene ferma l'app: `null` significa "non sappiamo se
    // il merchant ci abbia detto di no", e chi decide lo tratta come un no.
    findUnique.mockRejectedValue(tabellaMancante());

    await expect(readAutoResumeSetting('shop-1')).resolves.toBeNull();
  });

  it('la lettura di gruppo risponde null e non una mappa vuota', async () => {
    // Una mappa vuota vorrebbe dire "nessuno ha scelto", che il giro del cron
    // leggerebbe come "acceso per tutti": l'esatto contrario.
    findMany.mockRejectedValue(tabellaMancante());

    await expect(readAutoResumeSettings(['shop-1'])).resolves.toBeNull();
  });

  it('il salvataggio dice di non essere riuscito invece di fingere', async () => {
    // Far credere a un merchant che il suo "non toccare il mio database" sia
    // stato registrato e' il peggiore degli esiti possibili.
    upsert.mockRejectedValue(tabellaMancante());

    await expect(setAutoResumeEnabled('shop-1', false)).resolves.toBe(false);
  });

  it('la memoria dei tentativi non esplode e non ferma il cron', async () => {
    upsert.mockRejectedValue(tabellaMancante());

    await expect(noteAutoResumeChecked('shop-1', new Date())).resolves.toBeUndefined();
  });
});

describe('quando la tabella c e', () => {
  it('una riga che non esiste vale "mai scelto", che e diverso da "non configurato"', async () => {
    // Tabella presente e nessuna riga: il merchant semplicemente non ha mai
    // aperto le Impostazioni. Vale il comportamento dichiarato dell'app.
    findUnique.mockResolvedValue(null);

    await expect(readAutoResumeSetting('shop-1')).resolves.toEqual({
      enabled: null,
      lastAttemptAt: null,
      attempts: 0,
    });
  });

  it('la scelta del merchant torna com e scritta', async () => {
    findUnique.mockResolvedValue({ enabled: false, lastAttemptAt: null, attempts: 3 });

    await expect(readAutoResumeSetting('shop-1')).resolves.toEqual({
      enabled: false,
      lastAttemptAt: null,
      attempts: 3,
    });
  });

  it('i negozi senza riga entrano lo stesso nella mappa', async () => {
    // Il giro del cron chiede le scelte di tutti in una lettura sola: chi non
    // ha mai scelto deve comunque comparire, altrimenti sparirebbe dal giro.
    findMany.mockResolvedValue([{ shopId: 'shop-2', enabled: false, lastAttemptAt: null, attempts: 0 }]);

    const mappa = await readAutoResumeSettings(['shop-1', 'shop-2']);

    expect(mappa?.get('shop-1')).toEqual({ enabled: null, lastAttemptAt: null, attempts: 0 });
    expect(mappa?.get('shop-2')?.enabled).toBe(false);
  });

  it('salva la scelta e lo conferma', async () => {
    await expect(setAutoResumeEnabled('shop-1', false)).resolves.toBe(true);
    expect(upsert).toHaveBeenCalledWith({
      where: { shopId: 'shop-1' },
      create: { shopId: 'shop-1', enabled: false },
      update: { enabled: false },
    });
  });
});
