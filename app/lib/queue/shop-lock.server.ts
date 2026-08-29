import { redisConnectionOptions } from './connection.server';

/**
 * Un lucchetto per negozio, perche' due sincronizzazioni sullo stesso non si
 * sovrappongano.
 *
 * Serve perche' il drain non e' un Worker di BullMQ: legge i job in attesa e
 * chiama i processor direttamente, senza che nessuno prenda possesso del job.
 * Finche' il drain lo faceva solo il cron ogni mezz'ora la cosa non si vedeva;
 * da quando un gesto manuale ne innesca uno subito, due invocazioni possono
 * benissimo trovarsi davanti lo stesso lavoro nello stesso istante.
 *
 * E non e' un doppione innocuo. La corsa completa, alla fine, spazza le righe
 * con `synced_at` anteriore al proprio inizio: e' cosi' che toglie i prodotti
 * spariti da Shopify. Due corse sovrapposte hanno due istanti d'inizio diversi,
 * e la piu' vecchia porta via le righe che la piu' recente ha appena scritto.
 * Il danno non si vede subito e non lascia errori: si vede dopo, come prodotti
 * mancanti.
 *
 * Il lucchetto scade da solo. Su una funzione serverless il processo puo'
 * morire senza arrivare al rilascio — timeout, riavvio, deploy — e un lucchetto
 * eterno bloccherebbe quel negozio per sempre. Meglio una finestra generosa che
 * si apre da se': al giro dopo il lavoro riparte.
 */

/**
 * Quanto vive il lucchetto se nessuno lo rilascia.
 *
 * Piu' lungo del tetto di durata di una funzione su Vercel (cinque minuti), per
 * non liberarlo mentre la corsa sta ancora lavorando: liberarlo troppo presto
 * riaprirebbe esattamente la porta che questo file chiude.
 */
const LOCK_TTL_MS = 10 * 60 * 1000;

function lockKey(shopId: string): string {
  return `coreward:sync-lock:${shopId}`;
}

/**
 * Esegue `run` solo se nessun altro sta gia' lavorando su quel negozio.
 *
 * Restituisce `false` senza eseguire niente quando il lucchetto e' occupato:
 * per chi chiama non e' un errore — e' qualcun altro che sta gia' facendo
 * quella cosa, che e' il risultato voluto.
 *
 * Se Redis non risponde si esegue lo stesso. Un negozio che non si sincronizza
 * e' un guasto certo; due corse sovrapposte sono un rischio, e fra i due il
 * secondo e' il male minore — soprattutto perche' il caso in cui capitano
 * davvero e' raro, mentre Redis irraggiungibile fermerebbe tutti.
 */
export async function withShopSyncLock(
  shopId: string,
  run: () => Promise<void>,
): Promise<boolean> {
  const { default: IORedis } = await import('ioredis');
  const redis = new IORedis(redisConnectionOptions() as never);

  // Un gettone diverso a ogni presa: al rilascio si controlla di essere ancora
  // i proprietari. Senza, una corsa lenta il cui lucchetto e' scaduto
  // rilascerebbe quello di chi e' subentrato.
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const key = lockKey(shopId);

  let acquired = false;
  try {
    acquired = (await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK';
  } catch (err) {
    console.warn(
      `[sync-lock] Redis non raggiungibile, si procede senza lucchetto: ${
        err instanceof Error ? err.message : 'errore sconosciuto'
      }`,
    );
    await redis.quit().catch(() => undefined);
    await run();
    return true;
  }

  if (!acquired) {
    await redis.quit().catch(() => undefined);
    return false;
  }

  try {
    await run();
    return true;
  } finally {
    // Il rilascio e' condizionato al gettone, e in un colpo solo: leggere e poi
    // cancellare lascerebbe in mezzo l'istante in cui il lucchetto scade e
    // qualcun altro lo prende.
    try {
      await redis.eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
        1,
        key,
        token,
      );
    } catch {
      // Non rilasciato: scadra' da solo. Nessun danno, solo un'attesa.
    }
    await redis.quit().catch(() => undefined);
  }
}
