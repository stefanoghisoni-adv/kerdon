// app/components/Shipping/feedback.ts
//
// Cosa vede il merchant dopo ogni azione della pagina Spedizioni.
//
// PERCHE' L'INTENTO STA NELLA RISPOSTA. La pagina usa un solo fetcher per le
// tre azioni (importazione zone, tariffe, packaging), e per sapere a quale
// risponde il server serve l'intento. Leggerlo da `fetcher.formData` non
// funziona: Remix lo azzera quando il fetcher torna a riposo, cioe' proprio nel
// momento in cui arriva la risposta. Cosi' ogni azione lo rimanda indietro, e
// la decisione di cosa mostrare vive qui, in una funzione pura che si prova
// senza montare la rotta.

import type { Dictionary } from '~/lib/i18n/context';

export type ShippingIntent = 'sync-zones' | 'save-zone-rates' | 'save-packaging' | 'save-option-cost';

/** La forma comune delle risposte dell'azione di /spedizioni. */
export interface ShippingActionData {
  intent?: ShippingIntent | null;
  success: boolean;
  error?: string;
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
}

const NIENTE: ShippingFeedback = {
  toast: null,
  scopeError: false,
  zoneSaved: false,
  zoneError: null,
  optionSaved: false,
  optionError: null,
};

/**
 * Il testo di una chiave di errore restituita dal server, se ne ha uno.
 *
 * Solo sotto i due rami di errori della pagina: una chiave qualsiasi non deve
 * poter pescare un testo a caso dal dizionario.
 */
function testoDiErrore(chiave: string | undefined, t: Dictionary): string | null {
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

export function feedbackFromActionData(data: ShippingActionData | undefined, t: Dictionary): ShippingFeedback {
  if (!data) return NIENTE;

  switch (data.intent) {
    case 'sync-zones':
      if (data.success) return { ...NIENTE, toast: { content: t.shipping.syncSuccess, error: false } };
      // Il permesso mancante non e' un singhiozzo da riprovare fra poco: serve
      // un gesto del merchant, e un toast sparirebbe prima di essere letto.
      if (data.error === 'scope_error') return { ...NIENTE, scopeError: true };
      return { ...NIENTE, toast: { content: t.shipping.syncError, error: true } };

    case 'save-zone-rates':
      if (data.success) {
        return { ...NIENTE, toast: { content: t.shipping.modal.saveSuccess, error: false }, zoneSaved: true };
      }
      // La modale resta aperta con quello che il merchant aveva scritto, e il
      // motivo accanto: chiuderla farebbe sembrare riuscito un rifiuto.
      return {
        ...NIENTE,
        toast: { content: t.shipping.modal.saveError, error: true },
        zoneError: testoDiErrore(data.error, t) ?? t.shipping.modal.saveError,
      };

    case 'save-packaging':
      if (data.success) return { ...NIENTE, toast: { content: t.shipping.packaging.saveSuccess, error: false } };
      return {
        ...NIENTE,
        toast: { content: testoDiErrore(data.error, t) ?? t.shipping.packaging.saveError, error: true },
      };

    case 'save-option-cost':
      if (data.success) {
        return { ...NIENTE, toast: { content: t.shipping.optionModal.saveSuccess, error: false }, optionSaved: true };
      }
      // La modale resta aperta con quello che il merchant aveva scritto, e il
      // motivo accanto: chiuderla farebbe sembrare riuscito un rifiuto.
      return {
        ...NIENTE,
        toast: { content: t.shipping.optionModal.saveError, error: true },
        optionError: testoDiErrore(data.error, t) ?? t.shipping.optionModal.saveError,
      };

    default:
      // Nessun intento riconosciuto: meglio nessun messaggio che uno sbagliato.
      return NIENTE;
  }
}
