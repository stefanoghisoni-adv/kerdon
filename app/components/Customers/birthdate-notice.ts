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
 * Non e' logica di rete ne' di database: e' cosa questa persona ha gia' visto.
 * Per questo vive nel browser e non sul negozio.
 */

import type { BirthdateFieldState } from '~/lib/customers/birthdate-metafield';

/** Dove si ricorda per quale campo l'avviso di conferma e' gia' stato chiuso. */
export const DISMISSED_KEY = 'coreward.birthdate.dismissedFor';

/**
 * Cosa sta a schermo.
 *
 * `pending` non e' uno stato del negozio: e' il momento in cui non si e'
 * ancora letto il browser. Serve perche' la memoria di cio' che e' stato
 * chiuso non esiste durante il render sul server, e senza questo stato la
 * pagina renderebbe l'avviso di la' e la riga di stato di qua — con
 * l'idratazione che se ne accorge, e un lampo visibile a ogni apertura.
 */
export type BirthdateView = 'pending' | 'card' | 'notice' | 'status';

export interface BirthdateViewInput {
  /** Nessuno scelto, in uso, oppure scelto ma non presente sul negozio. */
  state: BirthdateFieldState;
  /** Il campo da cui si legge oggi, per intero: `custom.data_di_nascita`. */
  configured: string;
  /** Il merchant ha chiesto di scegliere, o di rivedere la scelta fatta. */
  reopened: boolean;
  /**
   * Per quale campo l'avviso e' gia' stato chiuso. `undefined` = non si e'
   * ancora letto (server, o primo render prima dell'effetto).
   */
  dismissedFor: string | null | undefined;
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
  if (dismissedFor === undefined) return 'pending';
  return dismissedFor === configured ? 'status' : 'notice';
}

/**
 * Per quale campo l'avviso e' gia' stato chiuso, secondo il browser.
 *
 * Ogni accesso e' protetto: in una finestra anonima, o con i dati dei siti
 * bloccati, `localStorage` puo' lanciare al solo essere nominato. In quel caso
 * l'avviso ricompare, che e' il male minore.
 */
export function readDismissedFor(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function rememberDismissedFor(field: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, field);
  } catch {
    // Senza memoria l'avviso tornera' alla prossima apertura: fastidioso, non
    // rotto.
  }
}
