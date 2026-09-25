// app/lib/shipping/shipping-method-backfill-enqueue.server.ts
//
// L'accodamento del recupero dell'opzione di spedizione sugli ordini storici.
//
// In un file suo per la stessa ragione di recompute-enqueue.server: lo chiama
// anche l'aggiornamento dello schema del merchant (apply-schema-update.server),
// e il lavoro vero passa per moduli che a loro volta importano quello. Tenendo
// qui solo l'accodamento, nessuno si ritrova a importare se stesso.

import { prisma } from '~/db.server';
import { dedupKeyFor, redactError } from '~/lib/queue/queue-model';
import { enqueueSyncRequest } from '~/lib/queue/queue-store.server';
import { triggerSyncDrain } from '~/lib/queue/trigger.server';

const TIPO = 'shipping-method-backfill' as const;

/**
 * Mette in coda il recupero per un negozio.
 *
 * LA DEDUPLICA. Due livelli. Il primo e' quello di sempre (tipo + negozio +
 * finestra di un minuto, sull'indice unico). Il secondo e' proprio di questo
 * lavoro: se un recupero del negozio e' gia' in coda o in corso, non se ne
 * aggiunge un altro nemmeno a distanza di ore. Quello in corso legge gli
 * ordini ancora senza opzione mentre avanza, quindi copre anche chi e' arrivato
 * dopo; un secondo farebbe solo le stesse domande a Shopify.
 *
 * Il controllo e l'inserimento non sono atomici, ed e' accettabile: nel caso
 * raro di due chiamate simultanee entrano due item, e il secondo trova gli
 * ordini gia' valorizzati (la scrittura tocca solo i NULL) e finisce subito.
 *
 * NON SOLLEVA. Chi chiama ha gia' fatto il suo lavoro (importato le zone,
 * aggiornato lo schema): un guasto della coda non deve farlo sembrare fallito.
 */
export async function enqueueShippingMethodBackfill(shopId: string): Promise<void> {
  try {
    const giaInCorso = await prisma.syncRequest.findFirst({
      where: { shopId, type: TIPO, status: { in: ['queued', 'processing'] } },
      select: { id: true },
    });
    if (giaInCorso) return;

    await enqueueSyncRequest({
      type: TIPO,
      shopId,
      dedupKey: dedupKeyFor(TIPO, shopId, new Date()),
    });
    triggerSyncDrain(shopId);
  } catch (error) {
    console.error(
      `[shipping-method-backfill] ALLARME recupero opzione non accodato per il negozio ${shopId}: ${redactError(error)}`,
    );
  }
}

/**
 * Accoda il seguito di un recupero interrotto per budget, dal suo cursore.
 *
 * SOLLEVA, come la continuazione del ricalcolo: se il seguito non entra in
 * coda, l'item che lo chiede non deve dichiararsi completato. Sollevando, la
 * coda lo ritenta, e gli ordini gia' valorizzati non vengono richiesti di nuovo.
 */
export async function enqueueShippingMethodBackfillContinuation(
  shopId: string,
  jobId: string,
  cursor: string,
): Promise<void> {
  await enqueueSyncRequest({
    type: TIPO,
    shopId,
    payload: { cursor },
    dedupKey: `${TIPO}:${shopId}:continua:${jobId}:${cursor}`,
  });
  triggerSyncDrain(shopId);
}
