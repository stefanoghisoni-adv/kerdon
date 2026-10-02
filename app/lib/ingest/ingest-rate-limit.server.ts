// app/lib/ingest/ingest-rate-limit.server.ts
//
// Quanta scrittura un negozio puo' fare, e in che ritmo.
//
// QUESTO E' IL PRIMO DEI DUE TETTI, quello in memoria. Da solo aveva un
// prezzo dichiarato: con N istanze vive il tetto vero era N volte quello
// scritto qui. Adesso c'e' anche il secondo, condiviso fra le istanze su Redis
// (`ingest-shared-rate-limit.server`, spento finche' non si imposta
// `INGEST_SHARED_RATE_LIMIT=true`), e questo resta davanti a lui per due
// ragioni. Non costa niente — nessun viaggio di rete — e ferma da solo la
// raffica che arriva a una istanza, che quindi non paga nemmeno la chiamata a
// Redis. E se Redis non risponde il condiviso lascia passare (rifiutare tutto
// vorrebbe dire spegnere il tracciamento di tutti per un guasto dell'archivio),
// e allora questo e' il limite che resta.
//
// Nessuno dei due e' li' per contare al gettone. Sono li' per fermare l'abuso —
// una credenziale in mano a qualcun altro usata per riempire il database di un
// merchant. `takeToken` e' pura e gia' provata.
//
// L'INDIRIZZO IP NON E' UN'IDENTITA', e in questo file si vede in tre punti.
// Non autorizza (a dire di chi e' la richiesta e' la credenziale, sempre), non
// esce in nessun log, e quando non si sa qual e' non succede niente — chi arriva
// senza indirizzo leggibile non viene penalizzato per non averlo. Serve a
// impedire che una sola provenienza impazzita consumi la quota dell'intero
// negozio, che e' una ripartizione, non un controllo d'accesso.

import {
  INGEST_BUCKET_CAPACITY,
  INGEST_BUCKET_REFILL_PER_SEC,
  INGEST_SOURCE_CAPACITY,
  INGEST_SOURCE_REFILL_PER_SEC,
  takeToken,
  type TokenBucket,
} from './ingest-model';

/**
 * Tetto al numero di secchielli tenuti insieme.
 *
 * Le chiavi qui dentro nascono da valori che arrivano da fuori — un
 * identificativo di credenziale, un indirizzo — e una mappa che cresce su input
 * altrui e' una perdita di memoria con un altro nome. Stessa misura gia' presa
 * nella cache del proxy di lettura, e per lo stesso motivo.
 */
const MAX_BUCKETS = 5000;

const buckets = new Map<string, TokenBucket>();

/** Butta via tutto. Serve ai test, che devono partire da un secchiello pieno. */
export function clearIngestBuckets(): void {
  buckets.clear();
}

/**
 * Toglie i secchielli ormai pieni, e se non bastano i piu' vecchi.
 *
 * Un secchiello tornato pieno non dice piu' niente: ricrearlo da zero da' lo
 * stesso identico risultato. Sono quindi i primi da buttare, e nel caso normale
 * — tanti negozi tranquilli — sono anche quasi tutti.
 */
function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    const pieno = bucket.tokens + ((now - bucket.updatedAt) / 1000) * INGEST_BUCKET_REFILL_PER_SEC;
    if (pieno >= INGEST_BUCKET_CAPACITY) buckets.delete(key);
  }
  while (buckets.size >= MAX_BUCKETS) {
    const piuVecchio = buckets.keys().next();
    if (piuVecchio.done) break;
    buckets.delete(piuVecchio.value);
  }
}

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /**
   * Quale secchiello ha detto di no. Va nel log — e' la sola cosa del limite
   * che interessi a chi legge dopo — e distingue "questo negozio sta scrivendo
   * troppo" da "una sola provenienza sta consumando la quota di tutte".
   * `shared` e' il tetto condiviso fra le istanze (`ingest-shared-rate-limit`).
   */
  bucket: 'none' | 'credential' | 'source' | 'shared';
}

const PASSA: RateDecision = { allowed: true, retryAfterSeconds: 0, bucket: 'none' };

/**
 * Un gettone per questa scrittura.
 *
 * L'ordine conta: prima il secchiello del negozio e della credenziale, che e'
 * quello vero, poi quello della provenienza. Al contrario, una provenienza
 * impazzita svuoterebbe il proprio secchiello e verrebbe fermata li', senza mai
 * consumare la quota del negozio — cioe' senza che il tetto del negozio serva a
 * niente. Il secondo e' una ripartizione DENTRO il primo, non un cancello
 * davanti.
 */
export function takeIngestSlot(params: {
  shopId: string;
  keyId: string;
  /** L'indirizzo, se si e' riusciti a leggerlo. `null` = non si guarda. */
  source: string | null;
  now?: number;
}): RateDecision {
  const now = params.now ?? Date.now();
  prune(now);

  const chiave = `k:${params.shopId}:${params.keyId}`;
  const primo = takeToken(buckets.get(chiave), now, INGEST_BUCKET_CAPACITY, INGEST_BUCKET_REFILL_PER_SEC);
  buckets.set(chiave, primo.next);
  if (!primo.allowed) {
    return { allowed: false, retryAfterSeconds: primo.retryAfterSeconds, bucket: 'credential' };
  }

  if (!params.source) return PASSA;

  // La provenienza sta DENTRO il negozio nella chiave: lo stesso indirizzo che
  // serve due negozi — un container condiviso da un'agenzia — non deve vedersi
  // sommare il traffico dei due. Sarebbe l'IP usato come identita', che e'
  // proprio la cosa da non fare.
  const chiaveSorgente = `s:${params.shopId}:${params.keyId}:${params.source}`;
  const secondo = takeToken(
    buckets.get(chiaveSorgente),
    now,
    INGEST_SOURCE_CAPACITY,
    INGEST_SOURCE_REFILL_PER_SEC,
  );
  buckets.set(chiaveSorgente, secondo.next);
  if (!secondo.allowed) {
    return { allowed: false, retryAfterSeconds: secondo.retryAfterSeconds, bucket: 'source' };
  }

  return PASSA;
}

/**
 * La provenienza di una richiesta, ridotta a un'etichetta.
 *
 * NON esce da questa funzione verso nessun log e non identifica nessuno: e'
 * solo la chiave di un secchiello. Per questo va bene anche approssimata, e per
 * questo `null` — nessun indirizzo leggibile — non e' un problema da segnalare
 * ma un caso in cui la ripartizione per provenienza semplicemente non si
 * applica.
 *
 * Si legge il primo valore di `X-Forwarded-For`, che e' quello che il proxio
 * davanti a noi ha visto per primo. Chi puo' scrivere quell'intestazione puo'
 * scriverci quello che vuole: e' un'altra delle ragioni per cui non autorizza
 * niente.
 */
export function requestSource(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  const primo = forwarded?.split(',')[0]?.trim();
  if (primo) return primo.slice(0, 64);

  const reale = request.headers.get('x-real-ip')?.trim();
  return reale ? reale.slice(0, 64) : null;
}
