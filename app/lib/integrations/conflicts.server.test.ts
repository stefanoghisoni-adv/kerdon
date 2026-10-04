import { describe, it, expect, beforeEach, vi } from 'vitest';
import { listConflicts, resolveConflicts } from './conflicts.server';

/* eslint-disable @typescript-eslint/no-explicit-any */

const h = vi.hoisted(() => ({
  shop: null as any,
  conflicts: [] as any[],
  mockSetBirthdates: vi.fn(),
  mockForShop: vi.fn(),
  mockResolveBirthdateTarget: vi.fn(),
}));

vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      findUnique: vi.fn(async () => h.shop),
    },
    integrationConflict: {
      findMany: vi.fn(async ({ where }: any) => {
        return h.conflicts.filter((c: any) => {
          if (where.shopId && c.shopId !== where.shopId) return false;
          if (where.provider && c.provider !== where.provider) return false;
          if (where.targetField && c.targetField !== where.targetField) return false;
          if (where.status && c.status !== where.status) return false;
          if (where.customerId?.in) {
            const ids = where.customerId.in.map((id: bigint) => id.toString());
            if (!ids.includes(c.customerId.toString())) return false;
          }
          return true;
        });
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const idsToUpdate = where.id?.in || [];
        h.conflicts.forEach((c: any) => {
          if (idsToUpdate.includes(c.id)) {
            Object.assign(c, data);
          }
        });
        return { count: idsToUpdate.length };
      }),
    },
  },
}));

vi.mock('~/lib/shopify-api.server', () => ({
  ShopifyAPIClient: {
    forShop: h.mockForShop,
  },
}));

vi.mock('~/lib/workers/processors.server', () => ({
  resolveBirthdateTarget: h.mockResolveBirthdateTarget,
}));

vi.mock('~/lib/customers/birthdate-metafield', () => ({
  birthdateMetafieldOf: vi.fn((shop: any) => shop?.birthdateMetafield || null),
}));

vi.mock('~/lib/sync/customers-write-access', () => ({
  hasCustomerWriteAccess: vi.fn((scopes: string) => scopes.includes('write_customers')),
}));

