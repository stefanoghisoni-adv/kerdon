// app/lib/webhooks/trigger.ts
//
// Cosa si conserva di una consegna operativa, e cosa si butta via subito.
//
// LA REGOLA. Il corpo di un webhook e' un INNESCO, non una fonte: dice "questa
// risorsa e' cambiata", non "questa risorsa adesso e' cosi'". Per prodotti,
// clienti e ordini il repository l'aveva gia' stabilito ognuno per conto suo —
// il payload si buttava e la risorsa si rileggeva da Shopify — ma finche' il
// lavoro stava dentro la richiesta HTTP quella scelta non lasciava traccia da
// nessuna parte. Adesso che fra la ricevuta e l'effetto c'e' una riga durevole,
// la stessa scelta diventa una domanda nuova: cosa ci si scrive dentro.
//
// LA RISPOSTA E' "IL MINIMO INDISPENSABILE", E NON PER RISPARMIARE SPAZIO.
// `webhook_events` sta nel database owner, e la riga sopravvive alla consegna
// per una settimana. Metterci il corpo intero di `customers/update` vorrebbe
// dire tenere per una settimana nome, cognome, email, telefono e indirizzo di
// una persona in un database che quella persona non ha mai visto — e che la
// cancellazione richiesta a Shopify non attraverserebbe, perche' nessuna delle
// due redazioni sa che quella riga esiste. Del cliente si conserva l'id, e il
// resto si rilegge quando serve: se nel frattempo la persona e' stata
// cancellata, la rilettura non trova niente, che e' esattamente il
// comportamento giusto.
//
// LE CANCELLAZIONI SONO L'ECCEZIONE ALLA RILETTURA, NON A QUESTA REGOLA. Una
// risorsa cancellata su Shopify non e' piu' leggibile: se non si conserva
// adesso il suo identificativo, non lo si ritrova mai piu' e quella riga resta
// nel database del merchant per sempre. Ma anche li' si conserva
// l'identificativo e basta, che di dati personali non ne porta.
//
// L'UNICO CAMPO CHE NON SI PUO' RILEGGERE. Negli ordini, l'identificativo del
// browser che ha riempito il carrello viaggia negli attributi di carrello e in
// GraphQL non c'e': la ricevuta e' l'unico posto da cui passa. Si conserva,
// perche' senza il legame fra browser e cliente andrebbe perso a ogni
// ritentativo; e' pseudonimo, vive quanto la riga e non viene mai messo in un
// indice.
//
// Nessun import dal database e nessuna chiamata: queste sono regole di lettura,
// e devono potersi provare senza niente sotto.

import { externalIdFromNoteAttributes } from '~/lib/tracking/users';
import {
  customerIdFromReceipt,
  orderIdFromReceipt,
  type WebhookOrderPayload,
} from '~/lib/customers/order-webhook-payload';
import type { WebhookTopic } from './inbox-model';

/**
 * Le famiglie di lavoro, che sono meno dei topic.
 *
 * `orders/create`, `orders/updated` e `refunds/create` fanno la stessa identica
 * cosa — dicono quale ordine rileggere — e distinguerle nel processore
 * vorrebbe dire tre strade che devono restare uguali. Il topic vero resta sulla
 * riga: serve a capire dopo cos'era arrivato, non a decidere cosa fare.
 */
export type WebhookWorkKind =
  | 'admin'
  | 'product.upsert'
  | 'product.delete'
  | 'customer.upsert'
  | 'customer.delete'
  | 'order.upsert'
  | 'order.delete';

export const WORK_KIND_BY_TOPIC: Record<WebhookTopic, WebhookWorkKind> = {
  'app/uninstalled': 'admin',
  'app_subscriptions/update': 'admin',
  'products/create': 'product.upsert',
  'products/update': 'product.upsert',
  'products/delete': 'product.delete',
  'customers/create': 'customer.upsert',
  'customers/update': 'customer.upsert',
  'customers/delete': 'customer.delete',
  'orders/create': 'order.upsert',
  'orders/updated': 'order.upsert',
  'refunds/create': 'order.upsert',
  'orders/delete': 'order.delete',
};

