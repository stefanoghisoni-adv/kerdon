/**
 * Cosa mostrare della data di nascita nella tab Clienti: l'avviso, il riquadro
 * di scelta, o la riga di stato sopra la tabella.
 *
 * Sono tre cose che non possono stare insieme, e la ragione e' piu' di
 * ordine: il riquadro chiede di scegliere un campo, la riga dice quale campo
 * c'e' gia'. A schermo insieme farebbero credere che la scelta a sinistra e
 * quella a destra siano due configurazioni diverse dello stesso negozio. Chi
 * decide sta qui, in un posto solo, perche' la decisione la devono leggere in
 * due — la card e la pagina — e due regole scritte a mano in due punti
 * cominciano a divergere il giorno in cui se ne cambia una.
 *
 * Cosa e' gia' stato letto NON vive piu' nel browser. `localStorage` appartiene
 * all'indirizzo da cui la pagina arriva, e dentro l'admin questa pagina arriva
 * da un iframe di un'altra origine: storage di terze parti, che Safari blocca e
 * Chrome partiziona. Il giorno in cui l'app e' passata da un dominio all'altro
 * ogni avviso chiuso e' tornato su, e da dentro l'iframe non si riusciva piu' a
 * chiuderlo. Ora la chiusura arriva dal server insieme al resto della pagina.
 */

import type { BirthdateFieldState } from '~/lib/customers/birthdate-metafield';

/**
 * Cosa sta a schermo.
 *
 * Non c'e' piu' un `pending`. Serviva perche' la memoria di cio' che era stato
 * chiuso stava nel browser e non esisteva durante il render sul server: senza
 * quello stato la pagina mostrava una cosa e l'idratazione un'altra, con un
 * lampo a ogni apertura. Ora il valore arriva dal loader, quindi il primo
 * render sa gia' e le due meta' non possono discordare.
 */
export type BirthdateView = 'card' | 'notice' | 'status';

export interface BirthdateViewInput {
  /** Nessuno scelto, in uso, oppure scelto ma non presente sul negozio. */
  state: BirthdateFieldState;
  /** Il campo da cui si legge oggi, per intero: `custom.data_di_nascita`. */
  configured: string;
  /** Il merchant ha chiesto di scegliere, o di rivedere la scelta fatta. */
  reopened: boolean;
  /**
   * Per quale campo l'avviso e' gia' stato chiuso, secondo il server. `null`
   * quando non risulta chiuso per nessuno.
   */
  dismissedFor: string | null;
}

/**
 * La regola, per intero.
 *
 * L'avviso verde e' una conferma, non uno stato: dice "fatto" una volta e poi
 * tace. Torna a parlare solo quando c'e' qualcosa di nuovo da confermare, cioe'
 * quando il campo diventa un altro — la chiusura si ricorda insieme AL CAMPO
 * per cui e' stata fatta, e non come un si'/no che avrebbe zittito per sempre
 * anche il giorno del cambio.
 *
 * Il campo scelto ma non presente sul negozio tiene aperto il riquadro: li'
 * c'e' scritto cosa non va, e ridurre quel guasto a un badge grigio vorrebbe
 * dire nasconderlo.
 */
export function birthdateView({
  state,
  configured,
  reopened,
  dismissedFor,
}: BirthdateViewInput): BirthdateView {
  // Sta scegliendo: qualunque cosa dicesse la riga di stato, adesso e' il
  // riquadro che ha la parola.
  if (reopened) return 'card';
  if (state === 'missing') return 'card';

  // Nessun campo scelto: la riga di stato lo dice in due parole e offre di
  // aggiungerlo. Il riquadro si apre a richiesta, non da solo: la tab Clienti
  // serve a guardare i clienti, non a compilare un modulo che nessuno ha
  // chiesto.
  if (state !== 'in_use') return 'status';

  // Da qui in poi la risposta dipende da cosa questa persona ha gia' chiuso.
  return dismissedFor === configured ? 'status' : 'notice';
}
