import { describe, it, expect } from 'vitest';
import { settleSubmission, type SubmissionPhase } from './fetcher-settle';

type D = { ok: boolean } | undefined;

function step(phase: SubmissionPhase, state: string, data: D, prev: D) {
  return settleSubmission(phase, state, data, prev);
}

describe('settleSubmission', () => {
  it('niente inviato: non decide niente', () => {
    expect(step('none', 'idle', undefined, undefined)).toEqual({ phase: 'none', outcome: null });
  });

  it("appena inviato e ancora fermo (prima che parta): non e' un fallimento", () => {
    expect(step('sent', 'idle', undefined, undefined)).toEqual({ phase: 'sent', outcome: null });
  });

  it('in volo: aspetta', () => {
    expect(step('sent', 'submitting', undefined, undefined)).toEqual({ phase: 'inflight', outcome: null });
    expect(step('inflight', 'loading', undefined, undefined)).toEqual({ phase: 'inflight', outcome: null });
  });

  it('tornato fermo con risposta ok → ok', () => {
    const data = { ok: true };
    expect(step('inflight', 'idle', data, undefined)).toEqual({ phase: 'none', outcome: 'ok' });
  });

  it('tornato fermo con risposta ok:false → failed', () => {
    expect(step('inflight', 'idle', { ok: false }, undefined)).toEqual({ phase: 'none', outcome: 'failed' });
  });

  it('tornato fermo SENZA risposta nuova (eccezione, rete giu) → failed, non resta in attesa', () => {
    expect(step('inflight', 'idle', undefined, undefined)).toEqual({ phase: 'none', outcome: 'failed' });
    // La risposta vecchia di un tentativo precedente non conta come nuova.
    const vecchia = { ok: true };
    expect(step('inflight', 'idle', vecchia, vecchia)).toEqual({ phase: 'none', outcome: 'failed' });
  });

  it('risposta nuova arrivata senza mai vedere la fase in volo → decide comunque', () => {
    expect(step('sent', 'idle', { ok: true }, undefined)).toEqual({ phase: 'none', outcome: 'ok' });
  });
});
