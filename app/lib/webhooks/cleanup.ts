// app/lib/webhooks/cleanup.ts
//
// Cosa succede quando un passo di PULIZIA di un webhook non riesce.
//
// COSA C'ERA PRIMA. Le rotte operative facevano il lavoro principale, poi una
// serie di rimozioni — le varianti che il prodotto non ha piu', le righe legacy
// senza id variante, il posto occupato in graduatoria da un prodotto
// cancellato — e ognuna di quelle finiva cosi': `if (error)
// console.warn(...)`. Poi si rispondeva 200. Cioe' la consegna risultava
// completata con dentro del lavoro non fatto, e non esisteva nessun posto in
// cui quel lavoro fosse ancora scritto: il webhook non torna, e la corsa
// periodica legge cio' che c'e' e non sa cosa era rimasto di troppo.
//
// LA REGOLA ADESSO. Un passo di pulizia e' un passo del lavoro. Se non riesce,
// l'evento NON e' completato: torna in attesa con il suo distanziamento, e il
// ritentativo rifa' tutto — cosa che si puo' fare perche' ogni passo di questi
// webhook e' idempotente per costruzione (una rilettura, un upsert su chiave,
// una cancellazione per uguaglianza).
//
// LA CLASSIFICAZIONE NON E' NUOVA. E' quella che la corsa periodica usa gia',
// in `sync/failure-taxonomy`: critico, riparabile, cosmetico. Qui cambia solo
// cosa se ne fa chi legge — la corsa apre una riparazione durevole e tiene
// indietro il confine incrementale, il webhook ritenta se stesso — ma il
// giudizio su quale guasto si possa lasciar passare deve restare uno solo,
// altrimenti la stessa cancellazione mancata sarebbe grave da una parte e
// trascurabile dall'altra.
//
// I soli passi che proseguono in silenzio restano i cosmetici: quelli in cui si
// perde un dettaglio da mostrare e mai un dato del merchant.

import { mayContinueSilently, type FailureSiteName } from '~/lib/sync/failure-taxonomy';
import type { WebhookOutcome } from './inbox-model';

/**
 * L'esito di un passo di pulizia andato male.
 *
 * `null` vuol dire "si prosegue", e lo restituisce solo per i punti che la
 * tassonomia dichiara cosmetici. Per tutti gli altri restituisce `'retry'`, che
 * e' cio' che tiene l'evento vivo invece di dichiararlo concluso.
 *
 * Il messaggio si scrive comunque: un ritentativo silenzioso e' difficile da
 * spiegare quanto un fallimento silenzioso.
 */
export function afterCleanupFailure(
  site: FailureSiteName,
  contesto: string,
  errore: unknown,
): WebhookOutcome | null {
  const motivo =
    errore instanceof Error
      ? errore.message
      : typeof errore === 'object' && errore !== null && 'message' in errore
        ? String((errore as { message: unknown }).message)
        : String(errore);

  if (mayContinueSilently(site)) {
    console.warn(`[webhook-inbox] ${site} ${contesto}: dettaglio perso, si prosegue — ${motivo}`);
    return null;
  }

  console.error(
    `[webhook-inbox] ${site} ${contesto}: passo non riuscito, l evento resta da lavorare — ${motivo}`,
  );
  return 'retry';
}
