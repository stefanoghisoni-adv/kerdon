import { describe, it, expect } from 'vitest';
import { previewLines, canSaveMapping, isValidOAuthMessage } from './IntegrationsModal';
import { INTEGRATIONS } from '~/lib/integrations/registry';

describe('IntegrationsModal', () => {
  describe('modal title from registry', () => {
    it('returns Klaviyo name for klaviyo provider', () => {
      const integration = INTEGRATIONS.find((i) => i.id === 'klaviyo');
      expect(integration?.name).toBe('Klaviyo');
    });

    it('returns empty string when provider not found', () => {
      const integration = INTEGRATIONS.find((i) => i.id === 'nonexistent' as any);
      expect(integration).toBeUndefined();
    });
  });
});

describe('previewLines', () => {
  it('returns empty array for empty samples', () => {
    expect(previewLines([], 'auto')).toEqual([]);
  });

  // I4 FIX: Use ambiguous raw values and assert different outputs for DMY vs MDY
  it('formats ambiguous dates differently for DMY vs MDY', () => {
    const samples = [
      { raw: '03/04/1990', parsed: null },
      { raw: '05/12/1985', parsed: null },
    ];

    const dmy = previewLines(samples, 'DMY');
    expect(dmy).toHaveLength(2);
    expect(dmy[0]).toEqual({ raw: '03/04/1990', display: '3 Apr 1990' });
    expect(dmy[1]).toEqual({ raw: '05/12/1985', display: '5 Dec 1985' });

    const mdy = previewLines(samples, 'MDY');
    expect(mdy).toHaveLength(2);
    expect(mdy[0]).toEqual({ raw: '03/04/1990', display: '4 Mar 1990' });
    expect(mdy[1]).toEqual({ raw: '05/12/1985', display: '12 May 1985' });
  });

  // I2 FIX: Re-parses with format, so empty previews for ambiguous+auto become non-empty with explicit format
  it('shows previews for ambiguous values when format is explicit', () => {
    const samples = [
      { raw: '03/04/1990', parsed: null },
    ];

    // With 'auto', ambiguous values return empty preview
    const auto = previewLines(samples, 'auto');
    expect(auto).toHaveLength(0);

    // With explicit format, they parse and show
    const dmy = previewLines(samples, 'DMY');
    expect(dmy).toHaveLength(1);
    expect(dmy[0]).toEqual({ raw: '03/04/1990', display: '3 Apr 1990' });
  });

  it('limits to maximum 5 previews', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      raw: `15/03/199${i}`,
      parsed: null,
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

  // I3 FIX: Handles empty string for dateFormat
  it('returns false when ambiguous and format is empty string', () => {
    expect(canSaveMapping({ sourceKey: 'birthdate', ambiguous: true, dateFormat: '' })).toBe(false);
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

  // I14 FIX: Rejects when popupRef is null
  it('returns {ok:false} when popup window is null', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: { type: 'klaviyo-oauth', code: 'abc', state: 'xyz' },
    } as MessageEvent;
    const result = isValidOAuthMessage(event, null, appOrigin);
    expect(result).toEqual({ ok: false });
  });

  it('returns {ok:false} when origin does not match', () => {
    const event = {
      origin: 'https://evil.com',
      source: mockPopup,
      data: { type: 'klaviyo-oauth', code: 'abc', state: 'xyz' },
    } as MessageEvent;
    const result = isValidOAuthMessage(event, mockPopup, appOrigin);
    expect(result).toEqual({ ok: false });
  });

  it('returns {ok:false} when source does not match popup window', () => {
    const otherWindow = {} as Window;
    const event = {
      origin: appOrigin,
      source: otherWindow,
      data: { type: 'klaviyo-oauth', code: 'abc', state: 'xyz' },
    } as MessageEvent;
    const result = isValidOAuthMessage(event, mockPopup, appOrigin);
    expect(result).toEqual({ ok: false });
  });

  // I14 FIX: Rejects non-object or null data
  it('returns {ok:false} when data is not an object', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: 'not an object',
    } as MessageEvent;
    const result = isValidOAuthMessage(event, mockPopup, appOrigin);
    expect(result).toEqual({ ok: false });
  });

  it('returns {ok:false} when data is null', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: null,
    } as MessageEvent;
    const result = isValidOAuthMessage(event, mockPopup, appOrigin);
    expect(result).toEqual({ ok: false });
  });

  it('returns {ok:false} when type is not klaviyo-oauth', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: { type: 'other-message', code: 'abc', state: 'xyz' },
    } as MessageEvent;
    const result = isValidOAuthMessage(event, mockPopup, appOrigin);
    expect(result).toEqual({ ok: false });
  });

  it('returns {ok:false} when code is missing', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: { type: 'klaviyo-oauth', state: 'xyz' },
    } as MessageEvent;
    const result = isValidOAuthMessage(event, mockPopup, appOrigin);
    expect(result).toEqual({ ok: false });
  });

  it('returns {ok:false} when state is missing', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: { type: 'klaviyo-oauth', code: 'abc' },
    } as MessageEvent;
    const result = isValidOAuthMessage(event, mockPopup, appOrigin);
    expect(result).toEqual({ ok: false });
  });

  it('returns {ok:true, data} when all checks pass', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: { type: 'klaviyo-oauth', code: 'abc', state: 'xyz' },
    } as MessageEvent;
    const result = isValidOAuthMessage(event, mockPopup, appOrigin);
    expect(result).toEqual({
      ok: true,
      data: { code: 'abc', state: 'xyz' },
    });
  });

  // I5 FIX: Accepts error messages under same origin+source checks
  it('returns {ok:false, error} for error messages from popup', () => {
    const event = {
      origin: appOrigin,
      source: mockPopup,
      data: { type: 'klaviyo-oauth', ok: false, error: 'denied' },
    } as MessageEvent;
    const result = isValidOAuthMessage(event, mockPopup, appOrigin);
    expect(result).toEqual({ ok: false, error: 'denied' });
  });

  it('rejects error messages from wrong origin', () => {
    const event = {
      origin: 'https://evil.com',
      source: mockPopup,
      data: { type: 'klaviyo-oauth', ok: false, error: 'denied' },
    } as MessageEvent;
    const result = isValidOAuthMessage(event, mockPopup, appOrigin);
    expect(result).toEqual({ ok: false });
  });
});
