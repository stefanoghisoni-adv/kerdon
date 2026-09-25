import { describe, it, expect, vi, beforeEach } from 'vitest';

const shopFindUnique = vi.fn();
const findPlanMock = vi.fn();
const configUpdate = vi.fn();

vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: (...a: unknown[]) => shopFindUnique(...a) },
    plan: { findFirst: (...a: unknown[]) => findPlanMock(...a) },
    supabaseConfig: { update: (...a: unknown[]) => configUpdate(...a) },
  },
}));

vi.mock('~/utils/crypto.server', () => ({ decrypt: (v: string) => `dec_${v}` }));
vi.mock('~/lib/supabase-oauth.server', () => ({ getValidAccessToken: vi.fn() }));
vi.mock('~/lib/supabase-management.server', () => ({ runQuery: vi.fn() }));
vi.mock('~/lib/shipping/shipping-method-backfill-enqueue.server', () => ({
  enqueueShippingMethodBackfill: vi.fn(),
}));

import {
  applyMerchantSchemaUpdate,
  triggerMerchantSchemaUpdate,
  clearSchemaUpdateAttempts,
} from './apply-schema-update.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQuery } from '~/lib/supabase-management.server';
import { LATEST_SCHEMA_VERSION } from './merchant-migrations';
import { enqueueShippingMethodBackfill } from '~/lib/shipping/shipping-method-backfill-enqueue.server';

const shopRow = (configOver: Record<string, unknown> = {}) => ({
  id: 'shop-1',
  currentPlan: 'pro',
  supabaseConfig: {
    connectionVerifiedAt: new Date(),
    schemaVersion: 0,
    supabaseProjectRef: 'abcdefghijklmnopqrst',
    supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
    supabaseServiceRoleKey: 'enc-service',
    ...configOver,
  },
});

describe('applyMerchantSchemaUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    clearSchemaUpdateAttempts();
    findPlanMock.mockResolvedValue({ customersSyncEnabled: true });
    configUpdate.mockResolvedValue({});
  });

  it('database indietro → esegue l’SQL e registra la nuova versione', async () => {
    shopFindUnique.mockResolvedValue(shopRow());
    vi.mocked(getValidAccessToken).mockResolvedValue('token');

    const result = await applyMerchantSchemaUpdate('shop-1');

    expect(result).toEqual({ status: 'applied', version: LATEST_SCHEMA_VERSION });
    const [, ref, sql] = vi.mocked(runQuery).mock.calls[0];
    expect(ref).toBe('abcdefghijklmnopqrst');
    expect(sql).toContain('RENAME COLUMN email TO email_address');
    expect(configUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { schemaVersion: LATEST_SCHEMA_VERSION } }),
    );
  });

  it('database gia’ aggiornato → non tocca il progetto del merchant', async () => {
    shopFindUnique.mockResolvedValue(
      shopRow({ schemaVersion: LATEST_SCHEMA_VERSION }),
    );

    const result = await applyMerchantSchemaUpdate('shop-1');

    expect(result.status).toBe('up_to_date');
    expect(runQuery).not.toHaveBeenCalled();
    expect(configUpdate).not.toHaveBeenCalled();
  });

  it('nessun database collegato → non c’e’ nulla da aggiornare', async () => {
    shopFindUnique.mockResolvedValue(
      shopRow({ connectionVerifiedAt: null }),
    );

    expect((await applyMerchantSchemaUpdate('shop-1')).status).toBe('not_connected');
    expect(runQuery).not.toHaveBeenCalled();
  });

  it('senza OAuth ricade sulla service role key', async () => {
    shopFindUnique.mockResolvedValue(shopRow());
    vi.mocked(getValidAccessToken).mockRejectedValue(new Error('non collegato'));
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    expect((await applyMerchantSchemaUpdate('shop-1')).status).toBe('applied');
    expect(fetch).toHaveBeenCalledWith(
      'https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/exec_sql',
      expect.anything(),
    );
  });

  it('se l’SQL non passa, la versione NON avanza', async () => {
    // Registrare una versione non applicata vorrebbe dire non riprovare mai
    // piu': la sincronizzazione scriverebbe su colonne inesistenti per sempre.
    shopFindUnique.mockResolvedValue(shopRow());
    vi.mocked(getValidAccessToken).mockResolvedValue('token');
    vi.mocked(runQuery).mockRejectedValue(new Error('403'));
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as Response);

    const result = await applyMerchantSchemaUpdate('shop-1');

    expect(result).toEqual({ status: 'failed', version: 0 });
    expect(configUpdate).not.toHaveBeenCalled();
  });

  it('il piano senza clienti non fa toccare la loro tabella', async () => {
    shopFindUnique.mockResolvedValue(shopRow());
    findPlanMock.mockResolvedValue({ customersSyncEnabled: false });
    vi.mocked(getValidAccessToken).mockResolvedValue('token');

    await applyMerchantSchemaUpdate('shop-1');

    const sql = vi.mocked(runQuery).mock.calls[0][2];
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS customers');
  });
});

