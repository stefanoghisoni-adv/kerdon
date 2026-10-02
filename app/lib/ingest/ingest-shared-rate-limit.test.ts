import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  INGEST_SHARED_LIMIT_PER_WINDOW,
  INGEST_SHARED_WINDOW_SECONDS,
  INGEST_BUCKET_CAPACITY,
  INGEST_BUCKET_REFILL_PER_SEC,
} from './ingest-model';
import {
  sharedIngestKey,
  takeSharedIngestSlot,
  type SharedCounter,
} from './ingest-shared-rate-limit.server';

/**
 * Un contatore condiviso finto: e' quello che Redis fa con INCR + EXPIRE, e
 * qui conta come lo conterebbe lui — per chiave, a prescindere da quale
 * istanza chiami. Due "istanze" sono due chiamate con lo stesso contatore.
 */
function contatore(): SharedCounter & { counts: Map<string, number>; ttls: Map<string, number> } {
  const counts = new Map<string, number>();
  const ttls = new Map<string, number>();
  return {
    counts,
    ttls,
    async increment(key, ttlSeconds) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      ttls.set(key, ttlSeconds);
      return next;
    },
  };
}

const ORA = 1_700_000_000_000;

let warned: string[];
beforeEach(() => {
  warned = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warned.push(a.join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('il tetto condiviso fra le istanze', () => {
  it('discende dalle costanti del secchiello locale, non e un numero a parte', () => {
    // Il regime e' lo stesso (40 al secondo), la raffica pure (300): il tetto
    // condiviso e' cio' che il secchiello di UNA istanza lascerebbe passare in
    // una finestra. Con N istanze, adesso, il tetto vero resta quello.
    expect(INGEST_SHARED_LIMIT_PER_WINDOW).toBe(
      INGEST_BUCKET_CAPACITY + INGEST_BUCKET_REFILL_PER_SEC * INGEST_SHARED_WINDOW_SECONDS,
    );
  });

  it('sotto il tetto passa, sopra riceve un no con l attesa fino alla finestra dopo', async () => {
    const redis = contatore();
    const params = { shopId: 's1', keyId: 'k1', now: ORA };

    for (let i = 0; i < INGEST_SHARED_LIMIT_PER_WINDOW; i++) {
      expect((await takeSharedIngestSlot(params, redis)).allowed).toBe(true);
    }
    const oltre = await takeSharedIngestSlot(params, redis);

    expect(oltre.allowed).toBe(false);
    expect(oltre.bucket).toBe('shared');
    expect(oltre.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(oltre.retryAfterSeconds).toBeLessThanOrEqual(INGEST_SHARED_WINDOW_SECONDS);
  });

  it('due istanze contano insieme: il tetto non si moltiplica', async () => {
    // Il difetto dell'audit: con il secchiello in memoria ogni istanza aveva il
    // suo, e il tetto vero era N volte quello scritto.
    const redis = contatore();
    const params = { shopId: 's1', keyId: 'k1', now: ORA };
    const meta = INGEST_SHARED_LIMIT_PER_WINDOW / 2;

    for (let i = 0; i < meta; i++) await takeSharedIngestSlot(params, redis); // istanza A
    for (let i = 0; i < meta; i++) await takeSharedIngestSlot(params, redis); // istanza B

    expect((await takeSharedIngestSlot(params, redis)).allowed).toBe(false);
  });

  it('la finestra dopo riparte da zero, e la chiave scade da sola', async () => {
    const redis = contatore();
    for (let i = 0; i <= INGEST_SHARED_LIMIT_PER_WINDOW; i++) {
      await takeSharedIngestSlot({ shopId: 's1', keyId: 'k1', now: ORA }, redis);
    }

    const dopo = await takeSharedIngestSlot(
      { shopId: 's1', keyId: 'k1', now: ORA + INGEST_SHARED_WINDOW_SECONDS * 1000 },
      redis,
    );

    expect(dopo.allowed).toBe(true);
    // Nessuna chiave resta per sempre: due finestre di vita bastano.
    for (const ttl of redis.ttls.values()) expect(ttl).toBe(INGEST_SHARED_WINDOW_SECONDS * 2);
  });

  it('negozi e credenziali diverse hanno contatori diversi', async () => {
    expect(sharedIngestKey('s1', 'k1', ORA)).not.toBe(sharedIngestKey('s2', 'k1', ORA));
    expect(sharedIngestKey('s1', 'k1', ORA)).not.toBe(sharedIngestKey('s1', 'k2', ORA));
    // Nessun indirizzo IP e nessun identificativo del visitatore nella chiave.
    expect(sharedIngestKey('s1', 'k1', ORA)).toMatch(/^ingest:rl:s1:k1:\d+$/);
  });
});

describe('quando il contatore condiviso non risponde', () => {
  it('senza Redis configurato si passa: resta il secchiello locale', async () => {
    const esito = await takeSharedIngestSlot({ shopId: 's1', keyId: 'k1', now: ORA }, null);
    expect(esito).toMatchObject({ allowed: true, bucket: 'none' });
  });

  it('un errore di Redis lascia passare, e lo dice nel log una volta', async () => {
    // Rifiutare tutto vorrebbe dire che un guasto dell'archivio spegne il
    // tracciamento di tutti i negozi. Il secchiello locale resta comunque.
    const rotto: SharedCounter = {
      increment: async () => {
        throw new Error('ECONNRESET');
      },
    };

    const primo = await takeSharedIngestSlot({ shopId: 's1', keyId: 'k1', now: ORA }, rotto);
    const secondo = await takeSharedIngestSlot({ shopId: 's1', keyId: 'k1', now: ORA + 1 }, rotto);

    expect(primo.allowed).toBe(true);
    expect(secondo.allowed).toBe(true);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('ECONNRESET');
  });

  it('un Redis lento non tiene ferma la richiesta', async () => {
    const lento: SharedCounter = {
      increment: () => new Promise<number>(() => undefined),
    };

    const iniziato = Date.now();
    const esito = await takeSharedIngestSlot({ shopId: 's1', keyId: 'k1', now: ORA + 120_000 }, lento);

    expect(esito.allowed).toBe(true);
    expect(Date.now() - iniziato).toBeLessThan(1_000);
  });
});
