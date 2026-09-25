import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Il cancello, provato da solo.
 *
 * Qui si guarda la meccanica: chi passa, chi no, e — la parte che conta — che
 * il rifiuto arrivi PRIMA di qualunque cosa. Come si comporta ogni singola
 * rotta sta in `app/routes/authz-gate.test.ts`.
 */

const findUniqueShop = vi.fn();
const findFirstPlan = vi.fn();

vi.mock('~/shopify.server', () => ({
  authenticate: { admin: async () => ({ session: { shop: 'negozio.myshopify.com' } }) },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    shop: { findUnique: (...a: unknown[]) => findUniqueShop(...a) },
    plan: { findFirst: (...a: unknown[]) => findFirstPlan(...a) },
  },
}));

import {
  denialMessage,
  requireShopCapability,
  shopCapabilityOutcome,
} from './require-capability.server';
import { CAPABILITIES, type DenialReason } from './capabilities';
import { it as dizionario } from '~/lib/i18n/it';
import { en as dictionary } from '~/lib/i18n/en';

const richiesta = () => new Request('https://app.example.com/api/stats/customers');

/** Un negozio che puo' usare l'app: la base da cui si toglie un fatto alla volta. */
const ATTIVO = {
  id: 'negozio-1',
  shopDomain: 'negozio.myshopify.com',
  currentPlan: 'growth',
  lifecycleStatus: 'active',
  uninstalledAt: null,
  authorization: 'ENABLED',
  trackingAuthorization: 'ENABLED',
  scopes: 'read_products',
  isInTrial: false,
  trialEndsAt: null,
  activeChargeId: null,
  locale: 'it',
  detectedLocale: 'it',
  supabaseConfig: { connectionVerifiedAt: new Date('2026-01-01T00:00:00.000Z') },
};

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueShop.mockResolvedValue(ATTIVO);
  findFirstPlan.mockResolvedValue({
    planName: 'growth',
    customersSyncEnabled: true,
    productFeedsEnabled: true,
  });
});

describe('il cancello delle capacita', () => {
  it('a negozio attivo restituisce il negozio, senza farlo rileggere a chi chiama', async () => {
    const { shop, session } = await requireShopCapability(richiesta(), 'use_app');

    expect(shop.id).toBe('negozio-1');
    expect(session.shop).toBe('negozio.myshopify.com');
    // Una lettura sola: il negozio serve al permesso E a chi lo ha chiesto.
    expect(findUniqueShop).toHaveBeenCalledTimes(1);
  });

  it('porta con se tutte le capacita, non solo quella chiesta', async () => {
    const { capabilities } = await requireShopCapability(richiesta(), 'use_app');

    for (const capacita of CAPABILITIES) {
      expect(capabilities[capacita]).toBeDefined();
    }
  });

  it('prova finita: solleva un 403 e dice al merchant di aggiornare il piano', async () => {
    findUniqueShop.mockResolvedValue({
      ...ATTIVO,
      isInTrial: true,
      trialEndsAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    const rifiuto = (await requireShopCapability(richiesta(), 'use_app').catch(
      (e) => e,
    )) as Response;

    expect(rifiuto).toBeInstanceOf(Response);
    expect(rifiuto.status).toBe(403);
    expect(await rifiuto.json()).toEqual({
      error: dizionario.errors.trialEnded,
      code: 'trial_expired',
    });
  });

  it('negozio sospeso: 403, e la frase non e quella della prova', async () => {
    findUniqueShop.mockResolvedValue({ ...ATTIVO, authorization: 'DISABLED' });

    const rifiuto = (await requireShopCapability(richiesta(), 'use_app').catch(
      (e) => e,
    )) as Response;

    expect(rifiuto.status).toBe(403);
    expect(await rifiuto.json()).toEqual({
      error: dizionario.errors.suspended,
      code: 'not_authorized',
    });
  });

  it('cancellazione in corso: la frase e sua, non quella del sospeso', async () => {
    findUniqueShop.mockResolvedValue({ ...ATTIVO, lifecycleStatus: 'erasing' });

    const rifiuto = (await requireShopCapability(richiesta(), 'use_app').catch(
      (e) => e,
    )) as Response;

    expect(await rifiuto.json()).toEqual({
      error: dizionario.errors.erasureInProgress,
      code: 'erasing',
    });
  });

  // Un negozio di cui non si sa niente non riceve "negozio non trovato": quella
  // risposta racconterebbe, per differenza, quali domini esistono.
  it('negozio sconosciuto: 403, non 404', async () => {
    findUniqueShop.mockResolvedValue(null);

    const rifiuto = (await requireShopCapability(richiesta(), 'use_app').catch(
      (e) => e,
    )) as Response;

    expect(rifiuto.status).toBe(403);
  });

  it('per una pagina il rifiuto riporta alla dashboard, invece di una schermata d errore', async () => {
    findUniqueShop.mockResolvedValue({ ...ATTIVO, authorization: 'PENDING' });

    const rifiuto = (await requireShopCapability(richiesta(), 'use_app', {
      onDenied: 'redirect',
    }).catch((e) => e)) as Response;

    expect(rifiuto.status).toBe(302);
    expect(rifiuto.headers.get('Location')).toBe('/');
  });

  it('nella forma che restituisce, il rifiuto e un valore e non un lancio', async () => {
    findUniqueShop.mockResolvedValue({ ...ATTIVO, authorization: 'DISABLED' });

    const esito = await shopCapabilityOutcome(richiesta(), 'use_app');

    expect(esito.ok).toBe(false);
    if (esito.ok) throw new Error('atteso un rifiuto');
    expect(esito.denial).toBe('not_authorized');
    // La frase viaggia accanto alla risposta: le action che hanno gia' un corpo
    // tutto loro ci mettono dentro questa, senza rifarsi il dizionario.
    expect(esito.message).toBe(dizionario.errors.suspended);
  });
});

describe('le frasi per il merchant', () => {
  const MOTIVI: DenialReason[] = [
    'unknown_shop',
    'erasing',
    'uninstalled',
    'not_authorized',
    'tracking_suspended',
    'not_connected',
    'plan_required',
    'trial_expired',
    'scope_required',
  ];

  // Nessun motivo esce senza frase, in nessuna delle due lingue: un rifiuto
  // muto e' esattamente l'errore tecnico che non si vuole far leggere.
  it.each(MOTIVI)('%s ha una frase in italiano e una in inglese', (motivo) => {
    expect(denialMessage(motivo, dizionario).length).toBeGreaterThan(10);
    expect(denialMessage(motivo, dictionary).length).toBeGreaterThan(10);
  });

  // Le frasi dicono al merchant che cosa puo' fare, non come l'app decide: di
  // capacita', policy, permessi e colonne non gli importa niente.
  it.each(MOTIVI)('%s non nomina il funzionamento interno', (motivo) => {
    const frase = denialMessage(motivo, dizionario).toLowerCase();

    for (const parola of ['capability', 'policy', 'rls', 'proxy', 'token', 'prisma']) {
      expect(frase).not.toContain(parola);
    }
  });
});
