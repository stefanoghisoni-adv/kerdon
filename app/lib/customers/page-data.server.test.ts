import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

// La prova guarda l'ORDINE in cui partono le due letture, non i loro
// contenuti: report e campi personalizzati sono finti, e ciascuno resta in
// sospeso finche' la prova non decide di farlo rispondere.
vi.mock('./customers.server', () => ({ loadCustomersReport: vi.fn() }));
vi.mock('./birthdate-dismissal.server', () => ({
  birthdateNoticeDismissedFor: vi.fn(async () => null),
}));
vi.mock('~/lib/shopify-api.server', () => ({ ShopifyAPIClient: { forShop: vi.fn() } }));

import { loadCustomersReport } from './customers.server';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import { ServerTiming } from '~/lib/timing/server-timing';
import { startCustomersPageData } from './page-data.server';

function inSospeso<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const REPORT = { rows: [], currency: 'EUR', lifetimeCustomers: 0, unavailable: null } as const;
const shop = { id: 'shop-1', birthdateMetafieldNamespace: 'facts', birthdateMetafieldKey: 'birth_date' };
const avvia = (timing?: ServerTiming) =>
  startCustomersPageData({
    shopDomain: 'x.myshopify.com',
    shop,
    range: { from: '2026-08-27', to: '2026-09-25' },
    timing,
  });

let definizioni: ReturnType<typeof inSospeso<any[]>>;
let report: ReturnType<typeof inSospeso<any>>;

beforeEach(() => {
  definizioni = inSospeso<any[]>();
  report = inSospeso<any>();
  vi.mocked(loadCustomersReport).mockReset();
  vi.mocked(loadCustomersReport).mockReturnValue(report.promise);
  vi.mocked(ShopifyAPIClient.forShop).mockResolvedValue({
    listCustomerMetafieldDefinitions: () => definizioni.promise,
  } as any);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('startCustomersPageData', () => {
  it('il report parte subito, senza aspettare i campi da Shopify', async () => {
    const data = avvia();

    // Shopify non ha ancora risposto, e il report e' gia' stato chiesto.
    expect(loadCustomersReport).toHaveBeenCalledTimes(1);

    report.resolve(REPORT);
    definizioni.resolve([{ namespace: 'facts', key: 'birth_date', name: 'Nascita', type: 'date' }]);
    const out = await data;
    expect(out.report).toEqual(REPORT);
    expect(out.birthdate.state).toBe('in_use');
  });

  it('e i campi da Shopify si chiedono senza aspettare il report', async () => {
    const data = avvia();
    await Promise.resolve();
    await Promise.resolve();

    expect(ShopifyAPIClient.forShop).toHaveBeenCalledTimes(1);

    definizioni.resolve([]);
    report.resolve(REPORT);
    await data;
  });

  it('un report che fallisce diventa "lettura non riuscita", non una pagina d\'errore', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = avvia();
    report.reject(new Error('Supabase query error: 500'));
    definizioni.resolve([]);

    expect((await data).report).toEqual({
      rows: [],
      currency: 'EUR',
      lifetimeCustomers: 0,
      unavailable: 'failed',
    });
  });

  it('campi non leggibili: elenco "non letto", e la scelta salvata non si smentisce', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const data = avvia();
    report.resolve(REPORT);
    definizioni.reject(new Error('Shopify 503'));

    const { birthdate } = await data;
    expect(birthdate.definitions).toEqual([]);
    expect(birthdate.ourDefinitionPresent).toBeNull();
    expect(birthdate.state).toBe('in_use');
  });

  it('annota la durata della lettura dei campi', async () => {
    const timing = new ServerTiming();
    const data = avvia(timing);
    report.resolve(REPORT);
    definizioni.resolve([]);
    await data;

    expect(timing.header()).toMatch(/definitions;dur=/);
  });
});
