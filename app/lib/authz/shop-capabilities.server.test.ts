import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUniqueShop = vi.fn();
const findFirstPlan = vi.fn();
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) },
    plan: { findFirst: (...a: unknown[]) => findFirstPlan(...a) },
  },
}));

import { can, denialOf, CAPABILITIES } from './capabilities';
import {
  CAPABILITY_SHOP_SELECT,
  shopCapabilities,
  shopCapabilitiesById,
  shopCapabilitiesByDomain,
  shopCapabilitiesWithPlan,
  type CapabilityShopRow,
} from './shop-capabilities.server';

/**
 * Il ponte fra la policy e il database.
 *
 * La policy ha i suoi test e non sa cos'e' una riga. Qui si prova l'altra
 * meta': che i fatti giusti arrivino dalla riga giusta, e soprattutto che un
 * negozio che non si e' trovato non diventi per sbaglio un negozio che va bene.
 */

const RIGA: CapabilityShopRow = {
  lifecycleStatus: 'active',
  uninstalledAt: null,
  authorization: 'ENABLED',
  trackingAuthorization: 'ENABLED',
  scopes: 'read_products,read_orders,read_all_orders',
  currentPlan: 'pro',
  // Prova finita e abbonamento attivo: e' il negozio che paga, quello a cui la
  // scadenza della prova non toglie niente.
  isInTrial: false,
  trialEndsAt: null,
  activeChargeId: '1234',
  supabaseConfig: { connectionVerifiedAt: new Date('2026-01-01T00:00:00Z') },
};

const PIANO = { customersSyncEnabled: true, productFeedsEnabled: true };

beforeEach(() => {
  findUniqueShop.mockReset();
  findFirstPlan.mockReset();
  findFirstPlan.mockResolvedValue({ planName: 'pro', ...PIANO });
});

describe("shopCapabilitiesWithPlan — il piano gia' in mano", () => {
  it('con la riga e il piano a posto concede tutto', async () => {
    const caps = shopCapabilitiesWithPlan(RIGA, PIANO);
    for (const capability of CAPABILITIES) expect(can(caps, capability)).toBe(true);
  });

  it("non interroga il database: e' tutto il motivo per cui esiste", () => {
    shopCapabilitiesWithPlan(RIGA, PIANO);
    expect(findFirstPlan).not.toHaveBeenCalled();
    expect(findUniqueShop).not.toHaveBeenCalled();
  });

  it('riga assente: nega tutto, anche con un piano buono in mano', () => {
    // Il piano non riscatta un negozio che non c'e': senza riga non si sa di chi
    // si sta parlando, e la risposta prudente e' una sola.
    for (const assente of [null, undefined]) {
      const caps = shopCapabilitiesWithPlan(assente, PIANO);
      for (const capability of CAPABILITIES) {
        expect(denialOf(caps, capability)).toBe('unknown_shop');
      }
    }
  });

  it('config Supabase assente vale come scollegato', () => {
    for (const senza of [{ ...RIGA, supabaseConfig: null }, { ...RIGA, supabaseConfig: undefined }]) {
      const caps = shopCapabilitiesWithPlan(senza, PIANO);
      expect(denialOf(caps, 'sync_products')).toBe('not_connected');
      // L'uso dell'app no: e' durante la configurazione che il collegamento
      // ancora non c'e', e le schermate che lo creano devono funzionare.
      expect(can(caps, 'use_app')).toBe(true);
    }
  });
});

describe('shopCapabilities — il piano lo cerca lei', () => {
  it('cerca il piano scritto sul negozio', async () => {
    await shopCapabilities(RIGA);
    expect(findFirstPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { planName: { equals: 'pro', mode: 'insensitive' } },
      }),
    );
  });

  it('piano non trovato nel listino: le funzioni del piano si spengono', async () => {
    // Un piano rinominato nel listino non deve regalare cio' che quel piano non
    // comprendeva. La sincronizzazione dei prodotti invece prosegue: dal piano
    // non dipende.
    findFirstPlan.mockResolvedValue(null);
    const caps = await shopCapabilities(RIGA);
    expect(denialOf(caps, 'sync_customers')).toBe('plan_required');
    expect(denialOf(caps, 'use_feeds')).toBe('plan_required');
    expect(can(caps, 'sync_products')).toBe(true);
  });

  it('negozio nullo: nega tutto senza nemmeno cercare il piano', async () => {
    const caps = await shopCapabilities(null);
    expect(denialOf(caps, 'use_app')).toBe('unknown_shop');
    expect(findFirstPlan).not.toHaveBeenCalled();
  });
});

