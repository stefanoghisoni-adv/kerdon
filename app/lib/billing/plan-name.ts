// Modulo puro: nessun import da un `.server`, cosi' vale identico nei loader,
// nei componenti e nei worker.

import { resolvePlanName } from './plan-tiers';

// Il nome del piano sta scritto in tre posti che non cambiano insieme: il
// listino (`plans.plan_name`), il piano del negozio (`shops.current_plan`) e il
// piano dell'ultima sincronizzazione (`shops.last_synced_plan`). Basta
// rinominare un piano nel listino perche' i tre smettano di combaciare alla
// lettera, e un confronto esatto direbbe "piano cambiato" a ogni caricamento o
// non troverebbe piu' il piano fra quelli in memoria.
//
// Per la ricerca sul database c'e' `findPlanByName` in find-plan.server.ts:
// questa e' la stessa regola applicata ai confronti in memoria.

/** Il nome del piano ridotto alla forma con cui si confronta. */
export function normalizePlanName(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

/**
 * Due nomi indicano lo stesso piano, a meno di maiuscole e spazi ai bordi.
 *
 * Anche un nome di prima e il suo successore sono lo stesso piano ("Pro" e
 * "Growth"): e' il caso di uno state firmato o di un tentativo di acquisto
 * partiti prima del cambio di listino. Solo i nomi che non si possono
 * confondere, pero' — Free/Pro/Business/Enterprise: i nomi di mezzo
 * (Core/Growth/Scale del 23 settembre) sono anche nomi di oggi e restano quello
 * che dicono. Vedi `resolvePlanName`.
 */
export function samePlanName(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizePlanName(resolvePlanName(a));
  // Due nomi vuoti non sono "lo stesso piano": sono due assenze.
  if (!left) return false;
  return left === normalizePlanName(resolvePlanName(b));
}
