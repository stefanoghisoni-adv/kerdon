import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
const create = vi.fn();
const update = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    supabaseManagedResource: {
      findMany: (...a: unknown[]) => findMany(...a),
      create: (...a: unknown[]) => create(...a),
      update: (...a: unknown[]) => update(...a),
    },
  },
}));

import {
  MERCHANT_SCHEMA,
  ownedResources,
  recordProvisionedResources,
  tablesToProbe,
} from './managed-resources.server';

const BASE = {
  shopId: 'shop-1',
  projectRef: 'abcdefgh',
  schemaVersion: 9,
};

/** Le righe create, in forma leggibile: nome → e' nostra? */
function created(): Record<string, boolean> {
  return Object.fromEntries(
    create.mock.calls.map((c) => {
      const data = (c[0] as { data: { resourceName: string; createdByCoreWard: boolean } })
        .data;
      return [data.resourceName, data.createdByCoreWard];
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  create.mockResolvedValue({});
  update.mockResolvedValue({});
});

describe('il registro al collegamento', () => {
  it('un database vuoto: tutte le tabelle sono nostre', async () => {
    await recordProvisionedResources({
      ...BASE,
      provisioned: ['products', 'users', 'customers', 'orders', 'order_lines'],
      preExisting: [],
    });

    expect(created()).toEqual({
      products: true,
      users: true,
      customers: true,
      orders: true,
      order_lines: true,
    });
  });

  it('una tabella che c era gia e del merchant', async () => {
    // E' il caso che costava i dati: `products` con dentro il suo catalogo,
    // cancellata da un gesto che prometteva di togliere le NOSTRE tabelle.
    await recordProvisionedResources({
      ...BASE,
      provisioned: ['products', 'users'],
      preExisting: ['products'],
    });

    expect(created()).toEqual({ products: false, users: true });
  });

  it('il confronto non guarda le maiuscole', async () => {
    await recordProvisionedResources({
      ...BASE,
      provisioned: ['products'],
      preExisting: ['PRODUCTS'],
    });

    expect(created()).toEqual({ products: false });
  });

  it('un nome che non e un identificatore lecito non entra nel registro', async () => {
    // Il registro e' cio' da cui un giorno nascera' un DROP: un nome che non
    // potra' mai essere eliminato in sicurezza e' meglio non prometterlo.
    await recordProvisionedResources({
      ...BASE,
      provisioned: ['products', 'pro"ducts'],
      preExisting: [],
    });

    expect(created()).toEqual({ products: true });
  });
});

describe('alla riconnessione', () => {
  it('cio che era nostro resta nostro anche se ora risulta gia presente', async () => {
    // E' vero che c'e' gia': l'avevamo creata noi il giro prima. Senza questa
    // regola ogni riconnessione ce le farebbe dimenticare, e l'eliminazione
    // non troverebbe piu' niente da eliminare.
    findMany.mockResolvedValue([
      {
        id: 'res-1',
        schemaName: MERCHANT_SCHEMA,
        resourceName: 'products',
        createdByCoreWard: true,
      },
    ]);

    await recordProvisionedResources({
      ...BASE,
      provisioned: ['products'],
      preExisting: ['products'],
    });

    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('una tabella del merchant che lui cancella e noi ricreiamo diventa nostra', async () => {
    findMany.mockResolvedValue([
      {
        id: 'res-1',
        schemaName: MERCHANT_SCHEMA,
        resourceName: 'products',
        createdByCoreWard: false,
      },
    ]);

    await recordProvisionedResources({
      ...BASE,
      provisioned: ['products'],
      preExisting: [],
    });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'res-1' },
      data: { createdByCoreWard: true, schemaVersion: 9 },
    });
  });
});

describe('cosa si elimina', () => {
  it('solo le righe marcate come nostre', async () => {
    findMany.mockResolvedValue([
      { schemaName: 'public', resourceName: 'users', createdByCoreWard: true },
    ]);

    const owned = await ownedResources('shop-1', 'abcdefgh');

    expect(findMany).toHaveBeenCalledWith({
      where: { shopId: 'shop-1', projectRef: 'abcdefgh', createdByCoreWard: true },
    });
    expect(owned).toEqual([
      { schemaName: 'public', resourceName: 'users', resourceKind: 'table' },
    ]);
  });
});

describe('cosa si guarda prima della DDL', () => {
  it('tutte e cinque, non solo quelle che il piano prevede oggi', () => {
    // Un piano che oggi non prevede i clienti potrebbe prevederli domani, e a
    // quel punto sapere se la sua `customers` c'era gia' non sarebbe piu'
    // possibile.
    expect(tablesToProbe()).toEqual([
      'products',
      'users',
      'customers',
      'orders',
      'order_lines',
    ]);
  });
});
