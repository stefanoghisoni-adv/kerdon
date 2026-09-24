// app/components/Shipping/feedback.test.ts
//
// Tests for feedback from shipping action responses

import { describe, it as testIt, expect } from 'vitest';
import { feedbackFromActionData } from './feedback';
import type { ShippingActionData } from './feedback';
import { it as itDict } from '~/lib/i18n/it';

describe('feedbackFromActionData', () => {
  testIt('save-option-cost success: shows toast and marks option saved', () => {
    const data: ShippingActionData = {
      intent: 'save-option-cost',
      success: true,
    };
    const result = feedbackFromActionData(data, itDict);
    expect(result.toast).toEqual({
      content: itDict.shipping.optionModal.saveSuccess,
      error: false,
    });
    expect(result.optionSaved).toBe(true);
    expect(result.optionError).toBeNull();
  });

  testIt('save-option-cost failure: shows toast and error message', () => {
    const data: ShippingActionData = {
      intent: 'save-option-cost',
      success: false,
      error: 'shipping.errors.invalidLinearCost',
    };
    const result = feedbackFromActionData(data, itDict);
    expect(result.toast).toEqual({
      content: itDict.shipping.optionModal.saveError,
      error: true,
    });
    expect(result.optionSaved).toBe(false);
    expect(result.optionError).toBe(itDict.shipping.errors.invalidLinearCost);
  });

  testIt('save-option-cost failure with unknown error: shows generic message', () => {
    const data: ShippingActionData = {
      intent: 'save-option-cost',
      success: false,
      error: 'unknown_error_code',
    };
    const result = feedbackFromActionData(data, itDict);
    expect(result.optionError).toBe(itDict.shipping.optionModal.saveError);
  });
});
