// app/lib/consent/revoke-tracking.server.ts
//
// Cosa fanno le rotte quando un visitatore dice di no, in un posto solo.
//
// Erano quattro copie della stessa riga — `await forgetVisitor(...)` dentro un
// try/catch, con il risultato buttato via — su `tracking_id`, `users`,
// `identify` e il proxy di lettura. Quattro copie di un gesto sono quattro
// posti dove ricordarsi di guardare l'esito, e in nessuno dei quattro lo si
// guardava.
//
// L'ORDINE DEI FATTI, che e' tutta la sostanza di questo file:
//
//  1. si SCRIVE che la revoca e' stata chiesta. Se non riesce, la revoca non e'
//     nostra e nessuno deve rispondere ok;
//  2. si PROVA subito ad applicarla, perche' nel caso normale ci vuole meno di
//     aspettare il giro del cron e la persona ha diritto a un effetto adesso;
//  3. se il tentativo va male non cambia niente per chi chiama: la riga e'
//     scritta, il ritentativo e' garantito, e la risposta e' comunque ok.
//
// Il cookie lo fa scadere il chiamante, SEMPRE e prima di sapere com'e' andata:
// il tracciamento locale deve cessare nell'istante del no. Quello che dipende
// da questo esito e' solo se la risposta e' un ok o un segnale di ritentativo —
// e in nessuno dei due casi si rimette il cookie.

import {
  processRevocation,
  recordRevocation,
  type RevocationRunner,
} from './revocation-register.server';

export type RevokeOutcome =
  /** Presa in carico e applicata subito: non resta niente da fare. */
  | 'applied'
  /** Presa in carico, non ancora applicata: la riprende il drenaggio. */
  | 'recorded'
  /** Era gia' stata presa in carico e conclusa: niente da fare. */
  | 'already_done'
  /** NON presa in carico: chi chiama deve chiedere un ritentativo. */
  | 'not_recorded';

export interface RevokeResult {
  outcome: RevokeOutcome;
  /**
   * Se chi chiama deve rispondere con un segnale di ritentativo invece che con
   * un ok. Vero nel solo caso in cui la riga durevole non esiste.
   */
  retriable: boolean;
}

/**
 * Prende in carico la revoca del tracciamento di un browser, e prova ad
 * applicarla.
 *
 * Non solleva mai: un guasto del database owner diventa `not_recorded`, che e'
 * un'informazione che chi chiama deve avere, non un'eccezione da avvolgere in
 * un ennesimo try/catch.
 */
export async function revokeTrackingIdentity(
  params: { shopId: string; externalId: string; shopifyCustomerId?: string | number | null },
  runner?: RevocationRunner,
): Promise<RevokeResult> {
  let recorded: Awaited<ReturnType<typeof recordRevocation>>;

  try {
    recorded = await recordRevocation({
      shopId: params.shopId,
      scope: 'tracking_identity',
      externalId: params.externalId,
      shopifyCustomerId: params.shopifyCustomerId ?? null,
    });
  } catch (error) {
    // L'unico caso in cui si risponde male a chi chiama. Il messaggio non porta
    // il soggetto: e' un errore del database owner, e l'identificativo del
    // browser non c'entra niente con il motivo per cui non ha risposto.
    console.error(
      '[revoche] revoca NON presa in carico:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
    return { outcome: 'not_recorded', retriable: true };
  }

  if (recorded.alreadyDone) return { outcome: 'already_done', retriable: false };

  // Il primo tentativo, sincrono. Attesa e non lasciata in volo: su una
  // funzione serverless una promise non attesa muore con l'istanza, e qui
  // morirebbe proprio il tentativo che evita al visitatore di aspettare il
  // giro del cron.
  const esito = await processRevocation(recorded.id, runner);

  return esito === 'done'
    ? { outcome: 'applied', retriable: false }
    : { outcome: 'recorded', retriable: false };
}
