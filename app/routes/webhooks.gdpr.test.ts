import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('~/lib/webhooks/verify.server', () => ({ verifyWebhook: vi.fn(() => true) }));
vi.mock('~/lib/gdpr/compliance-queue.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/gdpr/compliance-queue.server')>();
  return { ...actual, enqueueComplianceRequest: vi.fn() };
});

import { action as redactCustomer } from './webhooks.gdpr.customers-redact';
import { action as dataRequest } from './webhooks.gdpr.data-request';
import { action as redactShop } from './webhooks.gdpr.shop-redact';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { enqueueComplianceRequest } from '~/lib/gdpr/compliance-queue.server';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Cosa prova questo file, e cosa non prova piu'.
 *
 * Le tre rotte non fanno piu' il lavoro: lo prendono in carico. Prima
 * cancellavano, leggevano il database del merchant e costruivano l'esportazione
 * dentro la richiesta HTTP, e su un negozio abbastanza grande superavano i
 * cinque secondi che Shopify concede alla ricevuta — con l'effetto che Shopify
 * contava una consegna fallita e ne mandava una seconda sopra un lavoro ancora
 * in corso. Quel lavoro adesso vive in lib/gdpr/process-compliance, e le prove
 * che lo riguardano stanno nel file di test di quel modulo.
 *
 * Qui resta il contratto della ricevuta, che e' piccolo e va difeso lo stesso:
 * chi non e' Shopify non entra, un corpo rotto non diventa un ritentativo
 * eterno, una richiesta che non si riesce a mettere in coda non deve sembrare
 * accolta, e nel corpo della risposta non esce nessun dato personale.
 */

const SHOP = 'test-shop.myshopify.com';

