/**
 * Quando un invio fatto con un fetcher si e' concluso, e come.
 *
 * Guardare solo `fetcher.data` non basta: se la richiesta solleva (risposta
 * d'autenticazione lanciata, rete giu') `data` resta quello di prima, o
 * `undefined`, e chi aspetta una risposta nuova resta in attesa per sempre —
 * un pulsante che gira senza fine. Qui l'invio si segue per fasi:
 *
 *   - `sent`: inviato, ma il fetcher puo' essere ancora fermo per un render
 *     (la partenza non e' sincrona). Non e' un fallimento.
 *   - `inflight`: il fetcher e' partito.
 *   - di nuovo fermo dopo `inflight` (o fermo con una risposta nuova): e'
 *     finita. Risposta nuova con `ok` → `ok`; qualunque altra cosa (ok:false,
 *     nessuna risposta nuova) → `failed`.
 *
 * Una decisione per invio: dopo l'esito la fase torna `none`.
 */
export type SubmissionPhase = 'none' | 'sent' | 'inflight';

export function settleSubmission<D extends { ok: boolean }>(
  phase: SubmissionPhase,
  state: string,
  data: D | undefined,
  previousData: D | undefined,
): { phase: SubmissionPhase; outcome: 'ok' | 'failed' | null } {
  if (phase === 'none') return { phase, outcome: null };
  if (state !== 'idle') return { phase: 'inflight', outcome: null };
  const fresh = data !== undefined && data !== previousData;
  // Ancora fermo e nessuna risposta nuova: non e' partito, si aspetta. Se
  // invece la risposta nuova c'e' gia' (fase in volo mai vista da un render),
  // e' finita comunque.
  if (phase === 'sent' && !fresh) return { phase, outcome: null };
  return { phase: 'none', outcome: fresh && data.ok ? 'ok' : 'failed' };
}
