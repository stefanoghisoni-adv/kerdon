import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { matchParameterCount, toMetaUserData } from './customer-data';

const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('toMetaUserData', () => {
  it('cifra i dati dichiarati dalla persona', () => {
    const payload = toMetaUserData({ email: 'Anna.Rossi@Example.COM ' });
    expect(payload.em).toEqual([sha('anna.rossi@example.com')]);
  });

  it('fbp e fbc non si cifrano: li ha creati Meta, non la persona', () => {
    // Cifrarli li renderebbe inservibili — Meta li confronta com'e'.
    const payload = toMetaUserData({ fbp: 'fb.1.123.456', fbc: 'fb.1.123.abc' });
    expect(payload.fbp).toBe('fb.1.123.456');
    expect(payload.fbc).toBe('fb.1.123.abc');
  });

  it('i nomi perdono accenti, spazi e punteggiatura', () => {
    // "De Luca" e "deluca" devono dare la stessa impronta, altrimenti meta'
    // dei clienti non verrebbe riconosciuta per un apostrofo.
    expect(toMetaUserData({ lastName: "De Luca" }).ln).toEqual([sha('deluca')]);
    expect(toMetaUserData({ lastName: 'Perón' }).ln).toEqual([sha('peron')]);
    expect(toMetaUserData({ firstName: "D'Angelo" }).fn).toEqual([sha('dangelo')]);
  });

  it('il telefono resta di sole cifre, senza zeri davanti', () => {
    expect(toMetaUserData({ phone: '+39 333 / 12.34.567' }).ph).toEqual([sha('393331234567')]);
    expect(toMetaUserData({ phone: '0039 333 1234567' }).ph).toEqual([sha('393331234567')]);
  });

  it('il paese entra solo se e un codice di due lettere', () => {
    // "italia" cifrato non corrisponde a niente: meglio non mandarlo.
    expect(toMetaUserData({ country: 'IT' }).country).toEqual([sha('it')]);
    expect(toMetaUserData({ country: 'Italia' }).country).toBeUndefined();
  });

  it('il CAP perde gli spazi', () => {
    expect(toMetaUserData({ zip: 'SW1A 1AA' }).zp).toEqual([sha('sw1a1aa')]);
  });

  it('provincia e citta seguono la regola dei nomi', () => {
    expect(toMetaUserData({ state: 'Emilia-Romagna' }).st).toEqual([sha('emiliaromagna')]);
    expect(toMetaUserData({ city: 'Reggio Emilia' }).ct).toEqual([sha('reggioemilia')]);
  });

  it("l'id del cliente viaggia cifrato come gli altri", () => {
    expect(toMetaUserData({ externalId: 12345 }).external_id).toEqual([sha('12345')]);
  });

  it('quello che non c e non si manda', () => {
    // Una stringa vuota cifrata sarebbe l'impronta del nulla: non corrisponde a
    // nessuno e abbassa il punteggio di qualita' del match.
    const payload = toMetaUserData({ email: '', phone: null, firstName: '   ' });
    expect(payload).toEqual({});
    expect(matchParameterCount(payload)).toBe(0);
  });

  it('conta i parametri mandati davvero', () => {
    const payload = toMetaUserData({
      email: 'a@b.it',
      phone: '+39 333 1234567',
      firstName: 'Anna',
      lastName: 'Rossi',
      city: 'Milano',
      state: 'MI',
      zip: '20100',
      country: 'IT',
      externalId: 7,
      fbp: 'fb.1.2.3',
      fbc: 'fb.1.2.abc',
    });

    expect(matchParameterCount(payload)).toBe(11);
  });
});
