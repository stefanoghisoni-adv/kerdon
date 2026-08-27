import { waitUntil } from '@vercel/functions';
import { getSyncQueue } from './queues.server';
import type { SyncJobData } from './queues.server';

// Mette in coda una sync manuale (durabile su Redis). Se poi l'app va in timeout
// o il browser viene chiuso, il job resta in coda e il cron lo drena comunque.
export async function enqueueManualSync(shopId: string): Promise<void> {
  const syncQueue = await getSyncQueue();
  await syncQueue.add(
    'manual-sync',
    { type: 'manual-sync', shopId } satisfies SyncJobData,
    // jobId univoco per non collassare due richieste manuali ravvicinate.
    { jobId: `manual-sync-${shopId}-${Date.now()}` },
  );
}

// Innesca SUBITO il drain della coda in un'invocazione separata (con un budget
// di durata proprio, indipendente da quello dell'action). Best-effort: se la
// chiamata fallisce, il cron ogni 30 min drena comunque la coda. waitUntil
// mantiene viva l'invocazione finché la richiesta è consegnata, senza però
// ritardare la risposta all'utente.
export function triggerSyncDrain(shopId?: string): void {
  const appUrl = process.env.SHOPIFY_APP_URL;
  const secret = process.env.CRON_SECRET;
  if (!appUrl || !secret) return;

  // Con un negozio indicato si chiede la corsia veloce: si drena la sua coda e
  // basta. Senza, e' il giro completo del cron.
  //
  // La differenza si sente tutta quando il gesto e' manuale. Quel giro completo
  // pota il registro degli accessi, poi passa in rassegna OGNI negozio per lo
  // snapshot di idoneita' e il controllo di cadenza: lavoro dovuto, ma che con
  // il pulsante appena premuto non c'entra niente — e che chi sta guardando la
  // rotellina si aspetta finisca prima di vedere i suoi numeri.
  const url = shopId
    ? `${appUrl}/api/cron/sync?shopId=${encodeURIComponent(shopId)}`
    : `${appUrl}/api/cron/sync`;

  const run = fetch(url, {
    headers: { Authorization: `Bearer ${secret}` },
  })
    .then(() => undefined)
    .catch(() => undefined);

  try {
    // Su Vercel: continua in background dopo la risposta.
    waitUntil(run);
  } catch {
    // Fuori da Vercel (dev locale): nessun contesto waitUntil. La promise è già
    // partita; in locale la coda è gestita dal worker (`npm run worker`).
    void run;
  }
}
