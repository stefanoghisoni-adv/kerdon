import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  allowedReadTables,
  allowedEmbedTables,
  buildSupabaseReadUrl,
  forwardRead,
  inspectReadQuery,
  embeddedTableNames,
} from './forward.server';

describe('allowedReadTables', () => {
  it('solo products senza clienti; products+customers con clienti', () => {
    expect(allowedReadTables(false)).toEqual(['products']);
    expect(allowedReadTables(true)).toEqual(['products', 'customers']);
  });
});

describe('allowedEmbedTables', () => {
  // Se un giorno questo elenco non e' piu' vuoto, chi lo riempie deve passare
  // di qui e spiegare come la nuova risorsa supera i controlli di piano e di
  // consenso. Il test e' li' per obbligarlo a fermarsi.
  it('nessun embedding e ammesso oggi', () => {
    expect(allowedEmbedTables()).toEqual([]);
  });
});

describe('embeddedTableNames', () => {
  it('nessun select → array vuoto', () => {
    expect(embeddedTableNames('')).toEqual([]);
    expect(embeddedTableNames('?sku=eq.X')).toEqual([]);
  });

  it('select semplice → array vuoto', () => {
    expect(embeddedTableNames('?select=*')).toEqual([]);
    expect(embeddedTableNames('?select=id,email_address')).toEqual([]);
  });

  it('cattura embedding base', () => {
    expect(embeddedTableNames('?select=*,customers(*)')).toEqual(['customers']);
  });

  it('cattura embedding con alias', () => {
    expect(embeddedTableNames('?select=*,c:customers(*)')).toEqual(['customers']);
  });

  it('cattura embedding con hint di join', () => {
    expect(embeddedTableNames('?select=*,customers!inner(*)')).toEqual(['customers']);
    expect(embeddedTableNames('?select=*,orders!fk_orders_products(id)')).toEqual(['orders']);
  });

  it('cattura embedding con spread', () => {
    expect(embeddedTableNames('?select=*,...customers(email_address)')).toEqual(['customers']);
  });

  it('cattura embedding annidati a piu livelli', () => {
    expect(embeddedTableNames('?select=*,orders(id,order_lines(id))')).toEqual([
      'orders',
      'order_lines',
    ]);
  });

  it('cattura multipli embedding', () => {
    expect(embeddedTableNames('?select=*,orders(*),customers(*)')).toEqual(['orders', 'customers']);
  });

  it('normalizza a lowercase', () => {
    expect(embeddedTableNames('?select=*,Customers(*)')).toEqual(['customers']);
  });

  it('legge TUTTI i select, non solo il primo', () => {
    expect(embeddedTableNames('?select=*&select=*,orders(*)')).toEqual(['orders']);
  });

  it('gli aggregati non sono embedding', () => {
    expect(embeddedTableNames('?select=count()')).toEqual([]);
    expect(embeddedTableNames('?select=price.sum()')).toEqual([]);
    expect(embeddedTableNames('?select=id,price.max(),price.min()')).toEqual([]);
  });

  it('non interpretabile → null', () => {
    // Identificatore fra virgolette: il nostro riconoscitore non lo vede, quello
    // di PostgREST si.
    expect(embeddedTableNames('?select=*,"orders"(*)')).toBeNull();
    // Parentesi sbilanciate.
    expect(embeddedTableNames('?select=*,orders(*')).toBeNull();
    expect(embeddedTableNames('?select=*,orders*)')).toBeNull();
    // Parentesi vuote che non sono un aggregato noto.
    expect(embeddedTableNames('?select=*,orders()')).toBeNull();
  });
});

