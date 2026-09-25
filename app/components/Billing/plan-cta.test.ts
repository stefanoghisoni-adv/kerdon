import { describe, it, expect } from 'vitest';
import {
  planButtonLabel,
  planButtonState,
  billingOutcome,
  billingBanner,
} from './plan-cta';
import { it as itDict } from '~/lib/i18n/it';
import { en as enDict } from '~/lib/i18n/en';

describe('planButtonLabel', () => {
  it('restituisce "Piano attuale" se isCurrent è true', () => {
    expect(planButtonLabel('Starter', true, itDict)).toBe('Piano attuale');
    expect(planButtonLabel('Professional', true, enDict)).toBe('Current plan');
  });

  it('restituisce "Scegli <nome>" se isCurrent è false', () => {
    expect(planButtonLabel('Starter', false, itDict)).toBe('Scegli Starter');
    expect(planButtonLabel('Professional', false, enDict)).toBe('Choose Professional');
  });
});

describe('planButtonState', () => {
  it('disabilita solo il piano attuale quando non c\'è sottomissione', () => {
    const current = planButtonState('Starter', true, null);
    expect(current.disabled).toBe(true);
    expect(current.loading).toBe(false);

    const other = planButtonState('Professional', false, null);
    expect(other.disabled).toBe(false);
    expect(other.loading).toBe(false);
  });

  it('mette in loading solo il piano in sottomissione', () => {
    const submitting = planButtonState('Professional', false, 'Professional');
    expect(submitting.loading).toBe(true);
    expect(submitting.disabled).toBe(true);
  });

  it('disabilita tutti i piani quando c\'è una sottomissione in corso', () => {
    // Piano attuale
    const current = planButtonState('Starter', true, 'Professional');
    expect(current.disabled).toBe(true);
    expect(current.loading).toBe(false);

    // Piano diverso da quello in sottomissione
    const other = planButtonState('Scale', false, 'Professional');
    expect(other.disabled).toBe(true);
    expect(other.loading).toBe(false);

    // Piano in sottomissione
    const submitting = planButtonState('Professional', false, 'Professional');
    expect(submitting.disabled).toBe(true);
    expect(submitting.loading).toBe(true);
  });
});

describe('billingOutcome', () => {
  it('restituisce null se il parametro è null', () => {
    expect(billingOutcome(null)).toBe(null);
  });

  it('restituisce "success" se il parametro è "ok"', () => {
    expect(billingOutcome('ok')).toBe('success');
  });

  it('restituisce "error" per qualsiasi valore diverso da "ok"', () => {
    expect(billingOutcome('ko')).toBe('error');
    expect(billingOutcome('cancelled')).toBe('error');
    expect(billingOutcome('failed')).toBe('error');
    expect(billingOutcome('')).toBe('error');
    expect(billingOutcome('anything')).toBe('error');
  });
});

describe('billingBanner', () => {
  it('sceglie il banner dell esito, nella lingua di chi guarda', () => {
    expect(billingBanner('success', itDict).title).toBe('Piano aggiornato');
    expect(billingBanner('success', enDict).title).toBe('Plan updated');
  });

  it('il fallito dice che non e cambiato niente: e la prima domanda di chi lo legge', () => {
    expect(billingBanner('error', itDict).message).toContain('non è stato completato');
    expect(billingBanner('error', enDict).message).toContain('didn’t go through');
  });
});
