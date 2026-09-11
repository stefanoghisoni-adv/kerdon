import { describe, it, expect } from 'vitest';
import {
  COMPLIANCE_BACKOFF_BASE_MS,
  COMPLIANCE_BACKOFF_MAX_MS,
  MAX_ATTEMPTS,
  complianceBackoffMs,
  isExhausted,
  nextComplianceAttemptAt,
  statusAfterFailure,
} from './compliance-model';

/**
 * Le regole del ritentativo, provate senza database.
 *
 * La piu' importante e' la prima, ed e' quella che era sbagliata: il tentativo
 * numero MAX_ATTEMPTS deve essere l'ultimo DAVVERO ESEGUITO. Prima il valore
 * arrivava incrementato due volte — una dalla presa, una da chi decideva la
 * lettera morta — e la richiesta di una persona vera si fermava al quarto
 * tentativo dicendo di averne fatti cinque.
 */
describe('quando si smette di riprovare', () => {
  it(`il tentativo numero ${MAX_ATTEMPTS} viene eseguito, non saltato`, () => {
    // Il penultimo non esaurisce niente: c'e' ancora l'ultimo da fare.
    expect(isExhausted(MAX_ATTEMPTS - 1)).toBe(false);
    expect(statusAfterFailure(MAX_ATTEMPTS - 1)).toBe('failed');

    // E l'ultimo esaurisce DOPO essere fallito, non prima di cominciare.
    expect(isExhausted(MAX_ATTEMPTS)).toBe(true);
    expect(statusAfterFailure(MAX_ATTEMPTS)).toBe('dead_letter');
  });

  it('il primo tentativo non e mai l ultimo', () => {
    expect(isExhausted(1)).toBe(false);
    expect(statusAfterFailure(1)).toBe('failed');
  });

  it('tutti i tentativi da 1 a MAX restano ritentabili tranne l ultimo', () => {
    const esiti = [];
    for (let n = 1; n <= MAX_ATTEMPTS; n++) esiti.push(statusAfterFailure(n));

    expect(esiti.filter((s) => s === 'failed')).toHaveLength(MAX_ATTEMPTS - 1);
    expect(esiti.at(-1)).toBe('dead_letter');
  });
});

describe('l attesa fra un tentativo e l altro', () => {
  it('raddoppia, invece di restare fissa', () => {
    // Un intervallo fisso — com'era — brucia i cinque tentativi in mezz'ora
    // rifacendo cinque volte lo stesso errore.
    const primo = complianceBackoffMs(1, () => 0);
    const secondo = complianceBackoffMs(2, () => 0);
    const terzo = complianceBackoffMs(3, () => 0);

    expect(secondo).toBe(primo * 2);
    expect(terzo).toBe(secondo * 2);
  });

  it('non cresce oltre il tetto', () => {
    expect(complianceBackoffMs(50, () => 1)).toBeLessThanOrEqual(COMPLIANCE_BACKOFF_MAX_MS);
  });

  it('non scende mai sotto la meta del dovuto', () => {
    // Il jitter sparpaglia, ma non deve poter riportare un ritentativo a
    // ridosso di quello appena fallito.
    expect(complianceBackoffMs(1, () => 0)).toBe(COMPLIANCE_BACKOFF_BASE_MS / 2);
  });

  it('due richieste fallite insieme non tornano pronte insieme', () => {
    // E' il caso vero: quando il progetto di un merchant smette di rispondere
    // falliscono tutte le sue richieste nello stesso giro. Senza jitter
    // rifarebbero la stessa ondata contro un servizio che si sta rialzando.
    const una = complianceBackoffMs(3, () => 0.1);
    const altra = complianceBackoffMs(3, () => 0.9);

    expect(una).not.toBe(altra);
  });

  it('l istante di ripresa si conta da adesso', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    const quando = nextComplianceAttemptAt(1, now, () => 0);

    expect(quando.getTime()).toBe(now.getTime() + COMPLIANCE_BACKOFF_BASE_MS / 2);
  });
});
