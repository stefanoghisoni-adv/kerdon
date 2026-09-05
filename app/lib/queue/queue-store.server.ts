// app/lib/queue/queue-store.server.ts
//
// La coda su Postgres: accodare, prendere possesso, chiudere.
//
// COS'E' CAMBIATO E PERCHE'. Prima la coda era BullMQ su Redis, ma su Vercel
// Free non gira nessun Worker: il cron chiamava `getJobs('waiting','delayed')`
// e poi i processor, direttamente. Nessuno prendeva possesso di niente, quindi
// due drenaggi simultanei — quello del cron e quello che un gesto manuale
// innesca subito — vedevano lo stesso job e lo lavoravano tutti e due. E su
// eccezione il job veniva RIMOSSO: `attempts` e `backoff`, configurati con
// cura su BullMQ, non li applicava nessuno, e un errore di rete perdeva il
// lavoro per sempre.
//
// LA PRESA. Una sola istruzione SQL, `UPDATE ... WHERE id IN (SELECT ... FOR
// UPDATE SKIP LOCKED)`. Un'istruzione sola e non una transazione a piu' giri
// perche' `DATABASE_URL` punta al pooler di Supabase in transaction mode: li'
// una sessione non e' di nessuno fra una query e l'altra. `SKIP LOCKED` fa il
// resto — due drenaggi che partono insieme non si aspettano a vicenda, si
// dividono il lavoro.
//
// CHI PUO' SCRIVERE. Solo chi possiede il lease, e lo dimostra con il gettone
// (`fencing_token`). Ogni chiusura e ogni riprogrammazione portano
// proprietario e gettone nella WHERE: se non corrispondono l'aggiornamento
// tocca zero righe e chi ha chiamato lo sa. E' questo che impedisce a un
// processo sopravvissuto a un deploy di dichiarare completato un lavoro che nel
// frattempo sta facendo qualcun altro.

import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '~/db.server';
import {
  LEASE_TTL_MS,
  isSyncRequestType,
  redactError,
  type SyncRequestLease,
  type SyncRequestRow,
  type SyncRequestType,
} from './queue-model';

/** Quante richieste si prendono in un solo giro. */
export const CLAIM_BATCH = 10;

/** Per quanto si tengono le richieste concluse prima di toglierle di mezzo. */
export const COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Cosa serve al consumatore per lavorare la coda.
 *
 * E' un'interfaccia e non le funzioni nude perche' il drenaggio va provato: con
 * questa il test gli mette sotto una coda in memoria che rispetta le stesse
 * regole (queue-model), e le prove sulla concorrenza — due drenaggi che
 * partono insieme, un lease che scade a meta' — diventano possibili senza un
 * Postgres acceso.
 */
export interface QueueStore {
  claim(opts: { owner: string; now: Date; limit?: number; shopId?: string | null }): Promise<
    Array<{ row: SyncRequestRow; lease: SyncRequestLease }>
  >;
  complete(lease: SyncRequestLease, now: Date): Promise<boolean>;
  reschedule(lease: SyncRequestLease, nextAttemptAt: Date, error: unknown, now: Date): Promise<boolean>;
  /**
   * Rimette in coda un lavoro che non e' stato nemmeno tentato, restituendo il
   * tentativo che la presa aveva gia' contato.
   *
   * Distinta da `reschedule` perche' la differenza conta: un negozio occupato,
   * un lucchetto irraggiungibile o un'interruzione non sono fallimenti del
   * lavoro. Contandoli come tali, un negozio che riceve due sincronizzazioni
   * ravvicinate manderebbe la seconda in lettera morta in cinque giri senza che
   * nessuno abbia mai provato a eseguirla.
   */
  release(lease: SyncRequestLease, nextAttemptAt: Date, motivo: string): Promise<boolean>;
  deadLetter(lease: SyncRequestLease, error: unknown, now: Date): Promise<boolean>;
  heartbeat(lease: SyncRequestLease, now: Date): Promise<boolean>;
}

interface ClaimedRow {
  id: string;
  shop_id: string | null;
  type: string;
  payload: unknown;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  fencing_token: number;
}

/**
 * L'istruzione che prende possesso di un lotto.
 *
 * Esportata perche' e' l'unico pezzo di questo file che un test non puo'
 * eseguire davvero senza un database, e allora almeno lo si legge: c'e' un
 * test che pretende `FOR UPDATE SKIP LOCKED` e l'incremento del gettone dentro
 * questo testo. Senza quel controllo, toglierli sarebbe una modifica di una
 * riga che nessuna prova nota.
 */
