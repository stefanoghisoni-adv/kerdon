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

  // Normalizzata una volta sola: serve due volte — per decidere se la chiave
  // entra nella riga e per il valore che ci finisce dentro — e chiamarla due
  // volte inviterebbe a cambiarne una sola.
  const birthdate = normalizeBirthdate(customer.date_of_birth);

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
    // La sigla ISO accanto al nome esteso: `IT` e' cio' che le piattaforme
    // pubblicitarie confrontano, `Italy` cio' che il merchant si aspetta di
    // leggere. Dedurre l'una dall'altro vorrebbe dire tenersi in casa un
    // elenco di nazioni, quando Shopify la sigla ce l'ha gia'.
    country_code: address?.country_code || null,
    // Via e civico in una colonna sola, con la seconda riga in coda quando c'e'
    // (interno, scala, presso). Sono due campi su Shopify ma un indirizzo solo:
    // separati costringerebbero chiunque li legga a ricomporli.
    address: [address?.address1, address?.address2].filter(Boolean).join(', ') || null,
    // La citta' Shopify la manda da sempre, in ogni payload: prima si leggeva
    // e si buttava via, ed era l'unico pezzo dell'indirizzo a non arrivare
    // dall'altra parte.
    city: address?.city || null,
    zipcode: address?.zip || null,
    region: address?.province || null,
    // Shopify non ha questi due come campi del cliente: la colonna esiste, il
    // dato no. Scriverci dentro qualcosa di inventato — l'id Shopify come
    // `external_id`, per dire — sarebbe peggio di lasciarla vuota: chi la legge
    // crederebbe che sia il suo identificativo.
    external_id: null,
    // `fb_login_id`, `google_login_id` e `total_profit` esistono in tabella ma
    // NON compaiono qui, ed e' voluto: i primi due li riempira' l'accesso con
    // Meta e Google, il terzo si calcola in SQL sugli ordini. Metterli nella
    // riga a null vorrebbe dire cancellarli a ogni sincronizzazione, cioe'
    // proprio a chi li ha appena scritti.
    //
    // La data di nascita entra nella riga SOLO quando Shopify ne ha una.
    //
    // Sono due i modi in cui puo' non essercene una, e prima portavano a esiti
    // diversi: il payload dei webhook i metafield non li porta affatto (chiave
    // assente), mentre la corsa periodica che il metafield lo chiede riceve
    // `null` per il cliente che non l'ha compilato. Il secondo caso finiva
    // nella riga come `date_of_birth: null` e CANCELLAVA il valore che il
    // merchant aveva scritto a mano sul suo database — l'unico posto in cui
    // quel valore esisteva.
    //
    // Ora i due casi si comportano allo stesso modo, perche' dicono la stessa
    // cosa: "da Shopify non arriva niente". La chiave assente dice a PostgREST
    // di non toccare la colonna, e la colonna resta com'e' senza bisogno di
    // rileggerla prima. Shopify vince quando ha un valore; quando non ce l'ha
    // non cancella, e ci pensa la riscrittura (`birthdate-writeback`) a
    // portargli quello che il merchant aveva gia'.
    //
    // Anche una data illeggibile finisce qui dentro: `normalizeBirthdate`
    // restituisce null per cio' che non e' una data, e scriverlo vorrebbe dire
    // buttare via un valore buono per rimpiazzarlo con niente.
    ...(birthdate !== null ? { date_of_birth: birthdate } : {}),
    synced_at: new Date().toISOString(),
  };
}
