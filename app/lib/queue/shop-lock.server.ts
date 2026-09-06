// app/lib/queue/shop-lock.server.ts
//
// Un lucchetto per negozio, perche' due sincronizzazioni sullo stesso non si
// sovrappongano.
//
// PERCHE' SERVE. La corsa completa, alla fine, spazza dal database del merchant
// le righe con `synced_at` anteriore al proprio inizio: e' cosi' che toglie i
// prodotti spariti da Shopify. Due corse sovrapposte hanno due istanti d'inizio
// diversi, e la piu' vecchia porta via le righe che la piu' recente ha appena
// scritto. Il danno non si vede subito e non lascia errori: si vede dopo, come
// prodotti mancanti.
//
// COS'E' CAMBIATO. Il lucchetto stava su Redis con una scadenza fissa di dieci
// minuti che nessuno rinnovava, e — la parte grave — se Redis non rispondeva la
// corsa proseguiva SENZA lucchetto. Era scritto a chiare lettere e motivato
// cosi': "un negozio che non si sincronizza e' un guasto certo, due corse
// sovrapposte sono un rischio". Il ragionamento e' sbagliato nel modo piu'
// costoso possibile, perche' pesa una sincronizzazione rimandata contro delle
// righe cancellate. Adesso e' fail-closed: se il lucchetto non si prende, non
// si lavora. Il lavoro torna in coda, e la coda ce l'ha ancora.
//
// PERCHE' UNA RIGA E NON UN ADVISORY LOCK. `DATABASE_URL` punta al pooler di
// Supabase in transaction mode: li' una connessione non e' di nessuno fra una
// query e l'altra, quindi `pg_advisory_lock` verrebbe preso su una sessione e
// rilasciato — o peggio, non rilasciato — su un'altra. `pg_advisory_xact_lock`
// vivrebbe quanto la transazione, e una sincronizzazione dura minuti: non si
// tiene aperta una transazione per tutto quel tempo. Una riga con una scadenza
// non ha nessuno dei due problemi, e in piu' la si puo' guardare.
//
// IL BATTITO E IL GETTONE. La scadenza e' corta (un minuto) e la rinnova un
// battito: un lavoro lungo tiene il lucchetto, un'invocazione morta lo libera
// in un minuto invece che in dieci. E ogni presa incrementa un gettone, che
// ogni scrittura distruttiva verifica prima di partire — cosi' un processo
// sopravvissuto a un deploy, che si risveglia quando il lucchetto e' gia' di
// qualcun altro, non cancella niente.

import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '~/db.server';
import {
  ShopErasureInProgressError,
  isErasing,
  readErasureState,
} from '~/lib/gdpr/erasure-guard.server';
import { HEARTBEAT_MS, LEASE_TTL_MS } from './queue-model';

/** Il possesso del negozio, per chi ci sta lavorando dentro. */
export interface ShopLease {
  shopId: string;
  owner: string;
  fencingToken: number;
  /**
   * Il gettone del ciclo di vita del negozio, letto quando il lucchetto e'
   * stato preso. null quando la riga del negozio non c'era gia' allora.
   *
   * E' il gemello di `fencingToken` per un pericolo diverso: quello protegge
   * dalle altre corse, questo dalla cancellazione del negozio. Chi lavora se lo
   * porta dietro e lo riverifica prima di scrivere; se e' cambiato, la
   * cancellazione e' cominciata dopo di lui.
   */
  erasureGeneration: number | null;
  /**
   * Si spegne quando il lease e' perso o il tempo massimo e' scaduto. Chi fa un
   * lavoro lungo lo passa alle chiamate di rete, cosi' l'interruzione arriva
   * anche a meta' di una paginazione.
   */
  signal: AbortSignal;
  /**
   * Lancia se non si ha piu' titolo per scrivere.
   *
   * Da chiamare prima di ogni cancellazione sul database del merchant. I due
   * casi che copre, e sono due guasti diversi con lo stesso rimedio:
   *
   *  - il lucchetto non e' piu' nostro. La nostra corsa e' stata lenta, il
   *    lease e' scaduto, un'altra corsa e' partita e sta riscrivendo le righe —
   *    e noi stavamo per spazzare via tutto quello che lei ha appena scritto.
   *  - il negozio e' entrato in cancellazione. `shop/redact` ha alzato il
   *    gettone del ciclo di vita mentre lavoravamo, e le nostre scritture
   *    andrebbero a riempire di dati un negozio che ha chiesto di sparire.
   */
  assertHeld(): Promise<void>;
}