function req(body: string | object, headers: Record<string, string> = {}) {
  return new Request('https://app/webhooks/gdpr', {
    method: 'POST',
    headers: { 'X-Shopify-Hmac-Sha256': 'sig', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const customerPayload = { shop_domain: SHOP, customer: { id: 4021 } };

/** L'argomento con cui la rotta ha messo in coda la richiesta. */
function enqueued(call = 0) {
  return (enqueueComplianceRequest as any).mock.calls[call]?.[0];
}

let errorSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  (verifyWebhook as any).mockReturnValue(true);
  (enqueueComplianceRequest as any).mockResolvedValue({ id: 'req-1', duplicate: false });
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('la ricevuta, per tutti e tre i webhook', () => {
  const routes = [
    { name: 'customers/redact', action: redactCustomer, body: customerPayload },
    { name: 'customers/data_request', action: dataRequest, body: customerPayload },
    { name: 'shop/redact', action: redactShop, body: { shop_domain: SHOP } },
  ];

  for (const route of routes) {
    describe(route.name, () => {
      it('firma non valida → 401, e niente viene preso in carico', async () => {
        (verifyWebhook as any).mockReturnValue(false);
        const res = await route.action({ request: req(route.body) } as any);

        expect(res.status).toBe(401);
        expect(enqueueComplianceRequest).not.toHaveBeenCalled();
      });

      it('senza header di firma → 401', async () => {
        const res = await route.action({
          request: new Request('https://app/webhooks/gdpr', {
            method: 'POST',
            body: JSON.stringify(route.body),
          }),
        } as any);

        expect(res.status).toBe(401);
        expect(enqueueComplianceRequest).not.toHaveBeenCalled();
      });

      it('corpo malformato → 400, non 500', async () => {
        // Un 500 farebbe ritentare a Shopify lo stesso corpo rotto per giorni,
        // con lo stesso esito ogni volta.
        const res = await route.action({ request: req('{ non json') } as any);

        expect(res.status).toBe(400);
        expect(enqueueComplianceRequest).not.toHaveBeenCalled();
      });

      it('senza dominio del negozio → 400', async () => {
        const res = await route.action({ request: req({ customer: { id: 4021 } }) } as any);

        expect(res.status).toBe(400);
        expect(enqueueComplianceRequest).not.toHaveBeenCalled();
      });

      it('presa in carico → 200', async () => {
        const res = await route.action({ request: req(route.body) } as any);

        expect(res.status).toBe(200);
        expect(enqueued().topic).toBe(route.name);
        expect(enqueued().shopDomain).toBe(SHOP);
      });

      it('coda non disponibile → 500: la richiesta non e stata accolta e non deve sembrarlo', async () => {
        // E l unico caso in cui il ritentativo di Shopify cambia qualcosa: la
        // riga non esiste, quindi nessuno la lavorerebbe mai.
        (enqueueComplianceRequest as any).mockRejectedValue(new Error('database irraggiungibile'));
        const res = await route.action({ request: req(route.body) } as any);

        expect(res.status).toBe(500);
      });

      it('nel corpo della risposta non esce nessun dato personale', async () => {
        const res = await route.action({ request: req(route.body) } as any);
        const text = JSON.stringify(await res.json());

        expect(text).not.toContain('4021');
        expect(text).not.toContain(SHOP);
        expect(text).not.toContain('@');
      });

      it('la ricevuta non legge il database del merchant', async () => {
        // La prova indiretta che sta sotto i cinque secondi: l unica cosa che
        // accade dentro la richiesta e la scrittura della riga.
        const res = await route.action({ request: req(route.body) } as any);

        expect(res.status).toBe(200);
        expect(enqueueComplianceRequest).toHaveBeenCalledTimes(1);
      });

      it('una consegna ripetuta risponde 200 come la prima', async () => {
        // Per Shopify sono la stessa richiesta, e lo sono davvero. Rispondere
        // 500 alla ripetizione vorrebbe dire farsi ritentare all infinito un
        // lavoro gia in corso.
        (enqueueComplianceRequest as any).mockResolvedValue({ id: 'req-1', duplicate: true });
        const res = await route.action({ request: req(route.body) } as any);

        expect(res.status).toBe(200);
      });
    });
  }
});

describe('id della consegna, per la deduplica', () => {
  it("usa l header di Shopify quando c e", async () => {
    await redactCustomer({
      request: req(customerPayload, { 'X-Shopify-Webhook-Id': 'consegna-abc' }),
    } as any);

    expect(enqueued().webhookId).toBe('consegna-abc');
  });

  it("senza header, due consegne identiche si riconoscono lo stesso", async () => {
    // Un ritentativo che perde l header non deve diventare una seconda pratica.
    await redactCustomer({ request: req(customerPayload) } as any);
    await redactCustomer({ request: req(customerPayload) } as any);

    expect(enqueued(0).webhookId).toBe(enqueued(1).webhookId);
  });

  it('due topic diversi sullo stesso corpo non sono la stessa richiesta', async () => {
    await redactCustomer({ request: req(customerPayload) } as any);
    await dataRequest({ request: req(customerPayload) } as any);

    expect(enqueued(0).webhookId).not.toBe(enqueued(1).webhookId);
  });

  it('due negozi diversi non sono la stessa richiesta', async () => {
    await redactCustomer({ request: req(customerPayload) } as any);
    await redactCustomer({
      request: req({ ...customerPayload, shop_domain: 'altro.myshopify.com' }),
    } as any);

    expect(enqueued(0).webhookId).not.toBe(enqueued(1).webhookId);
  });
});

describe('cosa la rotta mette nella riga', () => {
  it("l impronta della persona, non il suo id in chiaro", async () => {
    await redactCustomer({ request: req(customerPayload) } as any);

    expect(enqueued().customerRef).toBeTruthy();
    expect(enqueued().customerRef).not.toContain('4021');
  });

  it("l id della pratica lato Shopify quando il payload ce l ha", async () => {
    await dataRequest({
      request: req({ ...customerPayload, data_request: { id: 987 } }),
    } as any);

    expect(enqueued().dataRequestId).toBe('987');
  });

  it('nessun id di pratica quando il payload non lo porta', async () => {
    await dataRequest({ request: req(customerPayload) } as any);

    expect(enqueued().dataRequestId).toBeNull();
  });
});

describe('customers/redact e data_request vogliono una persona', () => {
  it('customers/redact senza id cliente → 400', async () => {
    const res = await redactCustomer({ request: req({ shop_domain: SHOP }) } as any);

    expect(res.status).toBe(400);
    expect(enqueueComplianceRequest).not.toHaveBeenCalled();
  });

  it('data_request senza id cliente → 400', async () => {
    const res = await dataRequest({ request: req({ shop_domain: SHOP }) } as any);

    expect(res.status).toBe(400);
    expect(enqueueComplianceRequest).not.toHaveBeenCalled();
  });

  it('shop/redact invece non lo vuole: li la persona e il negozio', async () => {
    const res = await redactShop({ request: req({ shop_domain: SHOP }) } as any);

    expect(res.status).toBe(200);
    expect(enqueued().customerRef).toBeNull();
  });
});
