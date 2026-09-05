import { describe, it, expect } from 'vitest';
import {
  buildShopExport,
  shopExportFilename,
  SEGRETI_ESCLUSI,
  type ShopExportRows,
} from './shop-export';

const QUANDO = new Date('2026-09-05T10:00:00.000Z');

function righe(override: Partial<ShopExportRows> = {}): ShopExportRows {
  return {
    shop: {
      shopDomain: 'coreward-demo.myshopify.com',
      primaryDomain: 'negozio.it',
      installedAt: new Date('2026-01-10T08:00:00.000Z'),
      uninstalledAt: null,
      ianaTimezone: 'Europe/Rome',
      shopCurrency: 'EUR',
      locale: 'it',
      preferredCurrency: 'EUR',
      currentPlan: 'pro',
      billingCycle: 'monthly',
      billingCurrency: 'EUR',
      planStartedAt: new Date('2026-02-01T08:00:00.000Z'),
      trialEndsAt: null,
      isInTrial: false,
      partnerName: null,
      discountIntervals: null,
      scopes: 'read_products,write_products,read_orders',
      authorization: 'ENABLED',
      trackingAuthorization: 'ENABLED',
      setupCompletedAt: new Date('2026-01-11T08:00:00.000Z'),
      birthdateMetafieldNamespace: 'custom',
      birthdateMetafieldKey: 'data_di_nascita',
    },
    supabaseConfig: {
      supabaseUrl: 'https://abc.supabase.co',
      supabaseProjectRef: 'abc',
      supabaseProjectName: 'Il mio progetto',
      tableNameProducts: 'products',
      tableNameCustomers: 'customers',
      syncIntervalHours: 24,
      connectionVerifiedAt: new Date('2026-01-11T09:00:00.000Z'),
      schemaVersion: 7,
      createdAt: new Date('2026-01-11T08:30:00.000Z'),
    },
    trackingSetup: { answer: 'has', platforms: ['meta'], answeredAt: QUANDO },
    billingCharges: [
      {
        planType: 'pro',
        price: { toString: () => '29.00' },
        currency: 'EUR',
        billingCycle: 'monthly',
        status: 'active',
        trialDays: 14,
        activatedAt: new Date('2026-02-01T08:00:00.000Z'),
        cancelledAt: null,
        createdAt: new Date('2026-02-01T07:59:00.000Z'),
      },
    ],
    syncJobs: [
      {
        jobType: 'periodic_check',
        status: 'completed',
        startedAt: QUANDO,
        completedAt: QUANDO,
        productsSynced: 12,
        variantsSynced: 30,
        customersSynced: 4,
      },
    ],
    complianceRequests: [
      { topic: 'customers/data_request', status: 'completed', receivedAt: QUANDO },
    ],
    accessLogs: [{ outcome: 'ok', status: 200, createdAt: QUANDO }],
    ...override,
  };
}

describe('la copia dei dati del negozio', () => {
  it('porta chi e il negozio, il piano e come e configurato', () => {
    const f = buildShopExport(righe(), QUANDO);

    expect(f.negozio.dominio).toBe('coreward-demo.myshopify.com');
    expect(f.negozio.permessi_concessi).toEqual([
      'read_products',
      'write_products',
      'read_orders',
    ]);
    expect(f.negozio.campo_data_di_nascita).toBe('custom.data_di_nascita');
    expect(f.piano.attuale).toBe('pro');
    expect(f.database_collegato?.tabella_prodotti).toBe('products');
    expect(f.sincronizzazioni).toHaveLength(1);
    expect(f.accessi_ai_dati_dei_clienti).toHaveLength(1);
  });

  // La riga che conta. Il file finisce su un disco e ci resta: una credenziale
  // che ci scivola dentro non si richiama piu' indietro.
  it('non contiene nessun segreto, a nessun livello', () => {
    const testo = JSON.stringify(buildShopExport(righe(), QUANDO));

    for (const nome of SEGRETI_ESCLUSI) {
      expect(testo).not.toContain(nome);
    }
    // E nemmeno i valori: il finto qui sopra non li ha, ma se un giorno il
    // costruttore prendesse la riga intera del negozio se li porterebbe dietro.
    expect(testo).not.toContain('shpat_');
    expect(testo).not.toContain('eyJ');
  });

  it('il prezzo si legge come un importo, non come un oggetto', () => {
    const f = buildShopExport(righe(), QUANDO);
    expect(f.abbonamenti[0].prezzo).toBe('29.00');
  });

  it('senza database collegato il file esce lo stesso', () => {
    const f = buildShopExport(righe({ supabaseConfig: null, trackingSetup: null }), QUANDO);
    expect(f.database_collegato).toBeNull();
    expect(f.tracciamento).toBeNull();
    expect(f.negozio.dominio).toBe('coreward-demo.myshopify.com');
  });

  it('dice a chi lo apre che i dati dei clienti non sono li dentro', () => {
    expect(buildShopExport(righe(), QUANDO).cosa_e_questo).toContain('database');
  });

  it('il nome del file distingue due negozi e porta il giorno', () => {
    expect(shopExportFilename('coreward-demo.myshopify.com', QUANDO)).toBe(
      'coreward-coreward-demo-2026-09-05.json',
    );
    // Un dominio proprio non deve poter uscire dal nome del file.
    expect(shopExportFilename('negozio/../etc', QUANDO)).toBe('coreward-negozio----etc-2026-09-05.json');
  });
});
