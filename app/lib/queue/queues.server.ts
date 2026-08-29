import type { Queue } from 'bullmq';
import { redisConnectionOptions } from './connection.server';

// BullMQ (~5 MB, con ioredis al seguito) NON va importato staticamente: il build
// server di Remix è un bundle unico, quindi un import statico qui verrebbe
// caricato e parsato a ogni cold start — anche per un semplice render della
// dashboard, che la coda non la tocca nemmeno. Import dinamico + memoizzazione:
// il costo si paga solo nelle rotte che accodano o drenano davvero i job.

let queuePromise: Promise<Queue> | null = null;

// Coda condivisa, istanziata al primo uso. La promise è memoizzata: chiamate
// concorrenti nella stessa invocazione riusano la stessa istanza (e la stessa
// connessione Redis) invece di aprirne una ciascuna.
export function getSyncQueue(): Promise<Queue> {
  if (!queuePromise) {
    queuePromise = import('bullmq').then(
      ({ Queue: BullQueue }) =>
        new BullQueue('sync-queue', {
          connection: redisConnectionOptions() as any,
          defaultJobOptions: {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 60000, // 1 minute base delay
            },
            removeOnComplete: {
              age: 86400, // 24 hours
              count: 1000,
            },
            removeOnFail: {
              age: 604800, // 7 days
              count: 5000,
            },
          },
        }),
    );
  }
  return queuePromise;
}

export type SyncJobData =
  | { type: 'periodic-sync-check'; shopId: string }
  | { type: 'initial-bulk-sync'; shopId: string }
  | { type: 'manual-sync'; shopId: string }
  | { type: 'retry-failed-webhook'; syncJobId: string; webhookPayload: any; attempt: number }
  // Una richiesta di conformita' presa in carico. Porta solo l'id della riga su
  // Postgres, mai il payload: quel corpo contiene l'id di una persona, e la
  // coda su Redis non e' il posto dove tenerlo. Chi lavora il job va a
  // rileggerselo, e cosi' vede sempre lo stato vero della richiesta invece di
  // una fotografia scattata al momento dell'accodamento.
  | { type: 'compliance-request'; requestId: string };
