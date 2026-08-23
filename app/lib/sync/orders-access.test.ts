import { describe, it, expect } from 'vitest';
import { hasOrdersAccess } from './orders-access';

describe('hasOrdersAccess', () => {
  it('servono entrambi', () => {
    expect(hasOrdersAccess('read_products,read_orders,read_all_orders')).toBe(true);
  });

  it('read_all_orders da solo non apre niente', () => {
    // E' un'estensione di read_orders, non un permesso a se': senza il primo la
    // cronologia completa resta chiusa.
    expect(hasOrdersAccess('read_products,read_all_orders')).toBe(false);
  });

  it('solo gli ultimi 60 giorni non bastano a un lifetime', () => {
    expect(hasOrdersAccess('read_products,read_orders')).toBe(false);
  });

  it('un negozio installato prima non li ha', () => {
    expect(hasOrdersAccess('read_products,read_customers')).toBe(false);
    expect(hasOrdersAccess(null)).toBe(false);
    expect(hasOrdersAccess('')).toBe(false);
  });

  it('spazi e maiuscole non contano: la stringa la scrive Shopify', () => {
    expect(hasOrdersAccess(' READ_ORDERS , read_all_orders ')).toBe(true);
  });
});
