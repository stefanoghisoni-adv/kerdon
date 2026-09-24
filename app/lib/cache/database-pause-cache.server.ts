// app/lib/cache/database-pause-cache.server.ts
//
// Dove si ricorda che il database di un negozio e' fermo.
//
// PERCHE' QUI E NON IN UNA COLONNA. Perche' la verita' su un progetto Supabase
// ce l'ha Supabase, non noi: qualunque cosa scrivessimo sarebbe comunque una
// copia. Quel che serve e' non doverla richiedere a ogni apertura di pagina —
// e' una chiamata di rete verso un terzo su un percorso che il merchant
// attraversa in continuazione — e non perdere il clic sul pulsante nei minuti
// in cui Supabase dichiara ancora il progetto fermo.
//
// Best-effort come tutto quello che sta in questa cartella: se Redis non
// risponde non fallisce niente. Nel caso peggiore il banner torna a dire "in
// pausa" con il pulsante acceso, il merchant preme di nuovo, e la seconda
// richiesta di riattivazione su un progetto che si sta gia' riattivando non
// rompe nulla — mentre la riga di verita' vera, lo stato del progetto, e' li'
// dov'e' sempre stata.
import type Redis from 'ioredis';
import { redisConnectionOptions } from '../queue/connection.server';
import type { DatabasePauseState } from '../supabase/database-pause';

// Import dinamico per la stessa ragione di `stats-cache.server.ts`: il build
// server e' un bundle unico, e uno statico caricherebbe ioredis a ogni cold
// start anche sulle rotte che non lo usano.
let clientPromise: Promise<Redis> | null = null;

function getClient(): Promise<Redis> {
  if (!clientPromise) {
    clientPromise = import('ioredis').then(
      ({ default: RedisClient }) =>
        new RedisClient({ ...redisConnectionOptions(), maxRetriesPerRequest: 2 }),
    );
  }
  return clientPromise;
}

/** Quanto si concede alla cache prima di rinunciare. Vedi `stats-cache`. */
const TIMEOUT_MS = 1000;

function withTimeout<T>(operation: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), TIMEOUT_MS)),
  ]);
}

/**
 * Per quanto ci si ricorda di un database fermo.
 *
 * Un giorno, e non e' una scadenza dello stato: e' un tetto all'obsolescenza,
 * come per gli altri valori qui accanto. Finche' il database resta fermo la
 * riga si riscrive a ogni controllo, quindi in pratica non scade mai; se
 * l'app non viene piu' aperta, sparisce da se' invece di restare per sempre.
 */
const TTL_SECONDS = 24 * 60 * 60;

function key(shopId: string): string {
  return `supabase:pause:${shopId}`;
}

export async function getDatabasePauseState(
  shopId: string,
): Promise<DatabasePauseState | null> {
  try {
    const redis = await getClient();
    const raw = await withTimeout(redis.get(key(shopId)), null);
    return raw ? (JSON.parse(raw) as DatabasePauseState) : null;
  } catch (err) {
    console.error('[database-pause-cache] lettura fallita (ignoro):', err);
    return null;
  }
}

export async function setDatabasePauseState(
  shopId: string,
  state: DatabasePauseState,
): Promise<void> {
  try {
    const redis = await getClient();
    await withTimeout(redis.set(key(shopId), JSON.stringify(state), 'EX', TTL_SECONDS), 'OK');
  } catch (err) {
    console.error('[database-pause-cache] scrittura fallita (ignoro):', err);
  }
}

/**
 * Dimentica che il database di questo negozio fosse fermo.
 *
 * Si chiama quando risulta di nuovo attivo, e anche quando il merchant scollega
 * il progetto: un avviso che parla di un database in pausa sopra un negozio che
 * ne ha appena collegato un altro sarebbe un allarme su una cosa che non
 * esiste piu'.
 */
export async function clearDatabasePauseState(shopId: string): Promise<void> {
  try {
    const redis = await getClient();
    await withTimeout(redis.del(key(shopId)), 0);
  } catch (err) {
    console.error('[database-pause-cache] pulizia fallita (ignoro):', err);
  }
}