describe('conflicts.server', () => {
  const shopId = 'test-shop-id';
  const otherShopId = 'other-shop-id';

  beforeEach(() => {
    h.conflicts = [];
    h.shop = {
      id: shopId,
      shopDomain: 'test.myshopify.com',
      scopes: 'read_customers,write_customers',
      birthdateMetafield: { namespace: 'custom', key: 'birthdate' },
    };
    h.mockSetBirthdates.mockReset();
    h.mockForShop.mockReset();
    h.mockResolveBirthdateTarget.mockReset();
    h.mockForShop.mockReturnValue({ setCustomerBirthdates: h.mockSetBirthdates });
    h.mockResolveBirthdateTarget.mockResolvedValue({
      namespace: 'custom',
      key: 'birthdate',
      type: 'date',
    });
  });

  describe('listConflicts', () => {
    it('lists open conflicts for a shop', async () => {
      h.conflicts = [
        {
          id: '1',
          shopId,
          provider: 'klaviyo',
          customerId: 123n,
          targetField: 'birthdate',
          ourValue: '1990-01-01',
          theirValue: '1990-01-02',
          status: 'open',
          createdAt: new Date(),
        },
        {
          id: '2',
          shopId,
          provider: 'klaviyo',
          customerId: 456n,
          targetField: 'birthdate',
          ourValue: null,
          theirValue: '1991-05-15',
          status: 'open',
          createdAt: new Date(),
        },
        {
          id: '3',
          shopId,
          provider: 'klaviyo',
          customerId: 789n,
          targetField: 'birthdate',
          ourValue: '1992-03-20',
          theirValue: '1992-03-21',
          status: 'kept_ours',
          createdAt: new Date(),
        },
      ];

      const result = await listConflicts(shopId, { status: 'open' });

      expect(result).toHaveLength(2);
      expect(result).toEqual(
        expect.arrayContaining([
          {
            customerId: 123,
            field: 'birthdate',
            ours: '1990-01-01',
            theirs: '1990-01-02',
            provider: 'klaviyo',
          },
          {
            customerId: 456,
            field: 'birthdate',
            ours: null,
            theirs: '1991-05-15',
            provider: 'klaviyo',
          },
        ]),
      );
    });

    it('does not return conflicts from other shops', async () => {
      h.conflicts = [
        {
          id: '1',
          shopId,
          provider: 'klaviyo',
          customerId: 123n,
          targetField: 'birthdate',
          ourValue: '1990-01-01',
          theirValue: '1990-01-02',
          status: 'open',
          createdAt: new Date(),
        },
        {
          id: '2',
          shopId: otherShopId,
          provider: 'klaviyo',
          customerId: 999n,
          targetField: 'birthdate',
          ourValue: '1995-01-01',
          theirValue: '1995-01-02',
          status: 'open',
          createdAt: new Date(),
        },
      ];

      const result = await listConflicts(shopId, { status: 'open' });

      expect(result).toHaveLength(1);
      expect(result[0].customerId).toBe(123);
    });

    it('returns empty array when no conflicts', async () => {
      const result = await listConflicts(shopId, { status: 'open' });
      expect(result).toEqual([]);
    });
  });

  describe('resolveConflicts', () => {
    beforeEach(() => {
      h.conflicts = [
        {
          id: '1',
          shopId,
          provider: 'klaviyo',
          customerId: 123n,
          targetField: 'birthdate',
          ourValue: '1990-01-01',
          theirValue: '1990-01-02',
          status: 'open',
        },
        {
          id: '2',
          shopId,
          provider: 'klaviyo',
          customerId: 456n,
          targetField: 'birthdate',
          ourValue: null,
          theirValue: '1991-05-15',
          status: 'open',
        },
        {
          id: '3',
          shopId: otherShopId,
          provider: 'klaviyo',
          customerId: 789n,
          targetField: 'birthdate',
          ourValue: '1992-01-01',
          theirValue: '1992-01-02',
          status: 'open',
        },
      ];
    });

    it('resolves conflicts with kept_ours without writing to Shopify', async () => {
      const result = await resolveConflicts(shopId, [123, 456], 'kept_ours');

      expect(result.resolved).toBe(2);
      expect(result.notWritten).toEqual([]);

      // Verify conflicts were marked as kept_ours
      const resolved = h.conflicts.filter((c) => c.shopId === shopId && c.decidedAt !== undefined);
      expect(resolved).toHaveLength(2);
      expect(resolved.every((c) => c.status === 'kept_ours')).toBe(true);

      // Verify setCustomerBirthdates was NOT called
      expect(h.mockSetBirthdates).not.toHaveBeenCalled();
    });

    it('resolves conflicts with used_theirs and writes to Shopify', async () => {
      h.mockSetBirthdates.mockResolvedValue({
        written: 2,
        errors: [],
        failed: [],
      });

      const result = await resolveConflicts(shopId, [123, 456], 'used_theirs');

      expect(result.resolved).toBe(2);
      expect(result.notWritten).toEqual([]);

      // Verify conflicts were marked as used_theirs
      const resolved = h.conflicts.filter((c) => c.shopId === shopId && c.decidedAt !== undefined);
      expect(resolved).toHaveLength(2);
      expect(resolved.every((c) => c.status === 'used_theirs')).toBe(true);

      // Verify setCustomerBirthdates was called
      expect(h.mockForShop).toHaveBeenCalledWith('test.myshopify.com');
      expect(h.mockSetBirthdates).toHaveBeenCalledWith(
        expect.arrayContaining([
          { customerId: 123, date: '1990-01-02' },
          { customerId: 456, date: '1991-05-15' },
        ]),
        expect.any(Object),
      );
    });

    it('leaves failed writes as open and returns them in notWritten', async () => {
      h.mockSetBirthdates.mockResolvedValue({
        written: 1,
        errors: ['Customer 123 metafield write failed'],
        failed: [{ customerId: 123, reason: 'Customer not found' }],
      });

      const result = await resolveConflicts(shopId, [123, 456], 'used_theirs');

      expect(result.resolved).toBe(1);
      expect(result.notWritten).toEqual([123]);

      // Verify 456 is marked as used_theirs
      const conflict456 = h.conflicts.find((c) => c.customerId === 456n);
      expect(conflict456?.status).toBe('used_theirs');
      expect(conflict456?.decidedAt).not.toBeUndefined();

      // Verify 123 is still open
      const conflict123 = h.conflicts.find((c) => c.customerId === 123n);
      expect(conflict123?.status).toBe('open');
      expect(conflict123?.decidedAt).toBeUndefined();
    });

    it('ignores customer IDs from other shops', async () => {
      h.mockSetBirthdates.mockResolvedValue({
        written: 2,
        errors: [],
        failed: [],
      });

      const result = await resolveConflicts(shopId, [123, 456, 789], 'used_theirs');

      expect(result.resolved).toBe(2);
      expect(result.notWritten).toEqual([]);

      // Verify the other shop's conflict is unchanged
      const otherShopConflict = h.conflicts.find((c) => c.shopId === otherShopId);
      expect(otherShopConflict?.status).toBe('open');
      expect(otherShopConflict?.decidedAt).toBeUndefined();

      // Verify only 2 entries were sent to Shopify
      expect(h.mockSetBirthdates).toHaveBeenCalledWith(
        expect.arrayContaining([
          { customerId: 123, date: '1990-01-02' },
          { customerId: 456, date: '1991-05-15' },
        ]),
        expect.any(Object),
      );
      expect(h.mockSetBirthdates.mock.calls[0][0]).toHaveLength(2);
    });

    it('rejects more than 250 IDs with appropriate error', async () => {
      const ids = Array.from({ length: 251 }, (_, i) => i + 1);

      await expect(resolveConflicts(shopId, ids, 'kept_ours')).rejects.toThrow(
        'too many ids',
      );
    });

    it('handles used_theirs when shop has no write access', async () => {
      h.shop = { ...h.shop, scopes: 'read_customers' };

      const result = await resolveConflicts(shopId, [123, 456], 'used_theirs');

      expect(result.resolved).toBe(0);
      expect(result.notWritten).toEqual(expect.arrayContaining([123, 456]));

      const conflicts = h.conflicts.filter((c) => c.shopId === shopId);
      expect(conflicts.every((c) => c.status === 'open')).toBe(true);
    });

    it('handles used_theirs when shop has no birthdate field configured', async () => {
      h.shop = { ...h.shop, birthdateMetafield: null };

      const result = await resolveConflicts(shopId, [123, 456], 'used_theirs');

      expect(result.resolved).toBe(0);
      expect(result.notWritten).toEqual(expect.arrayContaining([123, 456]));

      const conflicts = h.conflicts.filter((c) => c.shopId === shopId);
      expect(conflicts.every((c) => c.status === 'open')).toBe(true);
    });
  });
});
