// app/lib/shipping/recompute-enqueue.server.ts
//
// L'accodamento del ricalcolo dei costi logistici, separato dal lavoro vero.
//
// Sta in un file suo per una ragione di dipendenze: lo chiama anche il ritorno
// del database dalla pausa (database-pause.server), e il lavoro vero
// (recompute.server) a sua volta usa database-pause.server per accorgersi di
// una pausa. Tenendo qui solo l'accodamento, nessuno dei due importa l'altro.

import { prisma } from '~/db.server';
import { dedupKeyFor, redactError } from '~/lib/queue/queue-model';
import { enqueueSyncRequest } from '~/lib/queue/queue-store.server';
import { triggerSyncDrain } from '~/lib/queue/trigger.server';

/**
 * Quante volte si segue la catena dei ricalcoli gia' partiti.
 *
 * Ogni anello e' un ricalcolo che ha gia' letto le tariffe: la catena cresce
 * di uno solo quando un salvataggio arriva mentre l'ultimo sta lavorando,
 * quindi nella pratica e' lunga uno o due. Il tetto c'e' solo perche' un ciclo
 * senza tetto e' un ciclo che prima o poi non finisce.
 */
const MAX_CATENA = 5;

/**
 * Mette in coda il ricalcolo per un negozio. Da chiamare DOPO aver salvato.
 *
 * LA DEDUPLICA. La stessa delle sincronizzazioni (tipo + negozio + finestra di
 * un minuto): dieci salvataggi di fila fanno un ricalcolo solo. Con una
 * differenza che qui conta: un salvataggio si puo' fondere in un ricalcolo solo
 * se quello non ha ancora letto le tariffe, cioe' se e' ancora 'queued'. Se e'
 * gia' partito (o finito) le ha lette vecchie, e fondersi in lui vorrebbe dire
 * lasciare sugli ordini i costi di prima del salvataggio. Allora se ne accoda
 * uno "dopo di lui", con una chiave legata al suo id: i salvataggi successivi
 * si fondono in quello, finche' non parte a sua volta.
 *
 * SEMPRE DA ZERO. L'item accodato qui non porta cursore: un salvataggio nuovo
 * cambia il costo di tutti gli ordini, anche di quelli che una corsa a tappe
 * aveva gia' riscritto. Il cursore lo porta solo la continuazione, sotto.
 *
 * NON SOLLEVA. Chi chiama ha gia' salvato: far fallire la sua action per un
 * guasto della coda mostrerebbe un errore su un salvataggio riuscito. Il guasto
 * finisce nei log come ALLARME, e il prossimo salvataggio riaccoda.
 */
export async function enqueueLogisticsRecompute(shopId: string): Promise<void> {
  try {
    const base = dedupKeyFor('logistics-recompute', shopId, new Date());
    let chiave = base;
    let accodato = false;

    for (let anello = 0; anello < MAX_CATENA; anello++) {
      const esito = await enqueueSyncRequest({
        type: 'logistics-recompute',
        shopId,
        dedupKey: chiave,
      });
      if (!esito.duplicate) {
        accodato = true;
        break;
      }

      const esistente = await prisma.syncRequest.findUnique({
        where: { dedupKey: chiave },
        select: { id: true, status: true },
      });
      // Ancora da prendere: leggera' le tariffe appena salvate. Basta lui.
      if (!esistente || esistente.status === 'queued') {
        accodato = true;
        break;
      }

      chiave = `${base}:dopo:${esistente.id}`;
    }

    if (!accodato) {
      // Tutti gli anelli sono ricalcoli gia' partiti con le tariffe di prima:
      // questo salvataggio non ha un ricalcolo che lo rifletta. Non dovrebbe
      // succedere mai (servono cinque ricalcoli partiti nello stesso minuto),
      // e proprio per questo va detto forte.
      console.error(
        `[logistics-recompute] ALLARME catena di ricalcoli esaurita per il negozio ${shopId}: ` +
          'nessun ricalcolo accodato per questo salvataggio',
      );
      return;
    }

    triggerSyncDrain(shopId);
  } catch (error) {
    console.error(
      `[logistics-recompute] ALLARME ricalcolo non accodato per il negozio ${shopId}: ${redactError(error)}`,
    );
  }
}

/**
 * Accoda il seguito di un ricalcolo interrotto per budget, dal suo cursore.
 *
 * La chiave e' legata all'item che si interrompe e al cursore, quindi e' unica:
 * non si fonde con i ricalcoli dei salvataggi (che ripartono da zero) e non la
 * deduplica la finestra del minuto. Se un salvataggio arriva nel frattempo, il
 * suo ricalcolo da zero e questa continuazione convivono: la continuazione
 * rilegge le tariffe quando parte, quindi scrive comunque quelle correnti.
 *
 * SOLLEVA, al contrario dell'accodamento dei salvataggi: se il seguito non
 * entra in coda, l'item che lo chiede non deve dichiararsi completato, o la
 * seconda meta' degli ordini resterebbe con i costi vecchi senza che nessuno
 * lo sappia. Sollevando, la coda ritenta l'item.
 */
export async function enqueueLogisticsContinuation(
  shopId: string,
  jobId: string,
  cursor: string,
): Promise<void> {
  await enqueueSyncRequest({
    type: 'logistics-recompute',
    shopId,
    payload: { cursor },
    dedupKey: `logistics-recompute:${shopId}:continua:${jobId}:${cursor}`,
  });
  // Un'invocazione nuova, con il suo budget: quella corrente e' agli sgoccioli.
  triggerSyncDrain(shopId);
}
