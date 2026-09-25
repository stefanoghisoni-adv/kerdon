// app/components/Shipping/feedback.ts
//
// Cosa vede il merchant dopo ogni azione della pagina Spedizioni.
//
// PERCHE' L'INTENTO STA NELLA RISPOSTA. La pagina usa un solo fetcher per
// tutte le azioni (importazione zone, tariffe, opzioni, righe di imballo), e per sapere a quale
// risponde il server serve l'intento. Leggerlo da `fetcher.formData` non
// funziona: Remix lo azzera quando il fetcher torna a riposo, cioe' proprio nel
// momento in cui arriva la risposta. Cosi' ogni azione lo rimanda indietro, e
// la decisione di cosa mostrare vive qui, in una funzione pura che si prova
// senza montare la rotta.

import type { Dictionary } from '~/lib/i18n/context';

export type ShippingIntent =
  | 'sync-zones'
  | 'save-zone-rates'
  | 'save-option-cost'
  | 'save-category'
  | 'delete-category'
  | 'save-rule'
  | 'delete-rule'
  | 'save-packaging-defaults';

/** La forma comune delle risposte dell'azione di /spedizioni. */
export interface ShippingActionData {
  intent?: ShippingIntent | null;
  success: boolean;
  error?: string;
  /**
   * Com'e' andato il ricalcolo dei costi sugli ordini fatto nel salvataggio
   * (recompute-inline.server): 'updated' se Dashboard e Clienti mostrano gia'
   * i numeri nuovi, 'pending' se il resto e' in coda. Assente o null: nessuna
   * promessa sui numeri, il toast resta quello di sempre.
   */
  numbers?: 'updated' | 'pending' | null;
}

export interface ShippingFeedback {
  /** Il toast da mostrare, uno solo: successo ed errore non convivono. */
  toast: { content: string; error: boolean } | null;
  /** Il permesso per leggere le zone manca: banner fisso, non un toast. */
  scopeError: boolean;
  /** Le tariffe sono salvate: la modale si puo' chiudere. */
  zoneSaved: boolean;
  /** Le tariffe sono state rifiutate: il motivo, da mostrare nella modale aperta. */
  zoneError: string | null;
  /** I costi opzione sono salvati: la modale si puo' chiudere. */
  optionSaved: boolean;
  /** I costi opzione sono stati rifiutati: il motivo, da mostrare nella modale aperta. */
  optionError: string | null;
  /** Categoria o regola salvata o eliminata: la sua modale si puo' chiudere. */
  packagingSaved: boolean;
  /** Categoria o regola rifiutata: il motivo, da mostrare nella modale aperta. */
  packagingError: string | null;
}

const NIENTE: ShippingFeedback = {
  toast: null,
  scopeError: false,
  zoneSaved: false,
  zoneError: null,
  optionSaved: false,
  optionError: null,
  packagingSaved: false,
  packagingError: null,
};

/**
 * Il testo di una chiave di errore restituita dal server, se ne ha uno.
 *
 * Solo sotto i due rami di errori della pagina: una chiave qualsiasi non deve
 * poter pescare un testo a caso dal dizionario.
 */
export function testoDiErrore(chiave: string | undefined, t: Dictionary): string | null {
  if (!chiave) return null;
  const rami: Array<[string, Record<string, unknown>]> = [
    ['shipping.errors.', t.shipping.errors],
    ['shipping.packaging.errors.', t.shipping.packaging.errors],
  ];
  for (const [prefisso, ramo] of rami) {
    if (!chiave.startsWith(prefisso)) continue;
    const valore = ramo[chiave.slice(prefisso.length)];
    return typeof valore === 'string' ? valore : null;
  }
  return null;
}

/**
 * Il testo di un salvataggio riuscito, con cosa e' successo ai numeri.
 *
 * Un toast solo e non due: App Bridge li mostra uno sopra l'altro e il secondo
 * copre il primo. "Aggiornati" solo se il ricalcolo e' finito davvero: dire
 * che i numeri sono nuovi quando non lo sono ancora e' peggio di non dire
 * niente, perche' il merchant va a guardarli subito.
 */
function testoDiSuccesso(base: string, data: ShippingActionData, t: Dictionary): string {
  if (data.numbers === 'updated') return t.shipping.numbers.updated(base);
  if (data.numbers === 'pending') return t.shipping.numbers.pending(base);
  return base;
}

export function feedbackFromActionData(data: ShippingActionData | undefined, t: Dictionary): ShippingFeedback {
  if (!data) return NIENTE;
  const successo = (base: string) => ({ content: testoDiSuccesso(base, data, t), error: false });

  switch (data.intent) {
    case 'sync-zones':
      if (data.success) return { ...NIENTE, toast: successo(t.shipping.syncSuccess) };
      // Il permesso mancante non e' un singhiozzo da riprovare fra poco: serve
      // un gesto del merchant, e un toast sparirebbe prima di essere letto.
      if (data.error === 'scope_error') return { ...NIENTE, scopeError: true };
      return { ...NIENTE, toast: { content: t.shipping.syncError, error: true } };

    case 'save-zone-rates':
      if (data.success) {
        return { ...NIENTE, toast: successo(t.shipping.modal.saveSuccess), zoneSaved: true };
      }
      // La modale resta aperta con quello che il merchant aveva scritto, e il
      // motivo accanto: chiuderla farebbe sembrare riuscito un rifiuto.
      return {
        ...NIENTE,
        toast: { content: t.shipping.modal.saveError, error: true },
        zoneError: testoDiErrore(data.error, t) ?? t.shipping.modal.saveError,
      };

    case 'save-option-cost':
      if (data.success) {
        return { ...NIENTE, toast: successo(t.shipping.optionModal.saveSuccess), optionSaved: true };
      }
      // La modale resta aperta con quello che il merchant aveva scritto, e il
      // motivo accanto: chiuderla farebbe sembrare riuscito un rifiuto.
      return {
        ...NIENTE,
        toast: { content: t.shipping.optionModal.saveError, error: true },
        optionError: testoDiErrore(data.error, t) ?? t.shipping.optionModal.saveError,
      };

    case 'save-category':
    case 'delete-category':
    case 'save-rule':
    case 'delete-rule': {
      if (data.success) {
        const testi = {
          'save-category': t.shipping.packaging.categories.saved,
          'delete-category': t.shipping.packaging.categories.deleted,
          'save-rule': t.shipping.packaging.rules.saved,
          'delete-rule': t.shipping.packaging.rules.deleted,
        };
        return { ...NIENTE, toast: successo(testi[data.intent]), packagingSaved: true };
      }
      // Come per le tariffe: la modale resta aperta con il motivo accanto,
      // compresa l'eliminazione bloccata da una regola.
      const motivo = testoDiErrore(data.error, t) ?? t.shipping.packaging.saveError;
      return { ...NIENTE, toast: { content: motivo, error: true }, packagingError: motivo };
    }

    case 'save-packaging-defaults':
      if (data.success) return { ...NIENTE, toast: successo(t.shipping.packaging.saveSuccess) };
      return {
        ...NIENTE,
        toast: { content: testoDiErrore(data.error, t) ?? t.shipping.packaging.saveError, error: true },
      };

    default:
      // Nessun intento riconosciuto: meglio nessun messaggio che uno sbagliato.
      return NIENTE;
  }
}