// Lo schema 13 porta `shipping_method` sugli ordini, ma gli ordini gia'
// salvati restano NULL: e' il momento di chiedere a Shopify la loro opzione.
describe('recupero dell opzione quando lo schema arriva alla 13', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSchemaUpdateAttempts();
    findPlanMock.mockResolvedValue({ customersSyncEnabled: true });
    configUpdate.mockResolvedValue({});
    vi.mocked(getValidAccessToken).mockResolvedValue('token');
    vi.mocked(runQuery).mockResolvedValue(undefined as never);
  });

  it('da 12 a 13 con gli ordini: accoda il recupero', async () => {
    shopFindUnique.mockResolvedValue({ ...shopRow({ schemaVersion: 12 }), scopes: 'read_orders,read_all_orders' });

    expect((await applyMerchantSchemaUpdate('shop-1')).status).toBe('applied');
    expect(enqueueShippingMethodBackfill).toHaveBeenCalledWith('shop-1');
  });

  it('senza permesso sugli ordini: niente da recuperare', async () => {
    shopFindUnique.mockResolvedValue({ ...shopRow({ schemaVersion: 12 }), scopes: 'read_products' });

    await applyMerchantSchemaUpdate('shop-1');
    expect(enqueueShippingMethodBackfill).not.toHaveBeenCalled();
  });

  it('gia\' alla 13: nessun recupero a ogni apertura della dashboard', async () => {
    shopFindUnique.mockResolvedValue({
      ...shopRow({ schemaVersion: LATEST_SCHEMA_VERSION }),
      scopes: 'read_orders',
    });

    await applyMerchantSchemaUpdate('shop-1');
    expect(enqueueShippingMethodBackfill).not.toHaveBeenCalled();
  });

  it('aggiornamento fallito: la colonna non c\'e\', niente recupero', async () => {
    shopFindUnique.mockResolvedValue({ ...shopRow({ schemaVersion: 12 }), scopes: 'read_orders' });
    vi.mocked(runQuery).mockRejectedValue(new Error('403'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    expect((await applyMerchantSchemaUpdate('shop-1')).status).toBe('failed');
    expect(enqueueShippingMethodBackfill).not.toHaveBeenCalled();
  });
});

describe('triggerMerchantSchemaUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSchemaUpdateAttempts();
    findPlanMock.mockResolvedValue({ customersSyncEnabled: true });
    configUpdate.mockResolvedValue({});
    shopFindUnique.mockResolvedValue(shopRow());
    vi.mocked(getValidAccessToken).mockResolvedValue('token');
  });

  it('ricaricare la dashboard non scatena una raffica di tentativi', async () => {
    triggerMerchantSchemaUpdate('shop-1');
    triggerMerchantSchemaUpdate('shop-1');
    triggerMerchantSchemaUpdate('shop-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shopFindUnique).toHaveBeenCalledTimes(1);
  });

  it('negozi diversi non si bloccano a vicenda', async () => {
    triggerMerchantSchemaUpdate('shop-1');
    triggerMerchantSchemaUpdate('shop-2');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shopFindUnique).toHaveBeenCalledTimes(2);
  });
});