export function claimStatement(opts: {
  owner: string;
  now: Date;
  limit: number;
  shopId: string | null;
}): Prisma.Sql {
  const scadenza = new Date(opts.now.getTime() + LEASE_TTL_MS);

  return Prisma.sql`
    UPDATE "sync_requests" AS r
    SET "status" = 'processing',
        "lease_owner" = ${opts.owner},
        "lease_expires_at" = ${scadenza},
        "fencing_token" = r."fencing_token" + 1,
        "attempts" = r."attempts" + 1,
        "started_at" = ${opts.now},
        "updated_at" = ${opts.now}
    WHERE r."id" IN (
      SELECT c."id"
      FROM "sync_requests" AS c
      WHERE (
              (c."status" = 'queued' AND c."next_attempt_at" <= ${opts.now})
           OR (c."status" = 'processing' AND c."lease_expires_at" <= ${opts.now})
            )
        AND (${opts.shopId}::text IS NULL OR c."shop_id" = ${opts.shopId})
      ORDER BY c."next_attempt_at" ASC
      LIMIT ${opts.limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING r."id", r."shop_id", r."type", r."payload", r."status",
              r."attempts", r."next_attempt_at", r."lease_owner",
              r."lease_expires_at", r."fencing_token"
  `;
}

function toRow(riga: ClaimedRow): SyncRequestRow {
  return {
    id: riga.id,
    shopId: riga.shop_id,
    type: riga.type,
    payload: riga.payload,
    status: riga.status as SyncRequestRow['status'],
    attempts: riga.attempts,
    nextAttemptAt: riga.next_attempt_at,
    leaseOwner: riga.lease_owner,
    leaseExpiresAt: riga.lease_expires_at,
    fencingToken: riga.fencing_token,
  };
}

/** La coda vera, quella su Postgres. */
export const postgresQueueStore: QueueStore = {
  async claim({ owner, now, limit = CLAIM_BATCH, shopId = null }) {
    const righe = await prisma.$queryRaw<ClaimedRow[]>(
      claimStatement({ owner, now, limit, shopId }),
    );

    return righe.map((riga) => ({
      row: toRow(riga),
      lease: { id: riga.id, owner, fencingToken: riga.fencing_token },
    }));
  },

  async complete(lease, now) {
    const esito = await prisma.syncRequest.updateMany({
      where: guardia(lease),
      data: {
        status: 'completed',
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
      },
    });
    return esito.count === 1;
  },

  async reschedule(lease, nextAttemptAt, error, now) {
    const esito = await prisma.syncRequest.updateMany({
      where: guardia(lease),
      data: {
        status: 'queued',
        nextAttemptAt,
        // Si azzerano insieme allo stato: un item 'queued' con addosso un lease
        // e' una contraddizione, e sarebbe anche una riga che la presa
        // riprenderebbe per il ramo sbagliato.
        leaseOwner: null,
        leaseExpiresAt: null,
        startedAt: null,
        lastError: redactError(error),
      },
    });
    void now;
    return esito.count === 1;
  },

  async release(lease, nextAttemptAt, motivo) {
    const esito = await prisma.syncRequest.updateMany({
      where: guardia(lease),
      data: {
        status: 'queued',
        nextAttemptAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        startedAt: null,
        // Il tentativo lo aveva contato la presa: qui non e' stato consumato,
        // e va restituito.
        attempts: { decrement: 1 },
        lastError: motivo,
      },
    });
    return esito.count === 1;
  },

  async deadLetter(lease, error, now) {
    const esito = await prisma.syncRequest.updateMany({
      where: guardia(lease),
      data: {
        status: 'dead_letter',
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: redactError(error),
      },
    });
    return esito.count === 1;
  },

  async heartbeat(lease, now) {
    const esito = await prisma.syncRequest.updateMany({
      // Anche lo stato, oltre alla guardia: un item che nel frattempo qualcuno
      // ha portato in lettera morta non deve tornare vivo per un battito.
      where: { ...guardia(lease), status: 'processing' },
      data: { leaseExpiresAt: new Date(now.getTime() + LEASE_TTL_MS) },
    });
    return esito.count === 1;
  },
};

/**
 * La condizione che rende ogni scrittura di proprieta'.
 *
 * Id, proprietario e gettone insieme. L'id da solo non basterebbe — sarebbe
 * esattamente la coda di prima, dove chiunque poteva chiudere il lavoro di
 * chiunque — e nemmeno id piu' proprietario: la stessa invocazione che riprende
 * un item dopo aver perso il lease si ripresenta con l'identita' giusta e il
 * gettone vecchio.
 */
