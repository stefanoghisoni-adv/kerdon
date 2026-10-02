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
 * - Numbers starting with '+' or '00' are parsed as international
 * - Other numbers are parsed as national using the provided countryCode
 * - Returns null if the number is invalid or countryCode is missing for national numbers
 */
export function normalizePhone(
  v: string | null | undefined,
  countryCode: string | null
): string | null {
  if (v === null || v === undefined) {
    return null;
  }

  const trimmed = v.trim();
  if (trimmed === '') {
    return null;
  }

  try {
    // Check if the number starts with + or 00 (international format)
    const startsWithPlus = trimmed.startsWith('+');
    const startsWithDoubleZero = trimmed.startsWith('00');

    if (startsWithPlus || startsWithDoubleZero) {
      // Parse as international
      const phoneNumber = startsWithPlus
        ? parsePhoneNumber(trimmed)
        : parsePhoneNumber('+' + trimmed.substring(2));

      if (!phoneNumber || !phoneNumber.isValid()) {
        return null;
      }

      // Return E.164 format without the '+'
      return phoneNumber.number.substring(1);
    } else {
      // Parse as national - requires country code
      if (!countryCode) {
        return null;
      }

      const phoneNumber = parsePhoneNumber(trimmed, countryCode as any);

      if (!phoneNumber || !phoneNumber.isValid()) {
        return null;
      }

      // Return E.164 format without the '+'
      return phoneNumber.number.substring(1);
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

  customers.forEach((customer, index) => {
    // Index by ID
    byId.set(customer.shopifyCustomerId, index);

    // Index by normalized email
    const email = normalizeEmail(customer.email);
    if (email) {
      const existing = byEmail.get(email) || [];
      byEmail.set(email, [...existing, index]);
    }

    // Index by normalized phone
    const phone = normalizePhone(customer.phone, customer.countryCode);
    if (phone) {
      const existing = byPhone.get(phone) || [];
      byPhone.set(phone, [...existing, index]);
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
    const customerIndex = idx.byId.get(p.shopifyCustomerId);
    if (customerIndex !== undefined) {
      // Get the actual customer ID from the candidates array position
      // We need to reconstruct this from the map structure
      // Actually, the byId map maps shopifyCustomerId to index,
      // so we can return the shopifyCustomerId directly
      return { customerId: p.shopifyCustomerId, level: 'id' };
    }
  }

  // Level 2: Try matching by email
  const normalizedEmail = normalizeEmail(p.email);
  if (normalizedEmail) {
    const emailMatches = idx.byEmail.get(normalizedEmail);
    if (emailMatches) {
      if (emailMatches.length === 1) {
        // Exactly one match - get the customer ID
        const customerIndex = emailMatches[0];
        // We need to get the shopifyCustomerId from the index
        // The byId map has shopifyCustomerId as key and index as value
        // So we need to find the key with this value
        for (const [customerId, index] of idx.byId.entries()) {
          if (index === customerIndex) {
            return { customerId, level: 'email' };
          }
        }
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
        // Exactly one match - get the customer ID
        const customerIndex = phoneMatches[0];
        for (const [customerId, index] of idx.byId.entries()) {
          if (index === customerIndex) {
            return { customerId, level: 'phone' };
          }
        }
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
