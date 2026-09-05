import { describe, it, expect } from 'vitest';
import {
  MAX_REVOCATION_ATTEMPTS,
  REVOCATION_BACKOFF_MAX_MS,
  REVOCATION_SCOPES,
  allStepsSettled,
  failureSummary,
  isExhausted,
  isRevocationScope,
  nextRevocationAttemptAt,
  revocationBackoffMs,
  statusAfterAttempt,
  type RevocationStep,
} from './revocation-model';

const ORA = new Date('2026-09-05T12:00:00.000Z');

describe('gli scopi', () => {
  it('sono un elenco chiuso', () => {
    expect(isRevocationScope('tracking_identity')).toBe(true);
    expect(isRevocationScope('marketing_consent')).toBe(false);
    expect(isRevocationScope(undefined)).toBe(false);
  });

  // Il ritiro del consenso al marketing NON e' qui, ed e' una scelta: quello
  // non cancella niente e ha gia' due strade durevoli sue (il 500 del webhook e
  // `sync_repairs`).
  it('non comprendono il consenso al marketing', () => {
    expect(REVOCATION_SCOPES).toEqual(['tracking_identity']);
  });
});

describe('il distanziamento', () => {
  it('cresce raddoppiando', () => {
    const uno = revocationBackoffMs(1, () => 0);
    const due = revocationBackoffMs(2, () => 0);
    const tre = revocationBackoffMs(3, () => 0);

    expect(due).toBe(uno * 2);
    expect(tre).toBe(due * 2);
  });

  // Senza jitter, tutte le revoche di un negozio il cui progetto smette di
  // rispondere tornerebbero pronte nello stesso istante e rifarebbero la stessa
  // ondata contro un servizio che si sta ancora rialzando.
  it('sparpaglia i ritentativi, senza mai scendere sotto la meta', () => {
    const minimo = revocationBackoffMs(3, () => 0);
    const massimo = revocationBackoffMs(3, () => 1);

    expect(massimo).toBe(minimo * 2);
    expect(revocationBackoffMs(3, () => 0.5)).toBeGreaterThan(minimo);
    expect(revocationBackoffMs(3, () => 0.5)).toBeLessThan(massimo);
  });

  it('ha un tetto: oltre, raddoppiare non serve piu a niente', () => {
    expect(revocationBackoffMs(50, () => 1)).toBe(REVOCATION_BACKOFF_MAX_MS);
  });

  it('sposta in avanti, mai indietro', () => {
    expect(nextRevocationAttemptAt(1, ORA, () => 0).getTime()).toBeGreaterThan(ORA.getTime());
  });
});

describe('la lettera morta', () => {
  it('arriva al tetto dei tentativi, non prima', () => {
    expect(isExhausted(MAX_REVOCATION_ATTEMPTS - 1)).toBe(false);
    expect(isExhausted(MAX_REVOCATION_ATTEMPTS)).toBe(true);
  });

  it('un fallimento sotto il tetto rimette in attesa, non abbandona', () => {
    expect(statusAfterAttempt('retry', 1)).toBe('queued');
    expect(statusAfterAttempt('retry', MAX_REVOCATION_ATTEMPTS)).toBe('dead_letter');
  });

  it('chi si dichiara definitivo non consuma i tentativi', () => {
    expect(statusAfterAttempt('dead_letter', 1)).toBe('dead_letter');
  });

  it('la riuscita conclude', () => {
    expect(statusAfterAttempt('done', 1)).toBe('completed');
  });
});

describe('i passi', () => {
  const passo = (
    step: RevocationStep['step'],
    outcome: RevocationStep['outcome'],
    detail?: string,
  ): RevocationStep => ({ step, outcome, ...(detail ? { detail } : {}) });

  // La distinzione che tutto il lavoro esiste per tenere: una tabella assente
  // non e' un errore, e' lavoro che non c'era da fare.
  it('una tabella assente non impedisce di dichiarare applicata la revoca', () => {
    expect(
      allStepsSettled([
        passo('customer_unlink', 'skipped', 'tabella assente'),
        passo('merge_pointers', 'done'),
        passo('user_delete', 'done'),
      ]),
    ).toBe(true);
  });

  it('un errore vero non diventa mai successo', () => {
    expect(
      allStepsSettled([
        passo('customer_unlink', 'done'),
        passo('merge_pointers', 'failed', 'connessione rifiutata'),
        passo('user_delete', 'done'),
      ]),
    ).toBe(false);
  });

  it('il riepilogo nomina i passi falliti, non il soggetto', () => {
    const riepilogo = failureSummary([
      passo('customer_unlink', 'failed', 'connessione rifiutata'),
      passo('merge_pointers', 'skipped', 'tabella assente'),
      passo('user_delete', 'failed', 'timeout'),
    ]);

    expect(riepilogo).toBe('customer_unlink: connessione rifiutata; user_delete: timeout');
    // Il riepilogo finisce in un allarme: un identificativo di browser li'
    // dentro sarebbe esattamente il dato che la revoca doveva togliere.
    expect(riepilogo).not.toMatch(/corew_/);
  });

  it('senza fallimenti non c e niente da riportare', () => {
    expect(failureSummary([passo('user_delete', 'done')])).toBeNull();
  });
});