describe('shopCapabilitiesByDomain / ById — la riga la cerca lei', () => {
  it('dominio sconosciuto: tutto negato', async () => {
    findUniqueShop.mockResolvedValue(null);
    const caps = await shopCapabilitiesByDomain('mai-visto.myshopify.com');
    for (const capability of CAPABILITIES) {
      expect(denialOf(caps, capability)).toBe('unknown_shop');
    }
  });

  it('id sconosciuto: tutto negato', async () => {
    findUniqueShop.mockResolvedValue(null);
    const caps = await shopCapabilitiesById('shop-che-non-esiste');
    for (const capability of CAPABILITIES) {
      expect(denialOf(caps, capability)).toBe('unknown_shop');
    }
  });

  it('chiede al database esattamente le colonne che la policy legge', async () => {
    findUniqueShop.mockResolvedValue(RIGA);
    await shopCapabilitiesByDomain('negozio.myshopify.com');
    expect(findUniqueShop).toHaveBeenCalledWith({
      where: { shopDomain: 'negozio.myshopify.com' },
      select: CAPABILITY_SHOP_SELECT,
    });
  });

  it('negozio trovato e in regola: concede', async () => {
    findUniqueShop.mockResolvedValue(RIGA);
    const caps = await shopCapabilitiesById('shop-1');
    expect(can(caps, 'sync_products')).toBe(true);
  });

  it('negozio sospeso: nega, anche arrivandoci per id', async () => {
    findUniqueShop.mockResolvedValue({ ...RIGA, authorization: 'DISABLED' });
    const caps = await shopCapabilitiesById('shop-1');
    expect(denialOf(caps, 'sync_products')).toBe('not_authorized');
  });
});

describe('CAPABILITY_SHOP_SELECT — la select non deve restare indietro', () => {
  /**
   * Se domani la policy imparasse a guardare un'altra colonna e questa select
   * non la chiedesse, chi carica il negozio da qui deciderebbe su un campo
   * assente — cioe' negherebbe a un negozio che invece andava bene, e in
   * silenzio. Questo test e' il promemoria.
   */
  it('chiede tutti i fatti che la policy legge dalla riga', () => {
    expect(Object.keys(CAPABILITY_SHOP_SELECT).sort()).toEqual(
      [
        'authorization',
        'currentPlan',
        'scopes',
        'supabaseConfig',
        'trackingAuthorization',
        'uninstalledAt',
        // I tre fatti della prova: senza, la policy non farebbe scadere niente
        // proprio per chi arriva da qui — i webhook, il feed, il proxy.
        'isInTrial',
        'trialEndsAt',
        'activeChargeId',
        // Il ciclo di vita: senza, un negozio la cui cancellazione e' gia'
        // cominciata continuerebbe a essere autorizzato a scrivere proprio da
        // chi arriva da qui — le notifiche di Shopify e il proxy di lettura.
        'lifecycleStatus',
      ].sort(),
    );
    expect(CAPABILITY_SHOP_SELECT.supabaseConfig.select).toEqual({ connectionVerifiedAt: true });
  });
});

describe('i fatti della prova arrivano dalla riga, non da un ricalcolo', () => {
  /**
   * La scadenza autorevole e' quella scritta il giorno in cui la prova e'
   * partita. Prima veniva ricostruita da `installedAt` piu' i giorni del piano,
   * e quel conto dava una seconda data — diversa da questa ogni volta che il
   * listino cambiava.
   */
  const SCADENZA = new Date('2026-03-01T00:00:00.000Z');

  const inProva: CapabilityShopRow = {
    ...RIGA,
    isInTrial: true,
    trialEndsAt: SCADENZA,
    activeChargeId: null,
  };

  it('prova finita: nega, e lo dice', () => {
    const caps = shopCapabilitiesWithPlan(inProva, PIANO, SCADENZA);
    expect(denialOf(caps, 'use_app')).toBe('trial_expired');
    expect(denialOf(caps, 'use_read_proxy')).toBe('trial_expired');
  });

  it('un istante prima concede ancora tutto', () => {
    const caps = shopCapabilitiesWithPlan(inProva, PIANO, new Date(SCADENZA.getTime() - 1));
    for (const capability of CAPABILITIES) expect(can(caps, capability)).toBe(true);
  });

  it("l'istante si puo' iniettare anche passando dal listino", async () => {
    findUniqueShop.mockResolvedValue(inProva);
    const caps = await shopCapabilities(inProva, SCADENZA);
    expect(denialOf(caps, 'sync_products')).toBe('trial_expired');
  });
});
