import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('~/lib/integrations/route-guard.server', () => ({ requireCustomersSyncShop: vi.fn() }));
vi.mock('~/lib/integrations/import.server', () => ({ requestImport: vi.fn() }));

import { action } from './api.integrations.$provider.import';
import { requireCustomersSyncShop } from '~/lib/integrations/route-guard.server';
import { requestImport } from '~/lib/integrations/import.server';

/* eslint-disable @typescript-eslint/no-explicit-any */

function chiama(provider = 'klaviyo', method = 'POST') {
  const request = new Request(`https://app.test/api/integrations/${provider}/import`, { method });
  return action({ request, params: { provider }, context: {} } as any) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  (requireCustomersSyncShop as any).mockResolvedValue({ id: 'shop-1' });
});

describe('POST /api/integrations/:provider/import', () => {
  it('accoda e risponde queued', async () => {
    (requestImport as any).mockResolvedValue({ queued: true });
    const res = await chiama();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true });
    expect(requestImport).toHaveBeenCalledWith('shop-1', 'klaviyo');
  });

  it('gia in corso: queued false con il motivo', async () => {
    (requestImport as any).mockResolvedValue({ queued: false, reason: 'already_running' });
    const res = await chiama();
    expect(await res.json()).toEqual({ queued: false, reason: 'already_running' });
  });

  it('piano senza clienti: la risposta del guard passa cosi com e', async () => {
    (requireCustomersSyncShop as any).mockResolvedValue(
      new Response(JSON.stringify({ error: 'plan_missing_customers_sync' }), { status: 403 }),
    );
    const res = await chiama();
    expect(res.status).toBe(403);
    expect(requestImport).not.toHaveBeenCalled();
  });

  it('provider sconosciuto: 404', async () => {
    const res = await chiama('mailchimp');
    expect(res.status).toBe(404);
    expect(requestImport).not.toHaveBeenCalled();
  });
});
