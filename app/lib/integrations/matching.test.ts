import { describe, it, expect } from 'vitest';
import {
  normalizeEmail,
  normalizePhone,
  buildIndices,
  matchProfile,
  type CandidateCustomer,
  type MatchIndices,
  type SourceProfile,
} from './matching';

describe('normalizeEmail', () => {
  it('normalizes email to lowercase and trims', () => {
    expect(normalizeEmail('  Test@Example.COM  ')).toBe('test@example.com');
  });

  it('returns null for empty string', () => {
    expect(normalizeEmail('')).toBe(null);
  });

  it('returns null for null/undefined', () => {
    expect(normalizeEmail(null)).toBe(null);
    expect(normalizeEmail(undefined)).toBe(null);
  });
});

describe('normalizePhone', () => {
  it('parses international format with + prefix', () => {
    expect(normalizePhone('+39 333 123 4567', null)).toBe('393331234567');
  });

  it('parses international format with 00 prefix', () => {
    expect(normalizePhone('0039 333 123 4567', null)).toBe('393331234567');
  });

  it('parses national format with country code', () => {
    expect(normalizePhone('333 1234567', 'IT')).toBe('393331234567');
  });

  it('returns null for national format without country code', () => {
    expect(normalizePhone('333 1234567', null)).toBe(null);
  });

  it('returns null for invalid phone number', () => {
    expect(normalizePhone('invalid', 'IT')).toBe(null);
  });

  it('returns null for null/undefined', () => {
    expect(normalizePhone(null, 'IT')).toBe(null);
    expect(normalizePhone(undefined, 'IT')).toBe(null);
  });
});

describe('buildIndices', () => {
  it('builds indices correctly', () => {
    const customers: CandidateCustomer[] = [
      { shopifyCustomerId: 1, email: 'test@example.com', phone: '393331234567', countryCode: 'IT' },
      { shopifyCustomerId: 2, email: 'other@example.com', phone: '393339876543', countryCode: 'IT' },
    ];

    const indices = buildIndices(customers);

    expect(indices.byId.get(1)).toBe(0);
    expect(indices.byId.get(2)).toBe(1);
    expect(indices.byEmail.get('test@example.com')).toEqual([0]);
    expect(indices.byEmail.get('other@example.com')).toEqual([1]);
    expect(indices.byPhone.get('393331234567')).toEqual([0]);
    expect(indices.byPhone.get('393339876543')).toEqual([1]);
  });

  it('handles duplicate emails', () => {
    const customers: CandidateCustomer[] = [
      { shopifyCustomerId: 1, email: 'shared@example.com', phone: '393331234567', countryCode: 'IT' },
      { shopifyCustomerId: 2, email: 'shared@example.com', phone: '393339876543', countryCode: 'IT' },
    ];

    const indices = buildIndices(customers);

    expect(indices.byEmail.get('shared@example.com')).toEqual([0, 1]);
  });

  it('handles duplicate phones', () => {
    const customers: CandidateCustomer[] = [
      { shopifyCustomerId: 1, email: 'first@example.com', phone: '393331234567', countryCode: 'IT' },
      { shopifyCustomerId: 2, email: 'second@example.com', phone: '393331234567', countryCode: 'IT' },
    ];

    const indices = buildIndices(customers);

    expect(indices.byPhone.get('393331234567')).toEqual([0, 1]);
  });

  it('handles null emails and phones', () => {
    const customers: CandidateCustomer[] = [
      { shopifyCustomerId: 1, email: null, phone: null, countryCode: 'IT' },
    ];

    const indices = buildIndices(customers);

    expect(indices.byId.get(1)).toBe(0);
    expect(indices.byEmail.size).toBe(0);
    expect(indices.byPhone.size).toBe(0);
  });
});

describe('matchProfile', () => {
  const customers: CandidateCustomer[] = [
    { shopifyCustomerId: 100, email: 'customer1@example.com', phone: '393331111111', countryCode: 'IT' },
    { shopifyCustomerId: 200, email: 'customer2@example.com', phone: '393332222222', countryCode: 'IT' },
    { shopifyCustomerId: 300, email: 'shared@example.com', phone: '393333333333', countryCode: 'IT' },
    { shopifyCustomerId: 400, email: 'shared@example.com', phone: '393334444444', countryCode: 'IT' },
  ];

  const indices = buildIndices(customers);

  it('matches by ID when present and in candidates', () => {
    const profile: SourceProfile = {
      shopifyCustomerId: 100,
      email: 'different@example.com',
      phone: null,
      countryCode: null,
    };

    const result = matchProfile(profile, indices);

    expect(result).toEqual({ customerId: 100, level: 'id' });
  });

  it('matches by email (case-insensitive) when ID not present', () => {
    const profile: SourceProfile = {
      shopifyCustomerId: null,
      email: 'Customer1@Example.COM',
      phone: null,
      countryCode: null,
    };

    const result = matchProfile(profile, indices);

    expect(result).toEqual({ customerId: 100, level: 'email' });
  });

  it('matches by phone when email is shared', () => {
    const profile: SourceProfile = {
      shopifyCustomerId: null,
      email: 'shared@example.com',
      phone: '393333333333',
      countryCode: 'IT',
    };

    const result = matchProfile(profile, indices);

    expect(result).toEqual({ customerId: 300, level: 'phone' });
  });

  it('returns ambiguous when email is shared and no phone', () => {
    const profile: SourceProfile = {
      shopifyCustomerId: null,
      email: 'shared@example.com',
      phone: null,
      countryCode: null,
    };

    const result = matchProfile(profile, indices);

    expect(result).toEqual({ skipped: 'ambiguous' });
  });

  it('matches phone in different formats', () => {
    const profile: SourceProfile = {
      shopifyCustomerId: null,
      email: null,
      phone: '+39 333 1111111',
      countryCode: 'IT',
    };

    const result = matchProfile(profile, indices);

    expect(result).toEqual({ customerId: 100, level: 'phone' });
  });

  it('matches national phone with country code', () => {
    const profile: SourceProfile = {
      shopifyCustomerId: null,
      email: null,
      phone: '333 1111111',
      countryCode: 'IT',
    };

    const result = matchProfile(profile, indices);

    expect(result).toEqual({ customerId: 100, level: 'phone' });
  });

  it('does not match national phone without country code', () => {
    const profile: SourceProfile = {
      shopifyCustomerId: null,
      email: null,
      phone: '333 1234567',
      countryCode: null,
    };

    const result = matchProfile(profile, indices);

    expect(result).toEqual({ skipped: 'no_match' });
  });

  it('returns no_match when nothing matches', () => {
    const profile: SourceProfile = {
      shopifyCustomerId: null,
      email: 'unknown@example.com',
      phone: '393339999999',
      countryCode: 'IT',
    };

    const result = matchProfile(profile, indices);

    expect(result).toEqual({ skipped: 'no_match' });
  });

  it('falls through to email when ID is present but not in candidates', () => {
    const profile: SourceProfile = {
      shopifyCustomerId: 999, // Not in candidates
      email: 'customer1@example.com',
      phone: null,
      countryCode: null,
    };

    const result = matchProfile(profile, indices);

    expect(result).toEqual({ customerId: 100, level: 'email' });
  });

  it('handles invalid phone number gracefully', () => {
    const profile: SourceProfile = {
      shopifyCustomerId: null,
      email: null,
      phone: 'invalid',
      countryCode: 'IT',
    };

    const result = matchProfile(profile, indices);

    expect(result).toEqual({ skipped: 'no_match' });
  });
});
