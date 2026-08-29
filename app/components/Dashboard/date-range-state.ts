/**
 * Quando "Applica" ha qualcosa da applicare.
 *
 * Il selettore lavora su una BOZZA: il calendario, i due campi e i periodi
 * cambiano quella, e il filtro di fuori non si muove finche' non si conferma.
 * Qui dentro c'e' la sola domanda che il piede deve saper rispondere — questo
 * comando adesso farebbe qualcosa? — tenuta fuori dal componente perche' e'
 * una risposta che si puo' provare senza disegnare niente.
 *
 * Le date sono giorni di calendario `AAAA-MM-GG`. In quel formato il confronto
 * fra stringhe e' un confronto fra date, e non serve costruire una Date per
 * sapere chi viene prima.
 */

import type { DateRange } from '~/lib/dates/ranges';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface DraftVerdict {
  /** Ci sono due date, e sono scritte come si deve. */
  isComplete: boolean;
  /** L'inizio non viene dopo la fine. */
  isChronological: boolean;
  /** Qualcuna delle due e' oltre oggi. */
  containsFutureDate: boolean;
  /** La bozza dice qualcosa di diverso da quello che e' gia' applicato. */
  isDirty: boolean;
  /** Le cinque risposte messe insieme. */
  canApply: boolean;
}

/**
 * Il verdetto sulla bozza.
 *
 * `isDirty` e' quello che si dimentica sempre. Le altre quattro condizioni
 * riguardano bozze rotte, e una bozza rotta si nota; una bozza identica a
 * quella gia' applicata invece e' perfettamente valida — semplicemente non ha
 * niente da fare. Aprire il selettore, guardare, e trovarsi "Applica" acceso e'
 * un comando che promette un cambiamento che non avverra': si preme, la tendina
 * si chiude, e non succede niente. Spento dice la verita': qui non c'e' ancora
 * nulla da confermare.
 */
export function draftVerdict(
  draft: DateRange,
  committed: DateRange,
  todayIso: string,
): DraftVerdict {
  const isComplete = DAY.test(draft.from) && DAY.test(draft.to);
  const isChronological = isComplete && draft.from <= draft.to;
  const containsFutureDate = isComplete && (draft.from > todayIso || draft.to > todayIso);
  const isDirty = draft.from !== committed.from || draft.to !== committed.to;

  return {
    isComplete,
    isChronological,
    containsFutureDate,
    isDirty,
    canApply: isComplete && isChronological && !containsFutureDate && isDirty,
  };
}
