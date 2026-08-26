import { describe, it, expect } from 'vitest';
import { normalizePhone, normalizeBirthdate } from './customer-format';

describe('normalizePhone', () => {
  it('toglie tutto quello che non e una cifra, "+" compreso', () => {
    // E' la forma che le piattaforme confrontano: se il testo di partenza non e'
    // identico al loro, l'hash e' diverso e la corrispondenza non avviene.
    expect(normalizePhone('+39 333 123 4567')).toBe('393331234567');
    expect(normalizePhone('+1 (555) 010-9999')).toBe('15550109999');
    expect(normalizePhone('0039.333.1234567')).toBe('00393331234567');
  });

  it('il prefisso non si inventa: un numero senza resta senza', () => {
    // Aggiungerne uno per somiglianza produrrebbe corrispondenze con persone
    // che non sono quelle.
    expect(normalizePhone('333 1234567')).toBe('3331234567');
  });

  it('niente numero, niente stringa vuota', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone('+++')).toBeNull();
  });

  it('applicarla due volte non cambia il risultato', () => {
    const once = normalizePhone('+39 333 123 4567');
    expect(normalizePhone(once)).toBe(once);
  });
});

describe('normalizeBirthdate', () => {
  it('scrive sempre YYYYMMDD, da qualunque forma arrivi', () => {
    expect(normalizeBirthdate('1985-04-23')).toBe('19850423');
    expect(normalizeBirthdate('1985/04/23')).toBe('19850423');
    expect(normalizeBirthdate('23/04/1985')).toBe('19850423');
    expect(normalizeBirthdate('19850423')).toBe('19850423');
  });

  it('mette lo zero davanti a mesi e giorni di una cifra', () => {
    expect(normalizeBirthdate('1985-4-3')).toBe('19850403');
    expect(normalizeBirthdate('3/4/1985')).toBe('19850403');
  });

  it('regge una data ISO con l ora in coda', () => {
    expect(normalizeBirthdate('1985-04-23T00:00:00Z')).toBe('19850423');
  });

  it('una data che non esiste vale null, non una data qualsiasi', () => {
    // Il 31 febbraio passa qualunque controllo fatto sui soli intervalli: una
    // data sbagliata nel pubblico e' peggio di una assente, perche' la seconda
    // si vede e la prima no.
    expect(normalizeBirthdate('1985-02-31')).toBeNull();
    expect(normalizeBirthdate('1985-13-01')).toBeNull();
    expect(normalizeBirthdate('19851301')).toBeNull();
  });

  it('quello che non e una data vale null', () => {
    expect(normalizeBirthdate(null)).toBeNull();
    expect(normalizeBirthdate('')).toBeNull();
    expect(normalizeBirthdate('non lo so')).toBeNull();
    expect(normalizeBirthdate('1985')).toBeNull();
  });

  it('applicarla due volte non cambia il risultato', () => {
    const once = normalizeBirthdate('23/04/1985');
    expect(normalizeBirthdate(once)).toBe(once);
  });
});
