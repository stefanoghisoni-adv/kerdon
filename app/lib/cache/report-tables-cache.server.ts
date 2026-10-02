// app/lib/cache/report-tables-cache.server.ts
//
// Dove si ricorda che le tabelle della tab Clienti, nel database di un
// negozio, ci sono.
//
// Controllarlo costa una domanda alla Management API di Supabase, cioe'
// qualche centinaio di millisecondi, e si faceva a OGNI apertura della tab per
// un fatto che cambia quasi mai: una volta che le tabelle ci sono, restano. Qui
// si ricorda l'esito positivo, e solo quello — una tabella mancante si deve
// continuare a cercarla finche' non c'e'.
//
// La memoria non e' la verita': se una tabella sparisce dopo (un database
// ripulito a mano), la lettura fallisce con "relation does not exist", chi
// legge dimentica questo ricordo e ricontrolla. Per questo i tempi di scadenza
// possono essere lunghi: non tengono in piedi un dato sbagliato, limitano solo
// quanto a lungo un ricordo resta in giro.
//
// Due livelli. La memoria del processo risponde subito, ma ogni istanza ha la
// sua e un avvio a freddo parte vuoto; Redis la condivide fra le istanze. Redis
// e' best effort come tutto in questa cartella: se manca o non risponde, resta
// la sola memoria e nel caso peggiore si rifa' il controllo, come prima.
import type Redis from 'ioredis';
import { redisConnectionOptions } from '../queue/connection.server';

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

/**
 * Quanto si concede a Redis prima di rinunciare.
 *
 * Piu' stretto che negli altri valori qui accanto: questa attesa sta sul
 * percorso dell'apertura della tab, e il controllo che evita costa a sua volta
 * poche centinaia di millisecondi. Aspettare Redis di piu' sarebbe pagare
 * l'attesa per risparmiarne una uguale.
 */
const TIMEOUT_MS = 300;

function withTimeout<T>(operation: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), TIMEOUT_MS)),
  ]);
}

const MEMORY_TTL_MS = 60 * 60 * 1000;
const REDIS_TTL_SECONDS = 24 * 60 * 60;

/** Fino a quando ciascun ricordo vale, per negozio e progetto. */
const memory = new Map<string, number>();

// Il progetto fa parte della chiave: collegarne un altro e' un database nuovo,
// con le sue tabelle da controllare da capo.
function key(shopId: string, projectRef: string): string {
  return `supabase:report-tables:${shopId}:${projectRef}`;
}

/** Le tabelle risultano gia' presenti? `false` vuol dire "non si sa". */
export async function reportTablesKnown(shopId: string, projectRef: string): Promise<boolean> {
  const k = key(shopId, projectRef);
  const until = memory.get(k);
  if (until !== undefined) {
    if (until > Date.now()) return true;
    memory.delete(k);
  }

  try {
    const redis = await getClient();
    const found = await withTimeout(redis.get(k), null);
    if (!found) return false;
    memory.set(k, Date.now() + MEMORY_TTL_MS);
    return true;
  } catch (err) {
    console.error('[report-tables-cache] lettura fallita (ignoro, ricontrollo):', err);
    return false;
  }
}

export async function rememberReportTables(shopId: string, projectRef: string): Promise<void> {
  const k = key(shopId, projectRef);
  memory.set(k, Date.now() + MEMORY_TTL_MS);
  try {
    const redis = await getClient();
    await withTimeout(redis.set(k, '1', 'EX', REDIS_TTL_SECONDS), 'OK');
  } catch (err) {
    console.error('[report-tables-cache] scrittura fallita (ignoro):', err);
  }
}

export async function forgetReportTables(shopId: string, projectRef: string): Promise<void> {
  const k = key(shopId, projectRef);
  memory.delete(k);
  try {
    const redis = await getClient();
    await withTimeout(redis.del(k), 0);
  } catch (err) {
    console.error('[report-tables-cache] pulizia fallita (ignoro):', err);
  }
}

/** Solo per le prove: ogni caso parte da una memoria vuota. */
export function resetReportTablesMemory(): void {
  memory.clear();
}
