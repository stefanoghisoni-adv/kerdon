/**
 * Quante righe si aggiornano e quante sono ferme.
 *
 * PERCHE' NON BASTA IL CONTEGGIO TOTALE. Perche' un totale rimette insieme le
 * due cose che vanno tenute separate: i dati che si aggiornano e quelli che
 * sono fermi perche' il piano ha un tetto. Mostrati insieme, un catalogo per
 * meta' congelato sembra un catalogo vivo — e il merchant prende decisioni
 * guardando numeri vecchi di mesi senza che niente glielo dica.
 *
 * Questo file decide solo se c'e' qualcosa da dire e con quale tono: il testo
 * sta nelle traduzioni, e la formattazione della data nel componente, che e'
 * l'unico posto in cui si sa in che fuso vive il merchant.
 */

export interface ScopeStatusInput {
  /** Righe che continuano ad aggiornarsi. */
  active?: number | null;
  /** Righe ferme: restano nel database del merchant, ma non cambiano piu'. */
  paused?: number | null;
  /** Data del dato piu' recente fra quelli fermi, come ISO. */
  pausedDataFrom?: string | null;
}

export interface ScopeStatus {
  active: number;
  paused: number;
  /** ISO valido, oppure null se non lo si sa dire. */
  pausedDataFrom: string | null;
}

/**
 * Ripulisce quello che arriva dalla rete.
 *
 * Numeri negativi, valori mancanti e date non riconoscibili diventano zero e
 * null: un avviso sui dati fermi che mostrasse "NaN righe" o "Invalid Date"
 * peserebbe piu' del problema che segnala.
 */
export function readScopeStatus(input: ScopeStatusInput | null | undefined): ScopeStatus {
  const active = Math.max(0, Math.trunc(Number(input?.active ?? 0)) || 0);
  const paused = Math.max(0, Math.trunc(Number(input?.paused ?? 0)) || 0);

  let pausedDataFrom: string | null = null;
  if (input?.pausedDataFrom) {
    const quando = new Date(input.pausedDataFrom);
    if (!Number.isNaN(quando.getTime())) pausedDataFrom = quando.toISOString();
  }

  return { active, paused, pausedDataFrom };
}

/**
 * Se l'avviso ha qualcosa da dire.
 *
 * Solo quando c'e' davvero qualcosa di fermo. Senza niente di fermo i due
 * numeri sarebbero uno solo, e un avviso che ripete quello che le altre card
 * dicono gia' insegna a non leggerlo.
 */
export function hasPausedRows(status: ScopeStatus): boolean {
  return status.paused > 0;
}
