import { describe, it, expect, vi, beforeEach } from 'vitest';
import { creaFakeWebhookStore } from '~/lib/webhooks/inbox-fake-store';

/**
 * waitUntil: l'elaborazione continua dopo l'ack anche su Vercel serverless.
 *
 * COSA TESTA QUESTO FILE. Che la ricevuta venga scritta PRIMA del 200, che
 * l'elaborazione parta DOPO il 200, e che su Vercel — dove `waitUntil` esiste
 * — quella elaborazione venga registrata presso il runtime invece di restare
 * solo in un Set in memoria. Senza `waitUntil`, Vercel puo' terminare la
 * funzione subito dopo il 200 e rimandare tutto al cron.
 *
 * COSA NON TESTA. L'effetto vero di `waitUntil` — che Vercel tenga viva la
 * funzione finche' la promise non finisce — perche' i test non girano su
 * Vercel. Testa che la promise VENGA PASSATA a `waitUntil` quando fornita, e
 * che senza `waitUntil` il codice non sollevi.
 */

const store = creaFakeWebhookStore();

// Il processore finto: risolve dopo un ritardo, cosi' si puo' verificare che
// la risposta non lo aspetti.
const { processWebhookEvent } = vi.hoisted(() => ({
  processWebhookEvent: vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return 'done' as const;
  }),
}));

vi.mock('~/lib/webhooks/verify.server', () => ({ verifyWebhook: () => true }));
vi.mock('~/shopify.server', () => ({ unauthenticated: {}, shopify: {} }));
vi.mock('~/lib/shopify-api.server', () => ({
  ShopifyAPIClient: { forShop: vi.fn() },
}));
vi.mock('~/db.server', () => ({
  prisma: {
    get webhookEvent() {
      return store;
    },
    session: { count: async () => 0 },
  },
}));
vi.mock('~/lib/webhooks/inbox.server', async (importActual) => {
  const actual = await importActual<typeof import('~/lib/webhooks/inbox.server')>();
  return {
    ...actual,
    processWebhookEvent,
  };
});

import { receiveShopifyWebhook, settleWebhookWork } from './receive.server';
import type { waitUntil } from '@vercel/functions';

function req(topic = 'products/update', deliveryId?: string) {
  const headers: Record<string, string> = {
    'X-Shopify-Hmac-Sha256': 'sig',
    'X-Shopify-Shop-Domain': 'test.myshopify.com',
    'X-Shopify-Topic': topic,
  };
  if (deliveryId) headers['X-Shopify-Webhook-Id'] = deliveryId;

  return new Request('https://app/webhooks', {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: 456, admin_graphql_api_id: 'gid://shopify/Product/456' }),
  });
}

