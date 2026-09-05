// app/lib/webhooks/delivery-id.server.ts
//
// L'identita' di una consegna, decisa in un posto solo.
//
// Shopify la dichiara nell'header `X-Shopify-Webhook-Id`, ed e' con quella che
// la deduplica e' esatta: la stessa consegna ritentata porta lo stesso id.
// Quando l'header manca — un ritentativo che lo perde, un ambiente di prova —
// si ricava dal corpo, cosi' una consegna ripetuta continua a essere
// riconosciuta come tale invece di produrre un secondo effetto.
//
// Topic e negozio entrano nell'impronta perche' due topic diversi non sono la
// stessa consegna nemmeno con lo stesso corpo.
//
// Sta qui, e non dentro una delle due poste in arrivo, perche' la regola deve
// valere identica per tutte: due definizioni della stessa identita' sono il
// modo in cui la deduplica smette di funzionare da un lato solo, in silenzio.

import { createHash } from 'crypto';

export function deliveryId(
  header: string | null | undefined,
  topic: string,
  shopDomain: string,
  body: string,
): string {
  if (header && header.trim().length > 0) return header.trim();
  return createHash('sha256').update(`${topic}:${shopDomain}:${body}`).digest('hex');
}
