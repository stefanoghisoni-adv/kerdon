import { waitUntil } from '@vercel/functions';
import { dedupKeyFor } from './queue-model';
import { enqueueSyncRequest } from './queue-store.server';

/**
 * Mette in coda una sincronizzazione manuale.
 *
 * Durabile su Postgres, non piu' su Redis: se l'app va in timeout o il browser
 * viene chiuso, la riga resta e il cron la drena comunque. La differenza con
 * prima non e' la durabilita' — anche Redis reggeva — ma il possesso: adesso
 * chi la lavora la prende, e due drenaggi non possono farla due volte.
 *
 * La deduplica e' per negozio, tipo e finestra di un minuto. Due clic
 * ravvicinati sul pulsante producono un item solo; un clic dieci minuti dopo ne
 * produce uno nuovo, perche' e' una richiesta nuova — il merchant ha cambiato
 * qualcosa su Shopify e sta chiedendo di rivederlo.
 */
export async function enqueueManualSync(shopId: string): Promise<void> {
  await enqueueSyncRequest({
    type: 'manual-sync',
    shopId,
    dedupKey: dedupKeyFor('manual-sync', shopId, new Date()),
  });
}

/**
 * Mette in coda un allineamento completo (prima sincronizzazione, o recupero
 * dopo un cambio di piano).
 */
export async function enqueueInitialBulkSync(shopId: string): Promise<void> {
  await enqueueSyncRequest({
    type: 'initial-bulk-sync',
    shopId,
    dedupKey: dedupKeyFor('initial-bulk-sync', shopId, new Date()),
  });
}

/** Mette in coda il controllo periodico di un negozio. */
export async function enqueuePeriodicSyncCheck(shopId: string): Promise<void> {
  await enqueueSyncRequest({
    type: 'periodic-sync-check',
    shopId,
    dedupKey: dedupKeyFor('periodic-sync-check', shopId, new Date()),
  });
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
