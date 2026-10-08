import { describe, it, expect } from 'vitest';
import { previewLines, canSaveMapping, isValidOAuthMessage } from './IntegrationsModal';

describe('previewLines', () => {
  it('returns empty array for empty samples', () => {
    expect(previewLines([], 'auto')).toEqual([]);
  });

  it('formats valid dates with DMY format', () => {
    const samples = [
      { raw: '15/03/1990', parsed: '1990-03-15' },
      { raw: '01/12/2000', parsed: '2000-12-01' },
    ];
    const result = previewLines(samples, 'DMY');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ raw: '15/03/1990', display: '15 Mar 1990' });
    expect(result[1]).toEqual({ raw: '01/12/2000', display: '1 Dec 2000' });
  });

  it('formats valid dates with MDY format', () => {
    const samples = [
      { raw: '03/15/1990', parsed: '1990-03-15' },
      { raw: '12/01/2000', parsed: '2000-12-01' },
    ];
    const result = previewLines(samples, 'MDY');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ raw: '03/15/1990', display: '15 Mar 1990' });
    expect(result[1]).toEqual({ raw: '12/01/2000', display: '1 Dec 2000' });
  });

  it('skips null parsed dates', () => {
    const samples = [
      { raw: '15/03/1990', parsed: '1990-03-15' },
      { raw: 'invalid', parsed: null },
    ];
    const result = previewLines(samples, 'DMY');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ raw: '15/03/1990', display: '15 Mar 1990' });
  });

  it('limits to maximum 5 previews', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      raw: `15/03/199${i}`,
      parsed: `199${i}-03-15`,
    }));
    const result = previewLines(samples, 'DMY');
    expect(result).toHaveLength(5);
  });
});

describe('canSaveMapping', () => {
  it('returns false when sourceKey is empty', () => {
    expect(canSaveMapping({ sourceKey: '', ambiguous: false, dateFormat: 'auto' })).toBe(false);
    expect(canSaveMapping({ sourceKey: '   ', ambiguous: false, dateFormat: 'auto' })).toBe(false);
  });

  it('returns false when ambiguous and format is auto', () => {
    expect(canSaveMapping({ sourceKey: 'birthdate', ambiguous: true, dateFormat: 'auto' })).toBe(false);
  });

  it('returns false when ambiguous and format is YMD', () => {
    expect(canSaveMapping({ sourceKey: 'birthdate', ambiguous: true, dateFormat: 'YMD' })).toBe(false);
  });

  it('returns true when ambiguous and format is DMY', () => {
    expect(canSaveMapping({ sourceKey: 'birthdate', ambiguous: true, dateFormat: 'DMY' })).toBe(true);
  });

  it('returns true when ambiguous and format is MDY', () => {
    expect(canSaveMapping({ sourceKey: 'birthdate', ambiguous: true, dateFormat: 'MDY' })).toBe(true);
  });

  it('returns true when not ambiguous and sourceKey is valid', () => {
    expect(canSaveMapping({ sourceKey: 'birthdate', ambiguous: false, dateFormat: 'auto' })).toBe(true);
    expect(canSaveMapping({ sourceKey: 'birthdate', ambiguous: false, dateFormat: 'DMY' })).toBe(true);
  });
});

describe('isValidOAuthMessage', () => {
  const appOrigin = 'https://app.example.com';
  const mockPopup = {} as Window;

  it('returns false when origin does not match', () => {
    const event = {
      origin: 'https://evil.com',
      source: mockPopup,
      data: { type: 'klaviyo-oauth', code: 'abc', state: 'xyz' },
    } as MessageEvent;
    expect(isValidOAuthMessage(event, mockPopup, appOrigin)).toBe(false);
  });

  it('returns false when source does not match popup window', () => {
    const otherWindow = {} as Window;
    const event = {
      origin: appOrigin,
      source: otherWindow,
      data: { type: 'klaviyo-oauth', code: 'abc', state: 'xyz' },
    } as MessageEvent;
    expect(isValidOAuthMessage(event, mockPopup, appOrigin)).toBe(false);
  });

  it('returns false when type is not klaviyo-oauth', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: { type: 'other-message', code: 'abc', state: 'xyz' },
    } as MessageEvent;
    expect(isValidOAuthMessage(event, mockPopup, appOrigin)).toBe(false);
  });

  it('returns false when code is missing', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: { type: 'klaviyo-oauth', state: 'xyz' },
    } as MessageEvent;
    expect(isValidOAuthMessage(event, mockPopup, appOrigin)).toBe(false);
  });

  it('returns false when state is missing', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: { type: 'klaviyo-oauth', code: 'abc' },
    } as MessageEvent;
    expect(isValidOAuthMessage(event, mockPopup, appOrigin)).toBe(false);
  });

  it('returns true when all checks pass', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: { type: 'klaviyo-oauth', code: 'abc', state: 'xyz' },
    } as MessageEvent;
    expect(isValidOAuthMessage(event, mockPopup, appOrigin)).toBe(true);
  });

  it('returns false for error messages even if they match origin and source', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: { type: 'klaviyo-oauth', ok: false, error: 'denied' },
    } as MessageEvent;
    // Error messages should still have code/state check fail
    expect(isValidOAuthMessage(event, mockPopup, appOrigin)).toBe(false);
  });
});
