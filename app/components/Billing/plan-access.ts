// Piani assegnati dall'owner a sua discrezione. Non si comprano, non si
// propongono, non compaiono in nessun elenco: chi li ha, li ha perche' glieli
// abbiamo dati noi.
//
// Da qui discendono due regole diverse, ed e' bene tenerle distinte perche' un
// giorno potrebbero non coincidere piu':
//  - chi ha uno di questi piani non vede la tab Piano (non c'e' niente da
//    comprare o aggiornare);
//  - nessuno di questi piani puo' essere offerto a qualcuno.
const OWNER_ASSIGNED_PLANS = new Set(['lifetime']);

/**
 * Se il merchant con questo piano puo' vedere e usare la tab Piano.
 *
 * Non basta nascondere la voce di menu: /plan resta digitabile a mano, quindi
 * la rotta usa la stessa funzione per rispondere 403.
 */
export function canAccessPlanTab(currentPlan: string | null | undefined): boolean {
  const id = (currentPlan ?? '').trim().toLowerCase();
  // Piano sconosciuto o non ancora assegnato: la tab resta visibile, e' il caso
  // normale di uno shop appena installato (Basic).
  return !OWNER_ASSIGNED_PLANS.has(id);
}

/**
 * Se questo piano puo' essere mostrato come scelta: nel listino, in una
 * proposta di aggiornamento, in un suggerimento.
 *
 * Da usare ovunque si costruisca un elenco di piani offerti. E' la stessa
 * risposta di `canAccessPlanTab` ma a una domanda diversa: chiamarla per nome
 * fa si' che chi aggiunge un nuovo punto in cui si propone un piano trovi la
 * regola cercando il concetto giusto, invece di scoprire per caso che una
 * funzione sul permesso di vedere una tab filtrava anche il catalogo.
 */
export function isSelectablePlan(planName: string | null | undefined): boolean {
  const id = (planName ?? '').trim().toLowerCase();
  return !OWNER_ASSIGNED_PLANS.has(id);
}
