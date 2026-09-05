// app/lib/gdpr/compliance-queue.server.ts
//
// La presa in carico di una richiesta di conformita': si scrive che e'
// arrivata, si sveglia chi la lavorera', si risponde.
//
// PERCHE' NON SI FA TUTTO SUBITO. Shopify non aspetta il lavoro: tratta il 2xx
// come una ricevuta — "l'ho presa" — e taglia la richiesta a cinque secondi.
// L'esportazione dei dati va consegnata al titolare del negozio entro trenta
// giorni, per un canale suo, e non c'entra niente con il corpo di questa
// risposta. Fare le letture prima di rispondere significava quindi due cose
// insieme: rischiare il timeout su un negozio con molti ordini, e credere di
// aver consegnato qualcosa a qualcuno che non lo stava nemmeno leggendo.
//
// COSA CONTA COME "PRESA". La riga su Postgres, e solo quella. Scritta lei, la
// richiesta e' nostra e non si perde nemmeno se l'invocazione muore un istante
// dopo: il cron ripassa e la trova. Se la scrittura non riesce si risponde 5xx,
// cosi' Shopify ritenta — l'unica risposta onesta e' "non l'ho presa".
//
// L'item di coda che si aggiunge subito dopo NON e' la presa: e' la sveglia,
// per non aspettare il giro del cron. Se l'accodamento non riesce si tira
// dritto, e vale la pena dirlo esplicitamente perche' l'istinto e' l'opposto —
// fallire li' vorrebbe dire far ritentare a Shopify una richiesta che abbiamo
// gia' scritto, e cioe' rifiutare una richiesta gia' accettata.

import { createHash } from 'crypto';
import { prisma } from '~/db.server';
import { naturalDedupKey } from '~/lib/queue/queue-model';
import { enqueueSyncRequest } from '~/lib/queue/queue-store.server';

/** I tre webhook obbligatori, con il nome che Shopify da' a ognuno. */
export type ComplianceTopic =
  | 'customers/data_request'
  | 'customers/redact'
  | 'shop/redact';

export interface ComplianceDelivery {
  topic: ComplianceTopic;
  shopDomain: string;
  /** L'id della consegna, gia' risolto da `deliveryId`. */
  webhookId: string;
  /** `data_request.id`, quando il payload ce l'ha. */
  dataRequestId?: string | null;
  /** L'impronta della persona, per le richieste che ne riguardano una. */
  customerRef?: string | null;
  /** Il payload cosi' com'e' arrivato, gia' verificato. */
  payload: unknown;
}

/**
 * L'identita' della consegna.
 *
 * Shopify la dichiara nell'header `X-Shopify-Webhook-Id`, e con quella la
 * deduplica e' esatta. Quando manca — un ritentativo che perde l'header, un
 * ambiente di prova — si ricava dal corpo: consegne identiche danno la stessa
 * impronta, e una richiesta ripetuta continua a essere riconosciuta. Il topic e
 * il negozio ci stanno dentro perche' due topic diversi non sono la stessa
 * richiesta nemmeno con lo stesso corpo.
 */
export function deliveryId(
  header: string | null | undefined,
  topic: ComplianceTopic,
  shopDomain: string,
  body: string,
): string {
  if (header && header.trim().length > 0) return header.trim();
  return createHash('sha256').update(`${topic}:${shopDomain}:${body}`).digest('hex');
}

export interface EnqueueResult {
  id: string;
  /** Vero se questa consegna era gia' stata presa in carico. */
  duplicate: boolean;
}

/**
 * Scrive che la richiesta e' arrivata, e sveglia chi la lavorera'.
 *
 * Solleva se la scrittura non riesce: la rotta traduce quel lancio in un 5xx, e
 * Shopify ritenta. Non solleva mai per la coda.
 */
export async function enqueueComplianceRequest(
  delivery: ComplianceDelivery,
): Promise<EnqueueResult> {
  const existing = await findDuplicate(delivery);
  if (existing) {
    // Gia' presa. Non si tocca niente — nemmeno per "aggiornare" il payload:
    // la prima consegna e' quella in lavorazione, e riscriverle sotto i piedi
    // il corpo mentre lo sta leggendo e' esattamente il conflitto che la
    // deduplica esiste per evitare.
    await wake(existing.id);
    return { id: existing.id, duplicate: true };
  }

  try {
    const created = await prisma.complianceRequest.create({
      data: {
        webhookId: delivery.webhookId,
        dataRequestId: delivery.dataRequestId ?? null,
        topic: delivery.topic,
        shopDomain: delivery.shopDomain,
        customerRef: delivery.customerRef ?? null,
        payload: (delivery.payload ?? {}) as never,
        status: 'queued',
      },
      select: { id: true },
    });
    await wake(created.id);
    return { id: created.id, duplicate: false };
  } catch (error) {
    // Due consegne arrivate insieme: una delle due ha perso la corsa sull'indice
    // unico. Non e' un guasto, e' la deduplica che ha funzionato — si rilegge
    // la riga dell'altra e si risponde ricevuto.
    if (isUniqueViolation(error)) {
      const winner = await findDuplicate(delivery);
      if (winner) return { id: winner.id, duplicate: true };
    }
    throw error;
  }
}

async function findDuplicate(
  delivery: ComplianceDelivery,
): Promise<{ id: string } | null> {
  const byWebhook = await prisma.complianceRequest.findUnique({
    where: { webhookId: delivery.webhookId },
    select: { id: true },
  });
  if (byWebhook) return byWebhook;

  // Il secondo livello: la pratica lato Shopify. Serve quando la stessa
  // richiesta di accesso torna con un id di consegna diverso — la consegna e'
  // nuova, la pratica no, e una seconda esportazione della stessa persona e'
  // una copia in piu' dei suoi dati che nessuno ha chiesto.
  if (!delivery.dataRequestId) return null;
  return prisma.complianceRequest.findFirst({
    where: { shopDomain: delivery.shopDomain, dataRequestId: delivery.dataRequestId },
    select: { id: true },
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

/**
 * La sveglia. Best-effort per costruzione: la richiesta e' gia' scritta, e una
 * coda che non risponde deve al massimo ritardarla fino al giro del cron, mai
 * farla rifiutare.
 */
async function wake(requestId: string): Promise<void> {
  try {
    await enqueueSyncRequest({
      type: 'compliance-request',
      // Nessun negozio: `shop/redact` sta cancellando proprio quello, e legare
      // l'item a una riga che sta per sparire vorrebbe dire perdere il lavoro
      // insieme a lei.
      shopId: null,
      // Solo l'id della riga, mai il payload: quel corpo contiene l'id di una
      // persona. Chi lavora l'item va a rileggersi la riga, e cosi' vede lo
      // stato vero della richiesta invece di una fotografia scattata adesso.
      payload: { requestId },
      // La chiave naturale, senza finestra temporale: la stessa richiesta non
      // deve produrre un secondo item nemmeno a distanza di giorni. E' un terzo
      // livello di deduplica sopra i due che gia' ci sono sulla riga.
      dedupKey: naturalDedupKey('compliance-request', requestId),
    });
  } catch (error) {
    console.warn(
      `[gdpr] richiesta ${requestId} presa in carico ma non annunciata alla coda: ${
        error instanceof Error ? error.message : 'errore sconosciuto'
      }`,
    );
  }
}
