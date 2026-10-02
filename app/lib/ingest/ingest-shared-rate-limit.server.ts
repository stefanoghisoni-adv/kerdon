// app/lib/ingest/ingest-shared-rate-limit.server.ts
//
// Il tetto delle scritture CONDIVISO fra tutte le istanze.
//
// PERCHE' ADESSO C'E'. Il secchiello in `ingest-rate-limit.server` vive nella
// memoria di una istanza, e su Vercel le istanze sono tante quante ne chiede il
// traffico: il tetto vero era N volte quello scritto, con N che nessuno
// controlla. Qui il conto si fa in un posto solo, su Redis, che l'app ha gia'
// per la coda.
//
// IL SECCHIELLO LOCALE RESTA, e viene PRIMA. E' gratis — niente rete — e
// ferma da solo la raffica che arriva a una istanza: chi supera la quota li'
// non paga nemmeno il viaggio fino a Redis. Questo contatore serve per il
// caso che il locale non vede, cioe' la stessa credenziale distribuita su
// molte istanze.
//
// SE REDIS NON RISPONDE SI PASSA. L'obiezione che stava scritta nel file del
// secchiello locale resta vera: un contatore condiviso che, quando cade,
// rifiuta tutto spegne il tracciamento di tutti i negozi per un guasto che non
// e' loro. Si lascia passare, si scrive una riga di log (una al minuto, non
// una a richiesta), e il secchiello locale continua a valere. Il tempo
// concesso a Redis e' corto apposta: questa e' la rotta di ogni visita.
//
// LA CHIAVE NON PORTA NESSUN DATO DI NESSUNO: il negozio, l'identificativo
// pubblico della credenziale e il numero della finestra. Niente indirizzo IP,
// niente identificativo del visitatore.

import type Redis from 'ioredis';
import { redisConnectionOptions } from '../queue/connection.server';
import { INGEST_SHARED_LIMIT_PER_WINDOW, INGEST_SHARED_WINDOW_SECONDS } from './ingest-model';
import type { RateDecision } from './ingest-rate-limit.server';

/** Un contatore atomico con scadenza: e' tutto quello che serve da Redis. */
export interface SharedCounter {
  /** Incrementa e restituisce il valore dopo l'incremento; la chiave scade da sola. */
  increment(key: string, ttlSeconds: number): Promise<number>;
}

/** Quanto si concede a Redis prima di lasciar passare. */
const TIMEOUT_MS = 250;

/** Ogni quanto, al massimo, si scrive che il contatore non risponde. */
const WARN_EVERY_MS = 60_000;
let lastWarnAt = Number.NEGATIVE_INFINITY;

export function sharedIngestKey(shopId: string, keyId: string, nowMs: number): string {
  const window = Math.floor(nowMs / (INGEST_SHARED_WINDOW_SECONDS * 1000));
  return `ingest:rl:${shopId}:${keyId}:${window}`;
}

const PASSA: RateDecision = { allowed: true, retryAfterSeconds: 0, bucket: 'none' };

/**
 * Un posto nella finestra condivisa per questa scrittura.
 *
 * `counter` e' `null` quando Redis non e' configurato (sviluppo, test): il
 * limite condiviso non si applica, e resta quello locale.
 */
export async function takeSharedIngestSlot(
  params: { shopId: string; keyId: string; now?: number },
  counter: SharedCounter | null = defaultCounter(),
): Promise<RateDecision> {
  if (!counter) return PASSA;

  const now = params.now ?? Date.now();
  const windowMs = INGEST_SHARED_WINDOW_SECONDS * 1000;

  let count: number | 'timeout';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    count = await Promise.race([
      counter.increment(
        sharedIngestKey(params.shopId, params.keyId, now),
        // Due finestre e non una: la chiave della finestra corrente non deve
        // sparire mentre e' ancora in uso per un orologio un po' avanti.
        INGEST_SHARED_WINDOW_SECONDS * 2,
      ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    warnUnavailable(now, error instanceof Error ? error.message : 'errore sconosciuto');
    return PASSA;
  } finally {
    clearTimeout(timer);
  }

  if (count === 'timeout') {
    warnUnavailable(now, `nessuna risposta entro ${TIMEOUT_MS} ms`);
    return PASSA;
  }

  if (count <= INGEST_SHARED_LIMIT_PER_WINDOW) return PASSA;

  // Fino all'inizio della finestra dopo, arrotondato per eccesso: un
  // `Retry-After` di zero direbbe di riprovare subito, e subito e' ancora no.
  const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
  return { allowed: false, retryAfterSeconds, bucket: 'shared' };
}

function warnUnavailable(now: number, detail: string): void {
  if (now - lastWarnAt < WARN_EVERY_MS) return;
  lastWarnAt = now;
  console.warn(`[ingest] limite condiviso non disponibile, resta quello locale: ${detail}`);
}

/* -------------------------------------------------------------------------- */
/* Redis                                                                       */
/* -------------------------------------------------------------------------- */

// Import dinamico per la stessa ragione di `stats-cache.server.ts`: il build
// server e' un bundle unico, e uno statico caricherebbe ioredis a ogni cold
// start anche sulle rotte che non lo usano.
let clientPromise: Promise<Redis> | null = null;

function getClient(): Promise<Redis> {
  if (!clientPromise) {
    clientPromise = import('ioredis').then(
      ({ default: RedisClient }) =>
        new RedisClient({ ...redisConnectionOptions(), maxRetriesPerRequest: 1 }),
    );
  }
  return clientPromise;
}

const redisCounter: SharedCounter = {
  async increment(key, ttlSeconds) {
    const redis = await getClient();
    // INCR e EXPIRE nello stesso giro: niente chiave che resta senza scadenza
    // se il processo muore fra le due.
    const results = await redis.multi().incr(key).expire(key, ttlSeconds).exec();
    const [incrError, value] = results?.[0] ?? [new Error('risposta vuota'), null];
    if (incrError) throw incrError;
    return Number(value);
  },
};

function defaultCounter(): SharedCounter | null {
  return process.env.REDIS_URL ? redisCounter : null;
}
