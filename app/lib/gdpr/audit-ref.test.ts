import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';

vi.mock('~/db.server', () => ({ prisma: {} }));

import { customerRef, verifyCustomerRef } from './audit.server';

const SHOP = 'negozio.myshopify.com';

// L'impronta e' quello che resta di una persona dopo che l'abbiamo cancellata:
// deve continuare a dire "quella riga riguardava qualcuno di preciso" senza
// permettere a nessuno di risalire a chi. Un hash semplice non bastava — il
// dominio si conosce e gli id sono numeri consecutivi, quindi bastava provarli.
describe('impronta di un riferimento GDPR', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.ENCRYPTION_SECRET = 'chiave-di-prova-per-i-test';
    delete process.env.GDPR_AUDIT_SECRET;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('non contiene l id della persona', () => {
    expect(customerRef(SHOP, '4021')).not.toContain('4021');
  });

  it('non e ricalcolabile da chi conosce solo dominio e id', () => {
    const indovinata = createHash('sha256').update(`${SHOP}:4021`).digest('hex');
    expect(customerRef(SHOP, '4021')).not.toBe(indovinata);
    expect(customerRef(SHOP, '4021').startsWith('v2:')).toBe(true);
  });

  it('la stessa persona nello stesso negozio da sempre la stessa impronta', () => {
    expect(customerRef(SHOP, '4021')).toBe(customerRef(SHOP, 4021));
  });

  it('lo stesso id in due negozi non e la stessa impronta', () => {
    expect(customerRef(SHOP, '4021')).not.toBe(customerRef('altro.myshopify.com', '4021'));
  });

  it('cambiando la chiave cambia l impronta', () => {
    const prima = customerRef(SHOP, '4021');
    process.env.GDPR_AUDIT_SECRET = 'una-chiave-tutta-sua';
    expect(customerRef(SHOP, '4021')).not.toBe(prima);
  });

  it('senza nessuna chiave configurata lo dice, invece di firmare con niente', () => {
    delete process.env.ENCRYPTION_SECRET;
    delete process.env.GDPR_AUDIT_SECRET;
    expect(() => customerRef(SHOP, '4021')).toThrow(/GDPR_AUDIT_SECRET|ENCRYPTION_SECRET/);
  });
});

describe('verifica di un riferimento', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.ENCRYPTION_SECRET = 'chiave-di-prova-per-i-test';
    delete process.env.GDPR_AUDIT_SECRET;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('riconosce la persona giusta e non un altra', () => {
    const ref = customerRef(SHOP, '4021');
    expect(verifyCustomerRef(ref, SHOP, '4021')).toBe(true);
    expect(verifyCustomerRef(ref, SHOP, '4022')).toBe(false);
    expect(verifyCustomerRef(ref, 'altro.myshopify.com', '4021')).toBe(false);
  });

  // Le tracce scritte prima di questo cambiamento non si possono riscrivere, e
  // una traccia illeggibile non serve a nessuno: finche' sono dentro il termine
  // di conservazione restano verificabili.
  it('riconosce anche le impronte vecchie, senza prefisso', () => {
    const v1 = createHash('sha256').update(`${SHOP}:4021`).digest('hex');
    expect(verifyCustomerRef(v1, SHOP, '4021')).toBe(true);
    expect(verifyCustomerRef(v1, SHOP, '4022')).toBe(false);
  });

  // Un confronto a tempo costante pretende due valori della stessa lunghezza:
  // un riferimento corto e' un riferimento diverso, non un guasto.
  it('un riferimento di lunghezza diversa e falso, non un errore', () => {
    expect(() => verifyCustomerRef('v2:corto', SHOP, '4021')).not.toThrow();
    expect(verifyCustomerRef('v2:corto', SHOP, '4021')).toBe(false);
    expect(verifyCustomerRef('', SHOP, '4021')).toBe(false);
  });
});
