import { describe, it, expect } from 'vitest';
import { normalizePlanName, samePlanName } from './plan-name';

describe('normalizePlanName', () => {
  it('minuscolo e senza spazi ai bordi', () => {
    expect(normalizePlanName('  Growth  ')).toBe('growth');
    expect(normalizePlanName('SCALE')).toBe('scale');
  });

  it('assente → stringa vuota', () => {
    expect(normalizePlanName(null)).toBe('');
    expect(normalizePlanName(undefined)).toBe('');
  });
});

describe('samePlanName', () => {
  it('stesso piano scritto diversamente', () => {
    expect(samePlanName('growth', 'Growth')).toBe(true);
    expect(samePlanName('  Free ', 'basic')).toBe(true);
  });

  it('piani diversi', () => {
    expect(samePlanName('growth', 'scale')).toBe(false);
  });

  it('due assenze non sono lo stesso piano', () => {
    expect(samePlanName(null, null)).toBe(false);
    expect(samePlanName('', '   ')).toBe(false);
    expect(samePlanName('growth', null)).toBe(false);
  });
});