/**
 * Com'e' andata la richiesta del lucchetto.
 *
 * Tre esiti e non due, perche' 'occupato' e 'non-disponibile' vogliono dire
 * cose diverse a chi legge un log: nel primo caso qualcun altro sta gia'
 * facendo quel lavoro (ed e' il risultato voluto), nel secondo il database non
 * ha risposto e non sta lavorando nessuno.
 */
export type ShopLockOutcome = 'eseguito' | 'occupato' | 'non-disponibile';

/** Per quanto una verifica del possesso resta valida senza rileggere. */
export const ASSERT_CACHE_MS = 5_000;

export interface ShopLeaseOptions {
  /** Durata della presa. La rinnova il battito, quindi puo' essere corta. */
  ttlMs?: number;
  /** Ogni quanto si rinnova. */
  heartbeatMs?: number;
  /** Oltre questo tempo il lavoro viene interrotto e il lucchetto rilasciato. */
  maxRunMs?: number;
  /** Un segnale esterno che deve poter interrompere il lavoro (SIGTERM). */
  signal?: AbortSignal;
  /**
   * Chi sta cancellando il negozio, e quindi ha il diritto di alzare il gettone
   * del ciclo di vita.
   *
   * L'unico chiamante che la passa e' `shop/redact`. Senza, la verifica del
   * possesso si accorgerebbe della cancellazione — la propria — e la
   * fermerebbe; e su un ritentativo, dove il negozio e' gia' marcato dal
   * tentativo precedente, non ripartirebbe nemmeno.
   */
  duringErasure?: boolean;
  now?: Date;
}

interface LockRow {
  fencing_token: number;
}

/**
 * Prende il lucchetto, oppure non lo prende.
 *
 * Una sola istruzione: l'inserimento vince se la riga non c'e', e la sostituisce
 * solo se quella che c'e' e' scaduta. Nessun controllo-poi-scrittura, che con
 * due invocazioni simultanee darebbe il lucchetto a tutte e due.
 */
function acquireStatement(shopId: string, owner: string, now: Date, ttlMs: number): Prisma.Sql {
  const scadenza = new Date(now.getTime() + ttlMs);

  return Prisma.sql`
    INSERT INTO "shop_locks" ("shop_id", "owner", "fencing_token", "acquired_at", "expires_at")
    VALUES (${shopId}, ${owner}, 1, ${now}, ${scadenza})
    ON CONFLICT ("shop_id") DO UPDATE
      SET "owner" = EXCLUDED."owner",
          "fencing_token" = "shop_locks"."fencing_token" + 1,
          "acquired_at" = EXCLUDED."acquired_at",
          "expires_at" = EXCLUDED."expires_at"
      WHERE "shop_locks"."expires_at" <= ${now}
    RETURNING "fencing_token"
  `;
}

/**
 * Esegue `run` solo se il negozio e' libero, e solo finche' resta nostro.
 *
 * Non solleva per il lucchetto: restituisce com'e' andata. Solleva invece
 * quello che solleva `run`, perche' quello e' l'esito del lavoro e chi ha
 * chiamato deve poterlo ritentare.
 */
