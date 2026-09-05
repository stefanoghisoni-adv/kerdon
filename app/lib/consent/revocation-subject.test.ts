import { describe, it, expect } from 'vitest';
import {
  openSubject,
  revocationIdempotencyKey,
  sealSubject,
} from './revocation-subject.server';

const VISITATORE = 'corew_1700000000000_abcdefghijklmnopqrstuvwxyz012345';

describe('il soggetto cifrato', () => {
  // E' il punto su cui poggia tutto il ritentativo: il cookie e' scaduto, e se
  // il testo cifrato non si riaprisse non resterebbe niente da cancellare.
  it('si richiude e si riapre uguale', () => {
    expect(openSubject(sealSubject(VISITATORE))).toBe(VISITATORE);
  });

  it('non si legge senza riaprirlo', () => {
    expect(sealSubject(VISITATORE)).not.toContain(VISITATORE);
  });

  it('due volte lo stesso soggetto da due testi diversi', () => {
    // L'IV e' nuovo a ogni chiusura: due righe con lo stesso soggetto non si
    // riconoscono guardando la colonna cifrata. Chi vuole riconoscerle usa
    // l'impronta, che e' l'altra colonna.
    expect(sealSubject(VISITATORE)).not.toBe(sealSubject(VISITATORE));
  });

  it('un testo manomesso non si apre, e non solleva', () => {
    const chiuso = sealSubject(VISITATORE);
    const manomesso = `${chiuso.slice(0, -2)}00`;

    expect(openSubject(manomesso)).toBeNull();
  });

  // Restituisce null invece di sollevare perche' chi chiama e' il processore, e
  // un soggetto illeggibile deve diventare una lettera morta con un motivo
  // scritto — non un'eccezione che consuma cinque tentativi identici.
  it('una colonna vuota o senza forma da null', () => {
    expect(openSubject(null)).toBeNull();
    expect(openSubject('')).toBeNull();
    expect(openSubject('non-ha-la-forma')).toBeNull();
  });
});

describe('l impronta di deduplica', () => {
  const chiave = (over: Partial<Parameters<typeof revocationIdempotencyKey>[0]> = {}) =>
    revocationIdempotencyKey({
      shopId: 'negozio-1',
      scope: 'tracking_identity',
      subject: VISITATORE,
      ...over,
    });

  it('e stabile: la stessa revoca da sempre la stessa impronta', () => {
    expect(chiave()).toBe(chiave());
  });

  // Senza il negozio dentro, la stessa impronta varrebbe per lo stesso
  // identificativo in negozi diversi.
  it('cambia con il negozio', () => {
    expect(chiave({ shopId: 'negozio-2' })).not.toBe(chiave());
  });

  it('cambia con il soggetto', () => {
    expect(chiave({ subject: 'corew_altro' })).not.toBe(chiave());
  });

  it('non contiene il soggetto in chiaro', () => {
    expect(chiave()).not.toContain(VISITATORE);
    expect(chiave()).not.toContain('negozio-1');
  });
});
