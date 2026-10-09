import { describe, it, expect } from 'vitest';
import { decideDateFormat, shouldShowAccountName, normalizeConnectionStatus } from './KlaviyoDetail';

describe('decideDateFormat', () => {
  const ambiguousProperty = {
    key: 'birthdate',
    samples: [],
    format: 'auto' as const,
    ambiguous: true,
  };

  const nonAmbiguousPropertyDMY = {
    key: 'birthdate',
    samples: [],
    format: 'DMY' as const,
    ambiguous: false,
  };

  it('returns current format when property is undefined', () => {
    expect(
      decideDateFormat({
        property: undefined,
        savedMapping: null,
        currentFormat: 'DMY',
        sourceKeyChanged: false,
      })
    ).toBe('DMY');
  });

  // I3 FIX Round 3: Key unchanged → keep current format (user's choice persists)
  it('keeps user choice (DMY) when source key unchanged', () => {
    expect(
      decideDateFormat({
        property: ambiguousProperty,
        savedMapping: null,
        currentFormat: 'DMY',
        sourceKeyChanged: false,
      })
    ).toBe('DMY');
  });

  // I3 FIX Round 3: Key changed to ambiguous without mapping → require choice
  it('returns empty string when key changes to ambiguous property without saved mapping', () => {
    expect(
      decideDateFormat({
        property: ambiguousProperty,
        savedMapping: null,
        currentFormat: 'DMY',
        sourceKeyChanged: true,
      })
    ).toBe('');
  });

  it('returns detected format for non-ambiguous property when key changed', () => {
    expect(
      decideDateFormat({
        property: nonAmbiguousPropertyDMY,
        savedMapping: null,
        currentFormat: '',
        sourceKeyChanged: true,
      })
    ).toBe('DMY');
  });

  it('returns saved format for ambiguous property with saved mapping when key changed', () => {
    expect(
      decideDateFormat({
        property: ambiguousProperty,
        savedMapping: { sourceKey: 'birthdate', dateFormat: 'MDY' },
        currentFormat: '',
        sourceKeyChanged: true,
      })
    ).toBe('MDY');
  });

  it('returns empty string for ambiguous property without saved mapping when key changed', () => {
    expect(
      decideDateFormat({
        property: ambiguousProperty,
        savedMapping: null,
        currentFormat: '',
        sourceKeyChanged: true,
      })
    ).toBe('');
  });

  it('returns empty string when key changes and saved mapping is for different property', () => {
    expect(
      decideDateFormat({
        property: { ...ambiguousProperty, key: 'custom_birthdate' },
        savedMapping: { sourceKey: 'other_property', dateFormat: 'MDY' },
        currentFormat: '',
        sourceKeyChanged: true,
      })
    ).toBe('');
  });

  it('keeps current format for non-ambiguous when key unchanged', () => {
    // Even for non-ambiguous, if key hasn't changed, keep what user had
    expect(
      decideDateFormat({
        property: nonAmbiguousPropertyDMY,
        savedMapping: null,
        currentFormat: 'MDY',
        sourceKeyChanged: false,
      })
    ).toBe('MDY');
  });
});

describe('shouldShowAccountName', () => {
  it('returns true for non-empty account name', () => {
    expect(shouldShowAccountName('My Account')).toBe(true);
  });

  it('returns false for null', () => {
    expect(shouldShowAccountName(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(shouldShowAccountName(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(shouldShowAccountName('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(shouldShowAccountName('   ')).toBe(false);
  });

  it('returns true for account name with surrounding spaces', () => {
    expect(shouldShowAccountName('  My Account  ')).toBe(true);
  });
});

describe('normalizeConnectionStatus', () => {
  it('returns connected for connected', () => {
    expect(normalizeConnectionStatus('connected')).toBe('connected');
  });

  it('returns needs_reconnect for needs_reconnect', () => {
    expect(normalizeConnectionStatus('needs_reconnect')).toBe('needs_reconnect');
  });

  it('returns not_connected for disconnected', () => {
    expect(normalizeConnectionStatus('disconnected')).toBe('not_connected');
  });

  it('returns not_connected for none', () => {
    expect(normalizeConnectionStatus('none')).toBe('not_connected');
  });

  it('returns not_connected for undefined', () => {
    expect(normalizeConnectionStatus(undefined)).toBe('not_connected');
  });

  it('returns not_connected for unknown values', () => {
    expect(normalizeConnectionStatus('unknown')).toBe('not_connected');
    expect(normalizeConnectionStatus('invalid')).toBe('not_connected');
    expect(normalizeConnectionStatus('')).toBe('not_connected');
  });
});