/** Vero per i topic che parlano di una risorsa del negozio, non del negozio. */
export function isOperationalTopic(topic: WebhookTopic): boolean {
  return WORK_KIND_BY_TOPIC[topic] !== 'admin';
}

/** Quel che resta di una consegna sui prodotti. */
export interface ProductTrigger {
  productId: number;
}

/** Quel che resta di una consegna sui clienti. */
export interface CustomerTrigger {
  customerId: number;
}

/** Quel che resta di una consegna sugli ordini. */
export interface OrderTrigger {
  orderId: number;
  /** A chi legare il browser che ha comprato. `null` per un acquisto ospite. */
  customerId: number | null;
  /** Il browser che ha riempito il carrello, quando il negozio lo pianta. */
  externalId: string | null;
}

/** Gli id REST sono numeri, ma un payload puo' darli come stringa: si accetta. */
function toId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Il corpo ridotto a quel che si conserva.
 *
 * `null` vuol dire "questa consegna non nomina nessuna risorsa": non e' un
 * guasto passeggero e non serve ritentarla, ma la riga si scrive lo stesso e il
 * processore la manda in lettera morta. E' l'unico modo di accorgersi che
 * qualcosa a monte manda buste che non sappiamo leggere — prima si scriveva un
 * avviso nel log e si rispondeva "ricevuto".
 */
export function distillTrigger(topic: WebhookTopic, payload: unknown): unknown {
  const kind = WORK_KIND_BY_TOPIC[topic];

  // Gli amministrativi conservano il corpo intero, e restano com'erano: parlano
  // di un negozio e di un abbonamento, non di una persona, e il processore
  // dell'abbonamento legge del payload molto piu' di un id.
  if (kind === 'admin') return payload ?? {};

  const corpo = asRecord(payload);
  if (!corpo) return null;

  if (kind === 'product.upsert' || kind === 'product.delete') {
    const productId = toId(corpo.id);
    return productId === null ? null : ({ productId } satisfies ProductTrigger);
  }

  if (kind === 'customer.upsert' || kind === 'customer.delete') {
    const customerId = toId(corpo.id);
    return customerId === null ? null : ({ customerId } satisfies CustomerTrigger);
  }

  const ordine = corpo as WebhookOrderPayload;
  const orderId = orderIdFromReceipt(ordine);
  if (orderId === null) return null;

  if (kind === 'order.delete') {
    // Della cancellazione si conserva l'identificativo e nient'altro: legare un
    // browser a un ordine che non esiste piu' non ha nessun senso, e gli
    // attributi del carrello sarebbero un dato tenuto per niente.
    return { orderId, customerId: null, externalId: null } satisfies OrderTrigger;
  }

  return {
    orderId,
    customerId: customerIdFromReceipt(ordine),
    externalId: externalIdFromNoteAttributes(ordine.note_attributes),
  } satisfies OrderTrigger;
}

/**
 * Il trigger riletto dalla riga.
 *
 * Si ricontrolla invece di fidarsi: fra la ricevuta e il ritentativo puo'
 * esserci passato un deploy che ha cambiato la forma, e una riga vecchia non
 * deve poter far scrivere un `undefined` nel database del merchant.
 */
export function readProductTrigger(payload: unknown): ProductTrigger | null {
  const corpo = asRecord(payload);
  const productId = toId(corpo?.productId);
  return productId === null ? null : { productId };
}

export function readCustomerTrigger(payload: unknown): CustomerTrigger | null {
  const corpo = asRecord(payload);
  const customerId = toId(corpo?.customerId);
  return customerId === null ? null : { customerId };
}

export function readOrderTrigger(payload: unknown): OrderTrigger | null {
  const corpo = asRecord(payload);
  const orderId = toId(corpo?.orderId);
  if (orderId === null) return null;
  const externalId = typeof corpo?.externalId === 'string' ? corpo.externalId : null;
  return { orderId, customerId: toId(corpo?.customerId), externalId };
}
