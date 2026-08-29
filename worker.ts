import { Worker } from 'bullmq';
import { getRedisUrl } from './app/lib/queue/connection.server';
import type { SyncJobData } from './app/lib/queue/queues.server';
import {
  processPeriodicSyncCheck,
  processInitialBulkSync,
  processManualSync,
  processRetryWebhook,
} from './app/lib/workers/processors.server';
import { processComplianceRequest } from './app/lib/gdpr/process-compliance.server';

console.log('Starting sync worker...');

const redisUrl = getRedisUrl();

// Parse Redis URL to extract connection options for BullMQ
const url = new URL(redisUrl);
const connectionOptions = {
  host: url.hostname,
  port: parseInt(url.port || '6379', 10),
  username: url.username || undefined,
  password: url.password || undefined,
  db: url.pathname ? parseInt(url.pathname.slice(1), 10) : 0,
  lazyConnect: true,
};

const worker = new Worker<SyncJobData>(
  'sync-queue',
  async (job) => {
    console.log(`Processing job ${job.id}: ${job.data.type}`);

    switch (job.data.type) {
      case 'periodic-sync-check':
        await processPeriodicSyncCheck(job.data.shopId);
        break;

      case 'initial-bulk-sync':
        await processInitialBulkSync(job.data.shopId, job);
        break;

      case 'manual-sync':
        await processManualSync(job.data.shopId, job);
        break;

      case 'retry-failed-webhook':
        await processRetryWebhook(job.data);
        break;

      // Il job e' solo la sveglia: la fonte di verita' e' la riga su Postgres,
      // ed e' lei a decidere se c'e' ancora qualcosa da fare. Un job perso
      // diventa quindi un ritardo, che il giro del cron recupera, e non una
      // richiesta GDPR mai eseguita.
      case 'compliance-request':
        await processComplianceRequest(job.data.requestId);
        break;

      default:
        throw new Error(`Unknown job type: ${(job.data as any).type}`);
    }
  },
  {
    connection: connectionOptions as any,
    concurrency: 5,
  }
);

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err);
});

worker.on('error', (err) => {
  console.error('Worker error:', err);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing worker...');
  await worker.close();
  process.exit(0);
});
