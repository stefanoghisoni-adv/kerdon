// app/routes/spedizioni.action.test.ts
//
// L'ordine dei lavori dopo "Importa zone". Il recupero dell'opzione accodato
// PRIMA del ricalcolo nel salvataggio sveglia la coda con un'autochiamata, che
// spesso prende il lucchetto del negozio per prima: il ricalcolo tornava
// 'occupato' e il merchant leggeva "a breve" proprio al primo import. Il
// ricalcolo va prima, il recupero dopo.

import { describe, it as prova, expect, vi, beforeEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ordine: string[] = [];

vi.mock('~/lib/authz/require-capability.server', () => ({
  requireShopCapability: vi.fn(async () => ({
    session: { shop: 'negozio.myshopify.com' },
    shop: { id: 'shop-1' },
  })),
}));
vi.mock('~/lib/setup/require-setup.server', () => ({ requireSetupComplete: vi.fn() }));
vi.mock('~/shopify.server', () => ({ authenticate: { admin: vi.fn(async () => ({ admin: {} })) } }));
vi.mock('~/db.server', () => ({ prisma: {} }));
vi.mock('~/lib/shipping/sync-zones.server', () => ({ syncShippingZones: vi.fn() }));
vi.mock('~/lib/shipping/page-data.server', () => ({ loadShippingPageData: vi.fn() }));
vi.mock('~/lib/shipping/packaging-store.server', () => ({ readPackaging: vi.fn(), writePackaging: vi.fn() }));
vi.mock('~/lib/shipping/recompute-inline.server', () => ({
  recomputeLogisticsAfterSave: vi.fn(async () => {
    ordine.push('ricalcolo');
    return 'updated';
  }),
}));
vi.mock('~/lib/shipping/shipping-method-backfill-enqueue.server', () => ({
  enqueueShippingMethodBackfill: vi.fn(async () => {
    ordine.push('recupero');
  }),
}));

import { action } from './spedizioni';
import { enqueueShippingMethodBackfill } from '~/lib/shipping/shipping-method-backfill-enqueue.server';

function importaZone() {
  const form = new FormData();
  form.set('intent', 'sync-zones');
  return action({
    request: new Request('https://app/spedizioni', { method: 'POST', body: form }),
    params: {},
    context: {},
  } as any);
}

beforeEach(() => {
  ordine.length = 0;
  vi.clearAllMocks();
});

describe('Importa zone', () => {
  prova('prima il ricalcolo nel salvataggio, poi il recupero dell opzione', async () => {
    const risposta = await importaZone();

    expect(ordine).toEqual(['ricalcolo', 'recupero']);
    expect(enqueueShippingMethodBackfill).toHaveBeenCalledWith('shop-1');
    expect(await (risposta as Response).json()).toEqual({ intent: 'sync-zones', success: true, numbers: 'updated' });
  });
});
