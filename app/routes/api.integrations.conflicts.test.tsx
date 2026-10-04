import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loader, action } from './api.integrations.conflicts';

const h = vi.hoisted(() => ({
  mockShop: { id: 'test-shop-id' } as any,
  mockConflicts: [] as any[],
  mockResolveResult: { resolved: 0, notWritten: [] as number[] },
}));

vi.mock('~/lib/integrations/route-guard.server', () => ({
  requireCustomersSyncShop: vi.fn(async (req: Request) => {
    // Don't consume the request body in the mock
    return h.mockShop;
  }),
}));

vi.mock('~/lib/integrations/conflicts.server', () => ({
  listConflicts: vi.fn(async () => h.mockConflicts),
  resolveConflicts: vi.fn(async () => h.mockResolveResult),
}));

import { requireCustomersSyncShop } from '~/lib/integrations/route-guard.server';
import * as conflicts from '~/lib/integrations/conflicts.server';

describe('api.integrations.conflicts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.mockShop = { id: 'test-shop-id' };
    h.mockConflicts = [];
    h.mockResolveResult = { resolved: 0, notWritten: [] };

    // Reset the guard mock to ensure it doesn't consume the request
    (requireCustomersSyncShop as any).mockImplementation(async (req: Request) => h.mockShop);
  });

  describe('loader (GET)', () => {
    it('returns open conflicts', async () => {
      h.mockConflicts = [
        {
          customerId: 123,
          field: 'birthdate',
          ours: '1990-01-01',
          theirs: '1990-01-02',
          provider: 'klaviyo',
        },
      ];

      const request = new Request('https://test.com/api/integrations/conflicts');
      const response = await loader({ request, params: {}, context: {} });
      const data = await response.json();

      expect(conflicts.listConflicts).toHaveBeenCalledWith('test-shop-id', { status: 'open' });
      expect(data).toEqual({ conflicts: h.mockConflicts });
    });

    it('forwards guard rejections', async () => {
      const guardResponse = new Response(JSON.stringify({ error: 'not_authorized' }), {
        status: 403,
      });
      (requireCustomersSyncShop as any).mockResolvedValue(guardResponse);

      const request = new Request('https://test.com/api/integrations/conflicts');
      const response = await loader({ request, params: {}, context: {} });

      expect(response.status).toBe(403);
    });
  });

  describe('action (POST)', () => {
    it('resolves conflicts with kept_ours', async () => {
      h.mockResolveResult = { resolved: 2, notWritten: [] };

      const request = new Request('https://test.com/api/integrations/conflicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerIds: [123, 456], choice: 'kept_ours' }),
      });

      const response = await action({ request, params: {}, context: {} });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(conflicts.resolveConflicts).toHaveBeenCalledWith('test-shop-id', [123, 456], 'kept_ours');
      expect(data).toEqual({ ok: true, resolved: 2, notWritten: [] });
    });

    it('resolves conflicts with used_theirs', async () => {
      h.mockResolveResult = { resolved: 1, notWritten: [123] };

      const request = new Request('https://test.com/api/integrations/conflicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerIds: [123, 456], choice: 'used_theirs' }),
      });

      const response = await action({ request, params: {}, context: {} });
      const data = await response.json();

      expect(conflicts.resolveConflicts).toHaveBeenCalledWith('test-shop-id', [123, 456], 'used_theirs');
      expect(data).toEqual({ ok: true, resolved: 1, notWritten: [123] });
    });

    it('rejects invalid method', async () => {
      const request = new Request('https://test.com/api/integrations/conflicts', {
        method: 'GET',
      });

      const response = await action({ request, params: {}, context: {} });
      const data = await response.json();

      expect(response.status).toBe(405);
      expect(data).toEqual({ ok: false, error: 'method_not_allowed' });
    });

    it('rejects invalid JSON', async () => {
      const request = new Request('https://test.com/api/integrations/conflicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      });

      const response = await action({ request, params: {}, context: {} });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual({ ok: false, error: 'invalid_json' });
    });

    it('rejects invalid customer IDs', async () => {
      const request = new Request('https://test.com/api/integrations/conflicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerIds: ['not', 'numbers'], choice: 'kept_ours' }),
      });

      const response = await action({ request, params: {}, context: {} });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual({ ok: false, error: 'invalid_customer_ids' });
    });

    it('rejects invalid choice', async () => {
      const request = new Request('https://test.com/api/integrations/conflicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerIds: [123], choice: 'invalid_choice' }),
      });

      const response = await action({ request, params: {}, context: {} });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual({ ok: false, error: 'invalid_choice' });
    });

    it('rejects more than 250 IDs', async () => {
      const customerIds = Array.from({ length: 251 }, (_, i) => i + 1);

      const request = new Request('https://test.com/api/integrations/conflicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerIds, choice: 'kept_ours' }),
      });

      const response = await action({ request, params: {}, context: {} });
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toEqual({ ok: false, error: 'too_many_ids' });
    });

    it('forwards guard rejections', async () => {
      const guardResponse = new Response(JSON.stringify({ error: 'not_authorized' }), {
        status: 403,
      });
      (requireCustomersSyncShop as any).mockResolvedValue(guardResponse);

      const request = new Request('https://test.com/api/integrations/conflicts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerIds: [123], choice: 'kept_ours' }),
      });

      const response = await action({ request, params: {}, context: {} });

      expect(response.status).toBe(403);
    });
  });
});