describe('inspectReadQuery', () => {
  const noEmbeds: readonly string[] = [];

  it('query legittime passano', () => {
    expect(inspectReadQuery('', noEmbeds).ok).toBe(true);
    expect(inspectReadQuery('?sku=eq.ABC', noEmbeds).ok).toBe(true);
    expect(inspectReadQuery('?select=*&sku=eq.ABC&limit=10', noEmbeds).ok).toBe(true);
    expect(inspectReadQuery('?select=sku,price,net_value&order=updated_at.desc', noEmbeds).ok).toBe(
      true,
    );
    expect(inspectReadQuery('?email_address=eq.foo@bar.com&select=*', noEmbeds).ok).toBe(true);
    expect(inspectReadQuery('?or=(sku.eq.A,sku.eq.B)&limit=5', noEmbeds).ok).toBe(true);
    expect(inspectReadQuery('?select=count()', noEmbeds).ok).toBe(true);
    expect(inspectReadQuery('?select=price.sum()', noEmbeds).ok).toBe(true);
  });

  it('embedding di una tabella gestita non ammessa dal piano → negato', () => {
    expect(inspectReadQuery('?select=*,customers(*)', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=sku,customers(email_address)', noEmbeds).ok).toBe(false);
  });

  it('embedding di orders → negato', () => {
    expect(inspectReadQuery('?select=*,orders(*)', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=*,order_lines(*)', noEmbeds).ok).toBe(false);
  });

  it('embedding di una tabella qualunque del merchant → negato', () => {
    // E' il caso che l'elenco dei divieti non poteva coprire: non sappiamo che
    // tabelle abbia il merchant nel suo progetto, e non serve saperlo.
    expect(inspectReadQuery('?select=*,fatture(*)', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=*,auth_users(*)', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=*,segreti_del_merchant(colonna)', noEmbeds).ok).toBe(false);
  });

  it('embedding annidato a due livelli → negato', () => {
    expect(inspectReadQuery('?select=*,orders(id,customers(email_address))', noEmbeds).ok).toBe(
      false,
    );
    expect(inspectReadQuery('?select=id,a(b(c))', noEmbeds).ok).toBe(false);
  });

  it('alias e hint di join non nascondono l embedding', () => {
    expect(inspectReadQuery('?select=*,alias:orders(*)', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=*,orders!inner(*)', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=*,o:orders!inner(id)', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=*,...orders(id)', noEmbeds).ok).toBe(false);
  });

  it('select ripetuto non aggira il controllo', () => {
    expect(inspectReadQuery('?select=*&select=*,orders(*)', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=*,orders(*)&select=*', noEmbeds).ok).toBe(false);
  });

  it('select non interpretabile → negato (fail-closed)', () => {
    expect(inspectReadQuery('?select=*,"orders"(*)', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=*,orders(*', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=*,orders()', noEmbeds).ok).toBe(false);
  });

  it('filtri, ordinamenti e limiti su risorse collegate → negati', () => {
    expect(inspectReadQuery('?customers.email_address=eq.x', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=*&orders.limit=1', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=*&orders.order=id.desc', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?select=*&orders.or=(id.eq.1,id.eq.2)', noEmbeds).ok).toBe(false);
  });

  it('la negazione logica al livello top resta legittima', () => {
    expect(inspectReadQuery('?not.or=(sku.eq.A,sku.eq.B)', noEmbeds).ok).toBe(true);
    expect(inspectReadQuery('?not.and=(sku.eq.A,price.gt.10)', noEmbeds).ok).toBe(true);
  });

  it('parametri di scrittura su una lettura → negati', () => {
    expect(inspectReadQuery('?columns=sku,price', noEmbeds).ok).toBe(false);
    expect(inspectReadQuery('?on_conflict=sku', noEmbeds).ok).toBe(false);
  });

  it('customers non e embeddabile nemmeno se finisse in elenco', () => {
    // Il consenso marketing e' applicato al livello top: un customers raggiunto
    // per chiave esterna uscirebbe senza che nessuno lo abbia controllato.
    expect(inspectReadQuery('?select=*,customers(*)', ['customers', 'products']).ok).toBe(false);
  });

  it('un embedding in elenco passerebbe', () => {
    expect(inspectReadQuery('?select=*,products(sku)', ['products']).ok).toBe(true);
  });

  it('il motivo del rifiuto nomina la risorsa', () => {
    const v = inspectReadQuery('?select=*,orders(*)', noEmbeds);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('orders');
  });
});

describe('buildSupabaseReadUrl', () => {
  it('host dal ref, querystring preservata', () => {
    expect(buildSupabaseReadUrl('abcref', 'products', '?sku=eq.X')).toBe(
      'https://abcref.supabase.co/rest/v1/products?sku=eq.X',
    );
  });
  it('nessuna querystring quando vuota o "?"', () => {
    expect(buildSupabaseReadUrl('abcref', 'products', '')).toBe(
      'https://abcref.supabase.co/rest/v1/products',
    );
    expect(buildSupabaseReadUrl('abcref', 'products', '?')).toBe(
      'https://abcref.supabase.co/rest/v1/products',
    );
  });

  it('input validi (abcref, products) non lanciano', () => {
    expect(() => buildSupabaseReadUrl('abcref', 'products', '')).not.toThrow();
    expect(() => buildSupabaseReadUrl('abc123', 'customers', '')).not.toThrow();
  });

  it('table malevolo lancia', () => {
    expect(() => buildSupabaseReadUrl('abcref', 'products/../x', '')).toThrow('Nome tabella non valido');
    expect(() => buildSupabaseReadUrl('abcref', 'products@evil', '')).toThrow('Nome tabella non valido');
    expect(() => buildSupabaseReadUrl('abcref', 'Products', '')).toThrow('Nome tabella non valido');
    expect(() => buildSupabaseReadUrl('abcref', 'prod-ucts', '')).toThrow('Nome tabella non valido');
  });

  it('projectRef malevolo lancia', () => {
    expect(() => buildSupabaseReadUrl('evil.com', 'products', '')).toThrow('Project ref non valido');
    expect(() => buildSupabaseReadUrl('ref/../x', 'products', '')).toThrow('Project ref non valido');
    expect(() => buildSupabaseReadUrl('ref@evil', 'products', '')).toThrow('Project ref non valido');
    expect(() => buildSupabaseReadUrl('ref:8080', 'products', '')).toThrow('Project ref non valido');
  });
});

describe('forwardRead', () => {
  beforeEach(() => { global.fetch = vi.fn(); });
  const ctx = {
    shopId: 's1', trackingAuthorization: 'ENABLED' as const, canReadData: true, projectRef: 'abcref',
    serviceRoleKey: 'svc', customersEnabled: true,
  };

  it('inoltra con service_role e propaga status/body/content-type', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      status: 200,
      text: async () => '[{"id":1}]',
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    });
    const r = await forwardRead(ctx, 'products', '?sku=eq.X');
    expect(r).toEqual({ status: 200, body: '[{"id":1}]', contentType: 'application/json' });
    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(url).toBe('https://abcref.supabase.co/rest/v1/products?sku=eq.X');
    expect(init.method).toBe('GET');
    expect(init.headers.apikey).toBe('svc');
    expect(init.headers.Authorization).toBe('Bearer svc');
  });

  it('propaga status non-200 invariato', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      status: 403,
      text: async () => '{"error":"x"}',
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    });
    const r = await forwardRead(ctx, 'products', '');
    expect(r).toEqual({ status: 403, body: '{"error":"x"}', contentType: 'application/json' });
  });
});
