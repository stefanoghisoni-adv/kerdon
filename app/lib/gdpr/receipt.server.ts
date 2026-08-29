// app/lib/gdpr/receipt.server.ts
//
// La prima meta' di una richiesta di conformita': quella che risponde.
//
// Le tre rotte obbligatorie facevano tutte la stessa cosa sbagliata, e la
// facevano ognuna a modo suo. Prima di rispondere leggevano il nostro Postgres,
// poi il Supabase del merchant, poi gli ordini, poi le righe degli ordini —
// e solo alla fine dicevano a Shopify "ricevuto". Ma Shopify non sta aspettando
// che il lavoro sia finito: sta aspettando la ricevuta, e la aspetta per cinque
// secondi. Un negozio con abbastanza ordini superava quel limite, Shopify
// contava una consegna fallita e riprovava, e la seconda consegna ripartiva da
// capo su un lavoro che la prima stava ancora facendo.
//
// Qui la ricevuta e' l'unica cosa che accade dentro la richiesta HTTP: si
// verifica la firma, si legge il payload, si scrive una riga, si risponde. Il
// lavoro vero lo fa process-compliance, dopo, dove puo' metterci il tempo che
// serve e puo' fallire senza che nessuno lo scambi per un rifiuto.
//
// E l'esportazione non torna piu' nel corpo della risposta. Sembrava comodo —
// la consegna diventava una cosa sola con la richiesta — ma quel corpo va a
// Shopify, e Shopify non e' il destinatario: il destinatario e' il titolare del
// negozio, che deve riceverla entro trenta giorni per un canale suo. Mandare i
// dati personali di una persona a chi non li ha chiesti non e' una scorciatoia,
// e' una comunicazione in piu'.

import { json } from '@remix-run/node';
import { verifyWebhook } from '~/lib/webhooks/verify.server';
import { customerRef } from '~/lib/gdpr/audit.server';
import type { ComplianceTopic } from '~/lib/gdpr/compliance-queue.server';
import { deliveryId, enqueueComplianceRequest } from '~/lib/gdpr/compliance-queue.server';

interface CompliancePayload {
  shop_domain?: string;
  customer?: { id?: string | number };
  data_request?: { id?: string | number };
}

/**
 * Riceve una consegna di conformita' e la mette in lavorazione.
 *
 * Le risposte, e il perche' di ognuna:
 *
 *   401  firma non valida — non e' Shopify che parla
 *   400  payload illeggibile o senza i campi minimi. Non e' un 500: ritentare
 *        lo stesso corpo malformato darebbe lo stesso risultato per giorni
 *   500  la richiesta non e' stata messa in coda. E' l'unico caso in cui serve
 *        che Shopify ritenti, ed e' anche l'unico in cui il ritentativo cambia
 *        qualcosa: la riga non c'e', quindi nessuno la lavorera' mai
 *   200  presa in carico. Non "fatta": presa in carico
 */
export async function receiveComplianceWebhook(
  request: Request,
  topic: ComplianceTopic,
  { requireCustomer }: { requireCustomer: boolean },
) {
  const body = await request.text();
  const hmac = request.headers.get('X-Shopify-Hmac-Sha256');

  if (!hmac || !verifyWebhook(body, hmac)) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: CompliancePayload;
  try {
    payload = JSON.parse(body);
  } catch {
    console.error(`[gdpr] ${topic}: corpo non leggibile come JSON`);
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  const shopDomain = payload?.shop_domain;
  const rawCustomerId = payload?.customer?.id;
  const customerId =
    rawCustomerId === undefined || rawCustomerId === null ? null : String(rawCustomerId);

  if (!shopDomain || (requireCustomer && !customerId)) {
    console.error(`[gdpr] ${topic}: payload senza dominio o senza id cliente`);
    return json({ error: 'Invalid payload' }, { status: 400 });
  }

  const rawDataRequestId = payload?.data_request?.id;

  try {
    const { duplicate } = await enqueueComplianceRequest({
      topic,
      shopDomain,
      webhookId: deliveryId(request.headers.get('X-Shopify-Webhook-Id'), topic, shopDomain, body),
      dataRequestId:
        rawDataRequestId === undefined || rawDataRequestId === null
          ? null
          : String(rawDataRequestId),
      customerRef: customerId ? customerRef(shopDomain, customerId) : null,
      payload,
    });

    // Una consegna gia' vista risponde riuscito come la prima. Per Shopify sono
    // la stessa richiesta, e lo sono davvero: dire 500 alla ripetizione
    // significherebbe farsi ritentare all'infinito un lavoro gia' in corso.
    return json({ ok: true, duplicate }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'errore sconosciuto';
    console.error(`[gdpr] ${topic}: presa in carico non riuscita per ${shopDomain}:`, message);
    return json({ error: 'Could not accept request' }, { status: 500 });
  }
}