export async function runWithShopLease(
  shopId: string,
  run: (lease: ShopLease) => Promise<void>,
  opts: ShopLeaseOptions = {},
): Promise<ShopLockOutcome> {
  const ttlMs = opts.ttlMs ?? LEASE_TTL_MS;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const now = opts.now ?? new Date();
  const owner = `${process.env.VERCEL_DEPLOYMENT_ID ?? 'locale'}:${randomUUID()}`;

  let righe: LockRow[];
  try {
    righe = await prisma.$queryRaw<LockRow[]>(acquireStatement(shopId, owner, now, ttlMs));
  } catch (error) {
    // Fail-closed, ed e' il punto di tutto questo file. Non si prosegue senza
    // lucchetto nemmeno "solo per stavolta": il lavoro che verrebbe dopo
    // cancella righe nel database di un merchant.
    console.error(
      `[sync-lock] ALLARME lucchetto non disponibile per il negozio ${shopId}, lavoro rimesso in coda: ${
        error instanceof Error ? error.message : 'errore sconosciuto'
      }`,
    );
    return 'non-disponibile';
  }

  const fencingToken = righe[0]?.fencing_token;
  if (fencingToken === undefined) return 'occupato';

  // Il gettone del ciclo di vita, letto DOPO aver preso il lucchetto e non
  // prima: fra una lettura e la presa ci starebbe una cancellazione intera, e
  // ci si porterebbe dietro un gettone gia' vecchio — cioe' si passerebbe la
  // verifica proprio nel caso che la verifica esiste per fermare.
  //
  // Un negozio gia' sparito da' `null`, e allora la verifica non ha niente da
  // confrontare: il lavoro fallira' da solo alla prima lettura che non trova
  // nulla, e negargli il lucchetto qui vorrebbe dire trasformare in un guasto
  // del lucchetto quello che e' un negozio inesistente.
  let erasureGeneration: number | null = null;
  if (!opts.duringErasure) {
    try {
      const stato = await readErasureState(shopId);
      if (stato && isErasing(stato.lifecycleStatus)) {
        // Fail-closed anche qui: un negozio la cui cancellazione e' gia'
        // cominciata non va lavorato, e non e' un errore — e' il risultato
        // voluto. Si rilascia subito quel che si era appena preso.
        await release(shopId, owner, fencingToken);
        return 'occupato';
      }
      erasureGeneration = stato?.erasureGeneration ?? null;
    } catch (error) {
      // Stessa regola del lucchetto: se non si riesce a sapere se il negozio e'
      // in cancellazione, non si lavora. Sapere a meta' e proseguire e' il modo
      // in cui si finisce a scrivere dentro un negozio gia' cancellato.
      console.error(
        `[sync-lock] ALLARME stato del negozio ${shopId} non leggibile, lavoro rimesso in coda: ${
          error instanceof Error ? error.message : 'errore sconosciuto'
        }`,
      );
      await release(shopId, owner, fencingToken);
      return 'non-disponibile';
    }
  }

  const controller = new AbortController();
  const perso = { valore: false };

  const arrendi = (motivo: string) => {
    if (controller.signal.aborted) return;
    perso.valore = true;
    controller.abort(new Error(motivo));
  };

  // Un segnale esterno gia' spento non deve far partire niente: e' il caso del
  // SIGTERM arrivato mentre si chiedeva il lucchetto.
  if (opts.signal?.aborted) {
    await release(shopId, owner, fencingToken);
    return 'non-disponibile';
  }
  const daFuori = () => arrendi('interruzione richiesta dall\'esterno');
  opts.signal?.addEventListener('abort', daFuori, { once: true });

  const battito = setInterval(() => {
    void (async () => {
      try {
        const rinnovato = await prisma.shopLock.updateMany({
          where: { shopId, owner, fencingToken },
          data: { expiresAt: new Date(Date.now() + ttlMs) },
        });
        // Zero righe = il lucchetto e' di qualcun altro. Non e' un errore di
        // rete da riprovare: e' la notizia che il lavoro in corso non ha piu'
        // titolo per scrivere, e va fermato subito.
        if (rinnovato.count === 0) arrendi('lucchetto perso: e\' stato ripreso da un altro');
      } catch {
        // Un battito perso puo' essere un singhiozzo della rete: non si molla
        // al primo. Ci pensa la scadenza, che e' piu' lunga dell'intervallo.
      }
    })();
  }, heartbeatMs);
  // Il battito non deve tenere vivo il processo: senza questo, un worker locale
  // non uscirebbe mai.
  battito.unref?.();

  const scadenzaLavoro =
    opts.maxRunMs === undefined
      ? undefined
      : setTimeout(() => arrendi(`lavoro interrotto dopo ${opts.maxRunMs} ms`), opts.maxRunMs);
  scadenzaLavoro?.unref?.();

  // L'ultima volta che si e' andati a rileggere davvero.
  //
  // La verifica si fa prima di OGNI cancellazione, e in una riconciliazione le
  // cancellazioni sono una per prodotto: una query ciascuna sarebbe un secondo
  // database interrogato quanto quello che stiamo sincronizzando. Entro la
  // finestra ci si fida dello stato che il battito tiene aggiornato, che e'
  // comunque piu' fresco della scadenza del lucchetto.
  let ultimaVerifica = 0;

  const lease: ShopLease = {
    shopId,
    owner,
    fencingToken,
    erasureGeneration,
    signal: controller.signal,
    async assertHeld() {
      if (perso.valore || controller.signal.aborted) {
        throw new Error(`Lucchetto del negozio ${shopId} non piu' posseduto: scrittura annullata`);
      }

      const adesso = Date.now();
      if (adesso - ultimaVerifica < ASSERT_CACHE_MS) return;

      // Si va a rileggere invece di fidarsi solo del battito: fra un battito e
      // l'altro passano venti secondi, e questa domanda si fa un istante prima
      // di cancellare righe.
      const riga = await prisma.shopLock.findFirst({
        where: { shopId, owner, fencingToken, expiresAt: { gt: new Date() } },
        select: { shopId: true },
      });
      if (!riga) {
        arrendi('lucchetto perso: verifica prima di una scrittura distruttiva');
        throw new Error(`Lucchetto del negozio ${shopId} non piu' posseduto: scrittura annullata`);
      }

      // E il negozio esiste ancora, e non e' entrato in cancellazione mentre
      // lavoravamo. Il lucchetto da solo non lo direbbe: `shop/redact` prende
      // lo stesso lucchetto, quindi finche' lo teniamo noi lui aspetta — ma
      // basta che il nostro lease scada un istante, che lui passi e finisca,
      // perche' noi ci si risvegli a scrivere dentro un negozio cancellato.
      // `erasureGeneration` a null vuol dire che la riga del negozio non c'era
      // gia' quando abbiamo preso il lucchetto: non c'e' nessun gettone da
      // confrontare, e il lavoro fallira' da solo alla prima lettura a vuoto.
      if (!opts.duringErasure && erasureGeneration !== null) {
        const stato = await readErasureState(shopId);
        if (!stato || isErasing(stato.lifecycleStatus) || stato.erasureGeneration !== erasureGeneration) {
          arrendi('negozio in cancellazione: verifica prima di una scrittura');
          throw new ShopErasureInProgressError(
            shopId,
            'gettone del ciclo di vita cambiato durante il lavoro: scrittura annullata',
          );
        }
      }

      ultimaVerifica = adesso;
    },
  };

  try {
    await run(lease);
    return 'eseguito';
  } finally {
    clearInterval(battito);
    if (scadenzaLavoro) clearTimeout(scadenzaLavoro);
    opts.signal?.removeEventListener('abort', daFuori);
    await release(shopId, owner, fencingToken);
  }
}

