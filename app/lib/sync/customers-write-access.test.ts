import { describe, it, expect } from 'vitest';
import { hasCustomerWriteAccess } from './customers-write-access';

describe('hasCustomerWriteAccess', () => {
  it('col permesso di scrittura si puo riportare la data su Shopify', () => {
    expect(hasCustomerWriteAccess('read_products,read_customers,write_customers')).toBe(true);
  });

  it('leggere non e scrivere: read_customers da solo non basta', () => {
    // E' il caso del negozio installato quando l'app leggeva soltanto: senza
    // riautorizzare, ogni mutation tornerebbe indietro con un 403.
    expect(hasCustomerWriteAccess('read_products,read_customers')).toBe(false);
  });

  it('nessuno scope, nessuna scrittura', () => {
    expect(hasCustomerWriteAccess(null)).toBe(false);
    expect(hasCustomerWriteAccess(undefined)).toBe(false);
    expect(hasCustomerWriteAccess('')).toBe(false);
  });

  it('spazi e maiuscole non contano: la stringa la scrive Shopify', () => {
    expect(hasCustomerWriteAccess(' READ_CUSTOMERS , Write_Customers ')).toBe(true);
  });
});
