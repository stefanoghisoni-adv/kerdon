// app/lib/cache/stats-cache.server.ts
// Cache best-effort (Redis/Upstash) dei conteggi di readiness: alla riapertura
// dell'app li mostriamo SUBITO e li aggiorniamo live in background. Se Redis non
// è raggiungibile la cache "sparisce" senza mai bloccare: si ricalcola live.
import type Redis from 'ioredis';
import { redisConnectionOptions } from '../queue/connection.server';

// ioredis è importato dinamicamente: il build server di Remix è un bundle unico,
// quindi un import statico lo caricherebbe a ogni cold start — anche sulle rotte
// che la cache non la usano. Qui il costo si paga solo al primo accesso reale.
let clientPromise: Promise<Redis> | null = null;

function getClient(): Promise<Redis> {
  if (!clientPromise) {
    clientPromise = import('ioredis').then(
      ({ default: RedisClient }) =>
        new RedisClient({
          ...redisConnectionOptions(),
          // Pochi tentativi: la cache non e' un dato che valga la pena
          // rincorrere. Se non risponde si ricalcola live.
          maxRetriesPerRequest: 2,
        }),
    );
  }
  return clientPromise;
}

/**
 * Quanto si concede alla cache prima di rinunciare.
 *
 * Serve perche' il client accoda i comandi mentre la connessione si apre: senza
 * un tetto, una funzione che parte a freddo con Redis irraggiungibile
 * resterebbe in attesa invece di ricalcolare.
 *
 * Prima quell'attesa era esclusa a monte (`enableOfflineQueue: false`), e il
 * rimedio era peggio del male: su Vercel ogni invocazione a freddo apre una
 * connessione nuova, e il primo comando partiva durante la stretta di mano TLS
 * — "Stream isn't writeable" — cioe' sempre. La cache non veniva letta mai, e a
 * ogni apertura dell'app il catalogo si rileggeva per intero da Shopify.
 */
const TIMEOUT_MS = 1000;

function withTimeout<T>(operation: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), TIMEOUT_MS)),
  ]);
}

export interface ReadinessStats {
  totalProducts: number;
  readyCount: number;
  problemCount: number;
  /**
   * Prodotti gia' venduti a cui manca il costo: e' il numero dell'avviso in
   * dashboard, ed e' la lunghezza esatta dell'elenco che la tab Prodotti mostra
   * col filtro "Solo prodotti negli ordini".
   *
   * Opzionale perche' non tutti sanno calcolarlo: il ricontrollo della tab
   * Prodotti riscrive pronti/problemi ma non sa quali delle varianti risolte
   * fossero vendute, quindi lo lascia fuori invece di tramandare un numero
   * vecchio. Assente = l'avviso non si mostra finche' non arriva il ricalcolo
   * live, che e' meglio di un avviso che mente.
   */
  soldWithoutCost?: number;
}

// TTL alto: è solo un limite massimo di obsolescenza. In pratica ogni apertura
// dell'app innesca un refresh live che riscrive la cache.
const TTL_SECONDS = 24 * 60 * 60;

function key(shopId: string): string {
  return `stats:readiness:${shopId}`;
}

export async function getReadinessCache(
  shopId: string,
): Promise<(ReadinessStats & { computedAt: string }) | null> {
  try {
    const redis = await getClient();
    const raw = await withTimeout(redis.get(key(shopId)), null);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('[stats-cache] get fallito (ignoro, calcolo live):', err);
    return null;
  }
}

export async function setReadinessCache(
  shopId: string,
  stats: ReadinessStats,
): Promise<void> {
  try {
    const payload = JSON.stringify({ ...stats, computedAt: new Date().toISOString() });
    const redis = await getClient();
    await withTimeout(redis.set(key(shopId), payload, 'EX', TTL_SECONDS), 'OK');
  } catch (err) {
    console.error('[stats-cache] set fallito (ignoro):', err);
  }
}

export interface CustomerStats {
  totalCustomers: number;
  optIn: number;
  optOut: number;
}

function customerKey(shopId: string): string {
  return `stats:customers:${shopId}`;
}

export async function getCustomerStatsCache(
  shopId: string,
): Promise<(CustomerStats & { computedAt: string }) | null> {
  try {
    const redis = await getClient();
    const raw = await withTimeout(redis.get(customerKey(shopId)), null);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('[stats-cache] get clienti fallito (ignoro, calcolo live):', err);
    return null;
  }
}

export async function setCustomerStatsCache(
  shopId: string,
  stats: CustomerStats,
): Promise<void> {
  try {
    const payload = JSON.stringify({ ...stats, computedAt: new Date().toISOString() });
    const redis = await getClient();
    await withTimeout(redis.set(customerKey(shopId), payload, 'EX', TTL_SECONDS), 'OK');
  } catch (err) {
    console.error('[stats-cache] set clienti fallito (ignoro):', err);
  }
}

/**
 * Butta via i conteggi in cache di un negozio.
 *
 * Serve quando i dati da cui quei numeri erano stati calcolati non esistono
 * piu': scollegare il database — a maggior ragione eliminandone le tabelle —
 * lascerebbe altrimenti in dashboard i prodotti pronti e i clienti di un
 * database che non c'e' piu', per un giorno intero (e' il TTL). Non un errore
 * visibile: dei numeri credibili e falsi, che e' peggio.
 *
 * Best effort come tutto il resto qui: se Redis non risponde, i numeri
 * scadranno da soli e nel frattempo la pagina li ricalcola live.
 */
export async function clearShopStatsCache(shopId: string): Promise<void> {
  try {
    const redis = await getClient();
    await withTimeout(redis.del(key(shopId), customerKey(shopId)), 0);
  } catch (err) {
    console.error('[stats-cache] pulizia fallita (ignoro):', err);
  }
}
