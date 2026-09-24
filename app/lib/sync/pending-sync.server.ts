import { prisma } from '~/db.server';
import { PENDING_SYNC_REQUEST_FILTER, type PendingSyncRequest } from './pending-sync';

/**
 * Le richieste di sincronizzazione non ancora concluse per un negozio.
 *
 * Si legge la coda e basta, senza decidere niente: la decisione — quali di
 * queste righe sono davvero in volo adesso — sta in `pending-sync.ts`, che non
 * tocca il database e quindi si puo' provare per intero. Ripetere qui la stessa
 * condizione dentro una `where` piu' furba vorrebbe dire due scritture della
 * stessa regola, e la seconda e' quella che nessuna prova guarda.
 *
 * `take` basso di proposito: in questi due stati le righe di un negozio sono
 * pochissime (la deduplica ne impedisce una per ogni clic, e le concluse
 * escono da qui per definizione). Serve solo a impedire che una coda impazzita
 * si porti dietro la dashboard.
 */
export function pendingSyncRequests(shopId: string): Promise<PendingSyncRequest[]> {
  return prisma.syncRequest.findMany({
    where: { shopId, ...PENDING_SYNC_REQUEST_FILTER },
    select: { status: true, nextAttemptAt: true, leaseExpiresAt: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });
}