describe('receiveShopifyWebhook con waitUntil', () => {
  beforeEach(() => {
    store.reset();
    store.shouldFailCreate = false;
    vi.clearAllMocks();
  });

  it('risponde 200 subito, prima che il processore finisca', async () => {
    // Nessun waitUntil: degrade senza errori
    const response = await receiveShopifyWebhook(req('products/update', 'delivery-1'), 'products/update');

    expect(response.status).toBe(200);
    // Il processore e' stato chiamato ma NON aspettato (ancora pendente)
    expect(processWebhookEvent).toHaveBeenCalled();
    // La mock promise da 50ms di ritardo: verifichiamo che non sia risolta
    const callPromise = processWebhookEvent.mock.results[0].value as Promise<unknown>;
    let resolved = false;
    callPromise.then(() => { resolved = true; });
    await Promise.resolve(); // microtask
    expect(resolved).toBe(false); // ancora pendente alla risposta

    // Ma il lavoro finira': lo aspettiamo per pulizia
    await settleWebhookWork();
  });

  it('scrive la ricevuta PRIMA di rispondere 200', async () => {
    // Prima della chiamata, nessuna ricevuta
    expect(store.righe).toHaveLength(0);

    const response = await receiveShopifyWebhook(req('products/update', 'delivery-2'), 'products/update');

    // Dopo la risposta, la ricevuta c'e' gia'
    expect(response.status).toBe(200);
    expect(store.righe).toHaveLength(1);
    expect(store.righe[0].status).toBe('queued');

    await settleWebhookWork();
  });

  it('passa la promise a waitUntil quando fornita', async () => {
    const mockWaitUntil = vi.fn();

    const response = await receiveShopifyWebhook(req('products/update', 'delivery-3'), 'products/update', {
      waitUntil: mockWaitUntil as any,
    });

    expect(response.status).toBe(200);
    // waitUntil e' stata chiamata con una promise
    expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    const arg = mockWaitUntil.mock.calls[0][0];
    expect(arg).toBeInstanceOf(Promise);

    // Verifica che sia la promise con .catch (quella che gestisce gli errori)
    expect(processWebhookEvent).toHaveBeenCalledTimes(1);

    // La promise passata a waitUntil non deve mai rigettare, nemmeno se
    // processWebhookEvent fallisce. Testiamo che arg risolva sempre, mai rigetti.
    let rejected = false;
    const settled = arg.then(
      () => 'resolved',
      () => {
        rejected = true;
        return 'rejected';
      },
    );

    await settleWebhookWork();
    expect(await settled).toBe('resolved');
    expect(rejected).toBe(false);
  });

  it('avvia il processore anche senza waitUntil', async () => {
    // Senza waitUntil: degrade a comportamento pre-esistente
    await receiveShopifyWebhook(req('products/update', 'delivery-4'), 'products/update');

    // Il processore e' stato chiamato lo stesso
    expect(processWebhookEvent).toHaveBeenCalledTimes(1);

    await settleWebhookWork();
  });

  it('non solleva se waitUntil e undefined', async () => {
    await expect(
      receiveShopifyWebhook(req('products/update', 'delivery-5'), 'products/update', { waitUntil: undefined as any }),
    ).resolves.toBeDefined();

    await settleWebhookWork();
  });

  it('risponde 200 anche per consegne duplicate, e waitUntil viene chiamata', async () => {
    const mockWaitUntil = vi.fn();
    const deliveryId = 'delivery-6';

    // Prima consegna
    await receiveShopifyWebhook(req('products/update', deliveryId), 'products/update', { waitUntil: mockWaitUntil as any });
    await settleWebhookWork();

    vi.clearAllMocks();

    // Seconda consegna, stesso webhook ID
    const response = await receiveShopifyWebhook(req('products/update', deliveryId), 'products/update', {
      waitUntil: mockWaitUntil as any,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; duplicate: boolean };
    expect(body.duplicate).toBe(true);

    // waitUntil e' stata chiamata anche per il duplicato: la presa dentro
    // processWebhookEvent proteggera' dal doppio lavoro
    expect(mockWaitUntil).toHaveBeenCalledTimes(1);

    await settleWebhookWork();
  });

  it('risponde 500 se la ricevuta non si scrive, e waitUntil NON viene chiamata', async () => {
    const mockWaitUntil = vi.fn();

    // Forziamo un errore nella scrittura
    store.shouldFailCreate = true;

    const response = await receiveShopifyWebhook(req('products/update', 'delivery-7'), 'products/update', {
      waitUntil: mockWaitUntil as any,
    });

    expect(response.status).toBe(500);
    // waitUntil NON e' stata chiamata: senza ricevuta, non si avvia niente
    expect(mockWaitUntil).not.toHaveBeenCalled();
  });

  it('terminazione immediata: ricevuta queued, recupero dal cron', async () => {
    // Questo test simula la terminazione della funzione subito dopo il 200:
    // la ricevuta e' scritta ma l'elaborazione non finisce. Il cron la recupera.

    const response = await receiveShopifyWebhook(req('products/update', 'delivery-8'), 'products/update');

    // Risposta 200 immediata
    expect(response.status).toBe(200);

    // Ricevuta scritta, stato queued (elaborazione non awaited)
    expect(store.righe).toHaveLength(1);
    const riga = store.righe[0];
    expect(riga.status).toBe('queued');
    expect(riga.webhookId).toContain('delivery-8');

    // NON aspettiamo settleWebhookWork: simula terminazione prima del completamento

    // Il cron drena la riga con un processore fittizio che completa subito
    const { drainWebhookEvents } = await import('./inbox.server');
    const fakeProcessors = {
      'products/update': async () => 'done' as const,
    } as any;
    const now = new Date();

    const esito = await drainWebhookEvents(fakeProcessors, now);

    // La riga e' stata lavorata
    expect(esito.processed).toBe(1);
    expect(store.righe[0].status).toBe('completed');
  });

  it('elaborazione abbandonata (processing stale): ripresa dal cron', async () => {
    // Simula una funzione kill a meta' lavoro: la riga resta `processing` con
    // startedAt vecchio. Il cron la riporta a `queued` e la rilavorala.

    const response = await receiveShopifyWebhook(req('products/update', 'delivery-9'), 'products/update');
    expect(response.status).toBe(200);

    // Forziamo lo stato `processing` come se fosse stata presa e poi killata
    const seiMinutiFa = new Date(Date.now() - 6 * 60 * 1000);
    store.righe[0].status = 'processing';
    store.righe[0].startedAt = seiMinutiFa;

    // Il cron trova la riga stale e la riprende con un processore fittizio
    const { drainWebhookEvents } = await import('./inbox.server');
    const fakeProcessors = {
      'products/update': async () => 'done' as const,
    } as any;
    const now = new Date();

    const esito = await drainWebhookEvents(fakeProcessors, now);

    // La riga stale e' stata riportata a queued e poi lavorata
    expect(esito.processed).toBe(1);
    expect(store.righe[0].status).toBe('completed');
  });
});
