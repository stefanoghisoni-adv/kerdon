import { describe, it, expect, vi, beforeEach } from 'vitest';

const shopFindUnique = vi.fn();
const shopUpdateMany = vi.fn();
const sessionDeleteMany = vi.fn();
const eventUpdateMany = vi.fn();
const configDeleteMany = vi.fn();
const tokenDeleteMany = vi.fn();
const planFindFirst = vi.fn();
const transaction = vi.fn(async (operazioni: unknown[]) => Promise.all(operazioni as never[]));

vi.mock('~/db.server', () => ({
  prisma: {
    shop: {
      findUnique: (...a: unknown[]) => shopFindUnique(...a),
      updateMany: (...a: unknown[]) => shopUpdateMany(...a),
    },
    session: { deleteMany: (...a: unknown[]) => sessionDeleteMany(...a) },
    webhookEvent: { updateMany: (...a: unknown[]) => eventUpdateMany(...a) },
    supabaseConfig: { deleteMany: (...a: unknown[]) => configDeleteMany(...a) },
    supabaseOAuthToken: { deleteMany: (...a: unknown[]) => tokenDeleteMany(...a) },
    plan: { findFirst: (...a: unknown[]) => planFindFirst(...a) },
    $transaction: (...a: unknown[]) => transaction(...(a as [unknown[]])),
  },
}));
vi.mock('~/utils/crypto.server', () => ({ decrypt: (v: string) => v.replace(/^enc\(|\)$/g, '') }));

import { handleAppUninstalled, markShopUninstalled } from './handle-uninstall.server';
import {
  clearReadContextCache,
  resolveShopReadContext,
} from '~/lib/read-proxy/context.server';
import type { ClaimedWebhookEvent } from './inbox.server';

const DOMINIO = 'negozio.myshopify.com';
const ORA = new Date('2026-09-05T12:00:00.000Z');

const evento: ClaimedWebhookEvent = {
  id: 'evento-1',
  topic: 'app/uninstalled',
  shopDomain: DOMINIO,
  payload: { id: 1 },
  attempts: 1,
};

/** La riga del negozio come la vede il proxy di lettura. */
function rigaNegozio(over: Record<string, unknown> = {}) {
  return {
    id: 'shop-1',
    shopDomain: DOMINIO,
    uninstalledAt: null,
    authorization: 'ENABLED',
    trackingAuthorization: 'ENABLED',
    scopes: 'read_products',
    currentPlan: 'free',
    trialEndsAt: null,
    isInTrial: false,
    activeChargeId: null,
    supabaseConfig: {
      supabaseProjectRef: 'abcref',
      supabaseServiceRoleKey: 'enc(svc)',
      connectionVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearReadContextCache();
  shopFindUnique.mockResolvedValue({ id: 'shop-1' });
  shopUpdateMany.mockResolvedValue({ count: 1 });
  sessionDeleteMany.mockResolvedValue({ count: 1 });
  eventUpdateMany.mockResolvedValue({ count: 1 });
  planFindFirst.mockResolvedValue({
    planName: 'free',
    customersSyncEnabled: false,
    productFeedsEnabled: false,
  });
});

describe('la disinstallazione applicata', () => {
  it('segna la data, e la segna una volta sola', async () => {
    // La condizione `uninstalledAt: null` non e' un'ottimizzazione: senza,
    // una seconda lavorazione sposterebbe la data in avanti, e da quella data
    // si legge da quanto un negozio e' andato via.
    expect(await handleAppUninstalled(evento, ORA)).toBe('done');

    const arg = shopUpdateMany.mock.calls[0][0] as {
      where: unknown;
      data: { uninstalledAt: Date };
    };
    expect(arg.where).toEqual({ shopDomain: DOMINIO, uninstalledAt: null });
    expect(arg.data.uninstalledAt).toBe(ORA);
  });

  it('cancella le sessioni: il token e gia morto lato Shopify', async () => {
    await handleAppUninstalled(evento, ORA);

    expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { shop: DOMINIO } });
  });

  it('scrive le due cose insieme, o nessuna delle due', async () => {
    // A meta' il negozio risulterebbe ancora installato con le sessioni gia'
    // cancellate: un negozio che le code continuano a cercare e per cui non
    // esiste piu' nessun modo di parlare con Shopify.
    await handleAppUninstalled(evento, ORA);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect((transaction.mock.calls[0][0] as unknown[]).length).toBe(3);
  });

  it('NON tocca il collegamento al database ne i dati del merchant', async () => {
    // E' la scelta di fondo: disinstallare l'app non cancella quello che il
    // merchant ha raccolto. Le tabelle stanno nel suo progetto e restano sue.
    await handleAppUninstalled(evento, ORA);

    expect(configDeleteMany).not.toHaveBeenCalled();
    expect(tokenDeleteMany).not.toHaveBeenCalled();
  });

  it('un negozio mai visto non fa fallire niente', async () => {
    // Il webhook arriva anche per installazioni mai completate: updateMany su
    // zero righe non lancia, e l'evento si chiude.
    shopFindUnique.mockResolvedValue(null);
    shopUpdateMany.mockResolvedValue({ count: 0 });

    expect(await handleAppUninstalled(evento, ORA)).toBe('done');
  });

  it('se il database non risponde, solleva invece di dichiarare fatto', async () => {
    // E' il rovescio della ricevuta: qui il 200 e' gia' stato dato, quindi
    // l'unica cosa che tiene in vita il lavoro e' che questo lancio arrivi a
    // chi conta i tentativi.
    transaction.mockRejectedValueOnce(new Error('database irraggiungibile'));

    await expect(handleAppUninstalled(evento, ORA)).rejects.toThrow('database irraggiungibile');
  });
});

