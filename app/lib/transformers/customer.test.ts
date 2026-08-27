import { describe, it, expect } from 'vitest';
import { transformCustomer } from './customer.server';
import type { ShopifyCustomer } from '~/types/shopify';

const base: ShopifyCustomer = {
  id: 123,
  email: 'jane@example.com',
  phone: '+15551234567',
  first_name: 'Jane',
  last_name: 'Doe',
  total_spent: '42.50',
  orders_count: 3,
  state: 'enabled',
  tags: 'vip, wholesale',
  note: 'good customer',
  verified_email: true,
  tax_exempt: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
};

describe('transformCustomer', () => {
  it('maps core fields, parses total_spent, and splits tags', () => {
    const row = transformCustomer(base);

    expect(row.shopify_customer_id).toBe(123);
    expect(row.email_address).toBe('jane@example.com');
    expect(row.total_spent).toBe(42.5);
    expect(row.orders_count).toBe(3);
    expect(row.customer_state).toBe('enabled');
    expect(row.tags).toEqual(['vip', 'wholesale']);
    expect(typeof row.synced_at).toBe('string');
  });

  it('prefers nested email_marketing_consent over legacy fields', () => {
    const row = transformCustomer({
      ...base,
      accepts_marketing: false,
      marketing_opt_in_level: 'single_opt_in',
      email_marketing_consent: { state: 'subscribed', opt_in_level: 'confirmed_opt_in' },
    });

    expect(row.accepts_marketing).toBe(true);
    expect(row.marketing_opt_in_level).toBe('confirmed_opt_in');
  });

  it('falls back to legacy accepts_marketing when consent object is absent', () => {
    const row = transformCustomer({
      ...base,
      accepts_marketing: true,
      marketing_opt_in_level: 'single_opt_in',
      email_marketing_consent: null,
    });

    expect(row.accepts_marketing).toBe(true);
    expect(row.marketing_opt_in_level).toBe('single_opt_in');
  });

  it('normalizes empty tags and missing optional fields to null', () => {
    const row = transformCustomer({
      id: 9,
      email: null,
      phone: null,
      first_name: null,
      last_name: null,
    });

    expect(row.tags).toEqual([]);
    expect(row.total_spent).toBeNull();
    expect(row.orders_count).toBeNull();
    expect(row.accepts_marketing).toBeNull();
  });
});

describe("l'indirizzo del cliente", () => {
  const withAddress = (address: Record<string, string | null> | null) =>
    transformCustomer({
      id: 1,
      email: 'a@b.it',
      phone: null,
      first_name: 'Ada',
      last_name: 'Rossi',
      default_address: address,
    } as never);

  it('si legge dall indirizzo predefinito, non dall elenco completo', () => {
    // Per un pubblico pubblicitario conta dove il cliente vive, non un
    // indirizzo di spedizione occasionale.
    const row = withAddress({
      address1: 'Via Roma 1',
      address2: null,
      city: 'Milano',
      province: 'Lombardia',
      country: 'Italy',
      zip: '20100',
    });

    expect(row.country).toBe('Italy');
    expect(row.address).toBe('Via Roma 1');
    expect(row.zipcode).toBe('20100');
    expect(row.region).toBe('Lombardia');
  });

  it('la seconda riga entra nello stesso indirizzo', () => {
    // Sono due campi su Shopify ma un indirizzo solo: separarli costringerebbe
    // chiunque li legga a ricomporli.
    const row = withAddress({ address1: 'Via Roma 1', address2: 'Scala B', country: 'Italy' });
    expect(row.address).toBe('Via Roma 1, Scala B');
  });

  it('senza indirizzo le colonne restano vuote, non stringhe vuote', () => {
    const row = withAddress(null);
    expect(row.country).toBeNull();
    expect(row.address).toBeNull();
    expect(row.zipcode).toBeNull();
    expect(row.region).toBeNull();
  });

  it('external_id resta vuoto finche non c e da dove leggerlo', () => {
    // Shopify non ce l'ha come campo del cliente. Metterci dentro l'id Shopify
    // sarebbe peggio del vuoto: chi legge crederebbe che sia il suo
    // identificativo esterno.
    const row = withAddress({ country: 'Italy' });
    expect(row.external_id).toBeNull();
  });

  // La differenza fra "chiave assente" e "chiave a null" qui non e' stilistica:
  // una chiave assente esce dalla lista colonne dell'upsert e la colonna non
  // viene toccata, mentre un null la sovrascrive. I metafield nel payload dei
  // webhook non ci sono mai, quindi scrivere sempre null vorrebbe dire
  // cancellare la data a ogni modifica del cliente — un ordine, un tag, un
  // indirizzo cambiato.
  it('senza aver letto il metafield la data di nascita non entra proprio nella riga', () => {
    const row = withAddress({ country: 'Italy' });
    expect('date_of_birth' in row).toBe(false);
  });

  it('letta e vuota, invece, la colonna si svuota davvero', () => {
    const row = transformCustomer({ ...base, date_of_birth: null } as never);
    expect('date_of_birth' in row).toBe(true);
    expect(row.date_of_birth).toBeNull();
  });

  it('la data letta si scrive senza separatori, come la vogliono le piattaforme', () => {
    const row = transformCustomer({ ...base, date_of_birth: '1985-04-23' } as never);
    expect(row.date_of_birth).toBe('19850423');
  });
});
