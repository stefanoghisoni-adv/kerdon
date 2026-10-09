import { parsePhoneNumber } from 'libphonenumber-js/min';

export interface CandidateCustomer {
  shopifyCustomerId: number;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
}

export interface MatchIndices {
  byId: Map<number, number>;
  byEmail: Map<string, number[]>;
  byPhone: Map<string, number[]>;
}

export interface SourceProfile {
  shopifyCustomerId: number | null;
  email: string | null;
  phone: string | null;
  countryCode: string | null;
}

export type MatchResult =
  | { customerId: number; level: 'id' | 'email' | 'phone' }
  | { skipped: 'no_match' | 'ambiguous' };

/**
 * Normalizes an email address to lowercase and trims whitespace.
 * Returns null for empty strings, null, or undefined.
 */
export function normalizeEmail(v: string | null | undefined): string | null {
  if (v === null || v === undefined) {
    return null;
  }

  const trimmed = v.trim();
  if (trimmed === '') {
    return null;
  }

  return trimmed.toLowerCase();
}

/**
 * Normalizes a phone number to E.164 format (digits only, no '+').
 *
 * For stored digits (storedDigits: true):
 * - Try parsing as international by adding '+' first
 * - If invalid, fall back to national parsing with countryCode
 *
 * For raw values (default):
 * - Numbers starting with '+' or '00' are parsed as international
 * - Other numbers are parsed as national using the provided countryCode
 * - Returns null if countryCode is missing for national numbers
 */
export function normalizePhone(
  v: string | null | undefined,
  countryCode: string | null,
  opts?: { storedDigits?: boolean }
): string | null {
  if (v === null || v === undefined) {
    return null;
  }

  const trimmed = v.trim();
  if (trimmed === '') {
    return null;
  }

  // For stored digits: try international first, then fall back to national
  if (opts?.storedDigits) {
    try {
      // Try parsing as international by adding '+'
      const phoneNumber = parsePhoneNumber('+' + trimmed);

      if (phoneNumber?.isValid()) {
        return phoneNumber.number.substring(1); // E.164 without '+'
      }
    } catch {
      // International parsing failed, fall through to national
    }

    // Fallback: try parsing as national with country code
    if (countryCode) {
      try {
        const phoneNumber = parsePhoneNumber(trimmed, countryCode as any);

        if (phoneNumber?.isValid()) {
          return phoneNumber.number.substring(1);
        }
      } catch {
        // National parsing also failed
      }
    }

    return null;
  }

  // For raw values: check prefix first
  try {
    const startsWithPlus = trimmed.startsWith('+');
    const startsWithDoubleZero = trimmed.startsWith('00');

    if (startsWithPlus || startsWithDoubleZero) {
      // Parse as international
      const phoneNumber = startsWithPlus
        ? parsePhoneNumber(trimmed)
        : parsePhoneNumber('+' + trimmed.substring(2));

      if (phoneNumber?.isValid()) {
        return phoneNumber.number.substring(1); // E.164 without '+'
      }

      return null;
    } else {
      // Parse as national - requires country code
      if (!countryCode) {
        return null;
      }

      const phoneNumber = parsePhoneNumber(trimmed, countryCode as any);

      if (phoneNumber?.isValid()) {
        return phoneNumber.number.substring(1);
      }

      return null;
    }
  } catch (error) {
    // Invalid phone number
    return null;
  }
}

/**
 * Builds lookup indices for efficient profile matching.
 * Creates maps for ID, email, and phone lookups.
 */
export function buildIndices(
  customers: readonly CandidateCustomer[]
): MatchIndices {
  const byId = new Map<number, number>();
  const byEmail = new Map<string, number[]>();
  const byPhone = new Map<string, number[]>();

  customers.forEach((customer) => {
    // Index by ID
    byId.set(customer.shopifyCustomerId, customer.shopifyCustomerId);

    // Index by normalized email - store customerIds directly
    const email = normalizeEmail(customer.email);
    if (email) {
      const existing = byEmail.get(email) || [];
      byEmail.set(email, [...existing, customer.shopifyCustomerId]);
    }

    // Index by normalized phone - store customerIds directly
    const phone = normalizePhone(customer.phone, customer.countryCode, { storedDigits: true });
    if (phone) {
      const existing = byPhone.get(phone) || [];
      byPhone.set(phone, [...existing, customer.shopifyCustomerId]);
    }
  });

  return { byId, byEmail, byPhone };
}

/**
 * Matches a source profile to a candidate customer.
 *
 * Matching priority:
 * 1. Shopify customer ID (if present and in candidates)
 * 2. Email (must have exactly 1 match, ≥2 = ambiguous)
 * 3. Phone (must have exactly 1 match, ≥2 = ambiguous)
 *
 * Returns:
 * - Match with level if found
 * - { skipped: 'ambiguous' } if any level had multiple matches
 * - { skipped: 'no_match' } if no match found
 */
export function matchProfile(
  p: SourceProfile,
  idx: MatchIndices
): MatchResult {
  let hasAmbiguity = false;

  // Level 1: Try matching by ID
  if (p.shopifyCustomerId !== null) {
    if (idx.byId.has(p.shopifyCustomerId)) {
      return { customerId: p.shopifyCustomerId, level: 'id' };
    }
  }

  // Level 2: Try matching by email
  const normalizedEmail = normalizeEmail(p.email);
  if (normalizedEmail) {
    const emailMatches = idx.byEmail.get(normalizedEmail);
    if (emailMatches) {
      if (emailMatches.length === 1) {
        return { customerId: emailMatches[0], level: 'email' };
      } else if (emailMatches.length >= 2) {
        hasAmbiguity = true;
      }
    }
  }

  // Level 3: Try matching by phone
  const normalizedPhone = normalizePhone(p.phone, p.countryCode);
  if (normalizedPhone) {
    const phoneMatches = idx.byPhone.get(normalizedPhone);
    if (phoneMatches) {
      if (phoneMatches.length === 1) {
        return { customerId: phoneMatches[0], level: 'phone' };
      } else if (phoneMatches.length >= 2) {
        hasAmbiguity = true;
      }
    }
  }

  // No match found
  if (hasAmbiguity) {
    return { skipped: 'ambiguous' };
  } else {
    return { skipped: 'no_match' };
  }
}