describe('il proxy di lettura, dopo la disinstallazione', () => {
  it('nega la prima richiesta successiva anche con la cache calda', async () => {
    // E' il caso che la cache rendeva possibile: il token resta incollato nel
    // container della vetrina, e per la durata della riga il proxy continuava a
    // servire i clienti di un negozio che con noi aveva chiuso.
    shopFindUnique.mockResolvedValue(rigaNegozio());
    const prima = await resolveShopReadContext('token-della-vetrina');
    expect(prima.kind === 'ok' && prima.ctx.canReadData).toBe(true);

    // Da qui in poi il negozio e' disinstallato: la policy lo nega, ma solo se
    // qualcuno butta via la decisione presa un istante fa.
    shopFindUnique.mockImplementation(async (args: { where?: { shopDomain?: string } }) =>
      args?.where?.shopDomain === DOMINIO
        ? { id: 'shop-1' }
        : rigaNegozio({ uninstalledAt: ORA }),
    );

    await handleAppUninstalled(evento, ORA);

    const dopo = await resolveShopReadContext('token-della-vetrina');
    expect(dopo.kind === 'ok' && dopo.ctx.canReadData).toBe(false);
  });

  it('il token resta al suo posto: la reinstallazione non deve rifare la vetrina', async () => {
    // Smette di valere lo stesso istante — `use_read_proxy` parte da
    // `uninstalledAt` — e cancellarlo costerebbe al merchant che reinstalla la
    // riconfigurazione del suo container per un gesto reversibile.
    await handleAppUninstalled(evento, ORA);

    const scritture = shopUpdateMany.mock.calls.map((c) => (c[0] as { data: object }).data);
    for (const data of scritture) {
      expect(data).not.toHaveProperty('readProxyTokenHash');
      expect(data).not.toHaveProperty('readProxyTokenEnc');
    }
  });
});

describe('markShopUninstalled senza un evento', () => {
  it('e la stessa disinstallazione, meno il riferimento sull evento', async () => {
    // La riconciliazione periodica passa di qui: scopre la disinstallazione
    // guardando Shopify, e non ha nessun evento da annotare perche' l'evento e'
    // proprio quello che non e' mai arrivato.
    await markShopUninstalled(DOMINIO, ORA);

    expect((transaction.mock.calls[0][0] as unknown[]).length).toBe(2);
    expect(eventUpdateMany).not.toHaveBeenCalled();
    expect(sessionDeleteMany).toHaveBeenCalledWith({ where: { shop: DOMINIO } });
  });
});
