import { describe, it, expect } from 'vitest';
import { canAccessPlanTab, isSelectablePlan } from './plan-access';

describe('canAccessPlanTab', () => {
  it('nega l\'accesso al piano lifetime', () => {
    expect(canAccessPlanTab('lifetime')).toBe(false);
    // Come arriva dal DB o da un input sporco: case e spazi non devono aggirare il blocco.
    expect(canAccessPlanTab('  LIFETIME  ')).toBe(false);
    expect(canAccessPlanTab('Lifetime')).toBe(false);
  });

  it('consente l\'accesso ai piani a pagamento e al free', () => {
    expect(canAccessPlanTab('basic')).toBe(true);
    expect(canAccessPlanTab('growth')).toBe(true);
    expect(canAccessPlanTab('scale')).toBe(true);
    expect(canAccessPlanTab('core')).toBe(true);
  });

  it('non blocca quando il piano non e\' noto', () => {
    // Shop appena installato o record mancante: meglio mostrare la tab che
    // nasconderla a chi invece deve poter fare upgrade.
    expect(canAccessPlanTab(null)).toBe(true);
    expect(canAccessPlanTab(undefined)).toBe(true);
    expect(canAccessPlanTab('')).toBe(true);
    expect(canAccessPlanTab('   ')).toBe(true);
  });
});

describe('isSelectablePlan', () => {
  it('il piano assegnato dall owner non e mai offribile', () => {
    // E' la regola: lo assegna l'owner a sua discrezione, e non deve comparire
    // in nessun elenco, proposta o suggerimento.
    expect(isSelectablePlan('lifetime')).toBe(false);
    expect(isSelectablePlan('  LIFETIME  ')).toBe(false);
    expect(isSelectablePlan('Lifetime')).toBe(false);
  });

  it('i piani commerciali si possono offrire', () => {
    expect(isSelectablePlan('basic')).toBe(true);
    expect(isSelectablePlan('growth')).toBe(true);
    expect(isSelectablePlan('scale')).toBe(true);
    expect(isSelectablePlan('core')).toBe(true);
  });
});
