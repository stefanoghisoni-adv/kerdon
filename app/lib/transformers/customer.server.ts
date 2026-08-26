import type { ShopifyCustomer, SupabaseCustomerRow } from '~/types/shopify';
import { normalizeBirthdate, normalizePhone } from './customer-format';

/**
 * Transforms a Shopify customer payload into a single Supabase row matching the
 * `customers` table created by api.supabase.create-tables.
 *
 * Marketing consent: Shopify deprecated the flat `accepts_marketing` /
 * `marketing_opt_in_level` fields in favor of the nested
 * `email_marketing_consent` object. We read the nested form when present and
 * fall back to the legacy fields for older API payloads.
 */
export function transformCustomer(customer: ShopifyCustomer): SupabaseCustomerRow {
  const consent = customer.email_marketing_consent;

  const acceptsMarketing =
    consent?.state != null
      ? consent.state === 'subscribed'
      : customer.accepts_marketing ?? null;

  const marketingOptInLevel =
    consent?.opt_in_level ?? customer.marketing_opt_in_level ?? null;

  const address = customer.default_address;

  const tags = customer.tags
    ? customer.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
    : [];

  return {
    shopify_customer_id: customer.id,
    email_address: customer.email || null,
    // In sole cifre, prefisso compreso: e' la forma che Meta e Google
    // confrontano. Quella leggibile di Shopify e' giusta da mostrare e
    // sbagliata da confrontare — l'hash di "+39 333" non e' quello di "39333".
    phone_number: normalizePhone(customer.phone),
    first_name: customer.first_name || null,
    last_name: customer.last_name || null,
    accepts_marketing: acceptsMarketing,
    marketing_opt_in_level: marketingOptInLevel,
    total_spent: customer.total_spent != null ? parseFloat(customer.total_spent) : null,
    orders_count: customer.orders_count ?? null,
    customer_state: customer.state ?? null,
    tags,
    note: customer.note ?? null,
    verified_email: customer.verified_email ?? null,
    tax_exempt: customer.tax_exempt ?? null,
    created_at: customer.created_at ?? null,
    updated_at: customer.updated_at ?? null,
    country: address?.country || null,
    // Via e civico in una colonna sola, con la seconda riga in coda quando c'e'
    // (interno, scala, presso). Sono due campi su Shopify ma un indirizzo solo:
    // separati costringerebbero chiunque li legga a ricomporli.
    address: [address?.address1, address?.address2].filter(Boolean).join(', ') || null,
    zipcode: address?.zip || null,
    region: address?.province || null,
    // Shopify non ha questi due come campi del cliente: la colonna esiste, il
    // dato no. Scriverci dentro qualcosa di inventato — l'id Shopify come
    // `external_id`, per dire — sarebbe peggio di lasciarla vuota: chi la legge
    // crederebbe che sia il suo identificativo.
    external_id: null,
    // Nessun campo da cui leggerla, per ora: passa comunque di qui, cosi' il
    // giorno in cui arrivera' da un metafield sara' gia' scritta come YYYYMMDD
    // senza doversene ricordare.
    date_of_birth: normalizeBirthdate(null),
    synced_at: new Date().toISOString(),
  };
}