function guardia(lease: SyncRequestLease) {
  return { id: lease.id, leaseOwner: lease.owner, fencingToken: lease.fencingToken };
}

export interface EnqueueOptions {
  type: SyncRequestType;
  shopId: string | null;
  payload?: Record<string, unknown>;
  /** La chiave di deduplica, gia' calcolata dal chiamante (vedi queue-model). */
  dedupKey: string;
  /** Quando l'item diventa prendibile. Di norma subito. */
  notBefore?: Date;
}

export interface EnqueueResult {
  id: string;
  /** Vero se la stessa richiesta era gia' in coda e non se n'e' aggiunta una seconda. */
  duplicate: boolean;
}

/**
 * Mette un lavoro in coda.
 *
 * Il tipo si controlla QUI, e un tipo sconosciuto non entra: si lancia e si
 * segnala. Prima non era cosi' — l'item entrava, il drenaggio non lo
 * riconosceva e lo saltava, e restava in attesa per sempre senza che nessuno
 * avesse modo di accorgersene. Rifiutarlo al momento dell'accodamento vuol dire
 * che se ne accorge chi lo sta scrivendo, che e' l'unico momento in cui la cosa
 * si aggiusta.
 */
export async function enqueueSyncRequest(opts: EnqueueOptions): Promise<EnqueueResult> {
  if (!isSyncRequestType(opts.type)) {
    console.error(
      `[coda] ALLARME accodamento rifiutato: tipo sconosciuto "${String(opts.type)}"` +
        `${opts.shopId ? ` per il negozio ${opts.shopId}` : ''}`,
    );
    throw new Error(`Tipo di lavoro sconosciuto: ${String(opts.type)}`);
  }

  const id = randomUUID();

  // `skipDuplicates` e non un controllo prima: due richieste arrivate insieme
  // passerebbero tutte e due un controllo, mentre sull'indice unico ne entra
  // una sola. La deduplica e' una proprieta' del database, non una speranza.
  const esito = await prisma.syncRequest.createMany({
    data: [
      {
        id,
        shopId: opts.shopId,
        type: opts.type,
        payload: opts.payload === undefined ? Prisma.DbNull : (opts.payload as Prisma.InputJsonValue),
        dedupKey: opts.dedupKey,
        status: 'queued',
        nextAttemptAt: opts.notBefore ?? new Date(),
      },
    ],
    skipDuplicates: true,
  });

  if (esito.count === 1) return { id, duplicate: false };

  // Ha vinto l'altra: si restituisce la sua, cosi' chi ha chiamato ha comunque
  // un id da nominare nei log.
  const esistente = await prisma.syncRequest.findUnique({
    where: { dedupKey: opts.dedupKey },
    select: { id: true },
  });
  return { id: esistente?.id ?? id, duplicate: true };
}

/**
 * Le richieste ferme in lettera morta.
 *
 * Serve al comando di replay e a chi va a guardare dopo un allarme.
 */
export async function listDeadLetters(limit = 50) {
  return prisma.syncRequest.findMany({
    where: { status: 'dead_letter' },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      shopId: true,
      type: true,
      attempts: true,
      lastError: true,
      updatedAt: true,
    },
  });
}

/**
 * Rimette in coda quel che era stato abbandonato.
 *
 * Azzera i tentativi di proposito: la lettera morta si replica dopo aver
 * aggiustato la causa, e ripartire con il contatore gia' pieno vorrebbe dire
 * un solo tentativo prima di tornare dov'era. Senza `ids` li riprende tutti.
 */
export async function replayDeadLetters(
  ids?: string[],
  now: Date = new Date(),
): Promise<number> {
  const esito = await prisma.syncRequest.updateMany({
    where: { status: 'dead_letter', ...(ids && ids.length > 0 ? { id: { in: ids } } : {}) },
    data: {
      status: 'queued',
      attempts: 0,
      nextAttemptAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: null,
      startedAt: null,
    },
  });
  return esito.count;
}

/**
 * Toglie di mezzo le richieste concluse da un pezzo.
 *
 * Le concluse e basta. Quelle in lettera morta restano: sono l'unica traccia di
 * un lavoro che non e' stato fatto, e cancellarle dopo una settimana vorrebbe
 * dire far sparire il problema invece di risolverlo.
 */
export async function pruneSyncRequests(now: Date = new Date()): Promise<number> {
  const esito = await prisma.syncRequest.deleteMany({
    where: { status: 'completed', completedAt: { lt: new Date(now.getTime() - COMPLETED_TTL_MS) } },
  });
  return esito.count;
}