/**
 * Il rilascio, condizionato al gettone.
 *
 * Se il lucchetto nel frattempo e' passato a qualcun altro, questa DELETE tocca
 * zero righe: e' esattamente cio' che deve fare. Rilasciare per id e basta
 * vorrebbe dire aprire il lucchetto di chi sta lavorando adesso.
 */
async function release(shopId: string, owner: string, fencingToken: number): Promise<void> {
  try {
    await prisma.shopLock.deleteMany({ where: { shopId, owner, fencingToken } });
  } catch {
    // Non rilasciato: scadra' da solo entro la TTL. Nessun danno, solo
    // un'attesa — e sollevare qui coprirebbe l'errore vero del lavoro.
  }
}

/**
 * La forma di prima, per chi non ha bisogno del lease.
 *
 * `false` vuol dire "non e' stato fatto", e va trattato come un rimando: o il
 * negozio e' occupato, o il lucchetto non si e' potuto prendere. In entrambi i
 * casi la risposta giusta e' riprovare piu' tardi, mai proseguire.
 */
export async function withShopSyncLock(
  shopId: string,
  run: () => Promise<void>,
  opts: ShopLeaseOptions = {},
): Promise<boolean> {
  return (await runWithShopLease(shopId, () => run(), opts)) === 'eseguito';
}

/**
 * Toglie i lucchetti scaduti da un pezzo.
 *
 * Non serve alla correttezza — la presa guarda la scadenza, non l'esistenza
 * della riga — ma senza, la tabella accumulerebbe una riga per ogni negozio che
 * ha avuto un'invocazione morta, e non c'e' nessuna chiave esterna che le
 * porti via quando il negozio se ne va.
 */
export async function pruneExpiredShopLocks(now: Date = new Date()): Promise<number> {
  const esito = await prisma.shopLock.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - 60 * 60 * 1000) } },
  });
  return esito.count;
}
