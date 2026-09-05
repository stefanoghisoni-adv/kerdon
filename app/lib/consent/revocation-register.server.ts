// app/lib/consent/revocation-register.server.ts
//
// Dove vive una revoca fra il momento in cui la sentiamo e il momento in cui e'
// applicata davvero.
//
// LA REGOLA CHE QUESTO FILE ESISTE PER FAR RISPETTARE. La riga si scrive PRIMA
// che qualcuno dichiari applicata una revoca, e se non si riesce a scriverla
// nessuno la dichiara applicata. Il caso che questo esclude e' preciso e prima
// era possibile: il progetto del merchant non rispondeva, `forgetVisitor`
// scriveva un avviso, la rotta rispondeva 200 e faceva scadere il cookie. Da
// quel momento il legame browser-cliente restava nel database del merchant e
// l'unico riferimento da cui riprovare — l'identificativo dentro il browser —
// non c'era piu'.
//
// IL COOKIE SCADE COMUNQUE, e non e' una contraddizione: il tracciamento locale
// deve cessare nell'istante in cui la persona dice di no, e rimandarle indietro
// il suo identificativo per "non perdere il riferimento" vorrebbe dire
// continuare a riconoscerla dopo che ha revocato. Il riferimento lo tiene
// questo registro, cifrato, che e' il posto giusto per tenerlo. Quello che
// cambia e' la risposta: se la riga non si riesce a scrivere si risponde con un
// segnale di ritentativo, mai con un ok.
//
// COME SI EVITANO I DOPPIONI. Sull'impronta HMAC del soggetto: due revoche
// identiche producono un lavoro solo, e l'identificativo non compare in chiaro
// da nessuna parte. Una revoca gia' conclusa non si riapre — quello che c'era
// da cancellare e' stato cancellato — e una ancora in lavorazione si riusa
// com'e'.
//
// PERCHE' UNA TABELLA E NON UN TIPO NUOVO DELLA CODA: sta scritto per esteso
// sopra il modello in `prisma/schema.prisma`. In due righe: il soggetto va
// tenuto cifrato e cancellato appena serve, e la deduplica dev'essere
// un'impronta — due cose che `sync_requests` non sa fare senza mettere un dato
// personale in chiaro dentro un indice unico.

import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { redactError } from '~/lib/queue/queue-model';
import { createSupabaseClient } from '~/lib/supabase.server';
import { forgetVisitor } from '~/lib/tracking/users.server';
import {
  MAX_REVOCATION_ATTEMPTS,
  REVOCATION_CIPHERTEXT_TTL_MS,
  REVOCATION_COMPLETED_TTL_MS,
  REVOCATION_LEASE_MS,
  failureSummary,
  isRevocationScope,
  nextRevocationAttemptAt,
  statusAfterAttempt,
  type ForgetResult,
  type RevocationOutcome,
  type RevocationScope,
  type RevocationStep,
} from './revocation-model';
import { openSubject, revocationIdempotencyKey, sealSubject } from './revocation-subject.server';

/** Una revoca appena sentita, prima di diventare una riga. */
export interface RevocationRequest {
  shopId: string;
  scope: RevocationScope;
  /** L'identificativo del browser: e' il soggetto, e sta cifrato. */
  externalId: string;
  /** L'id del cliente Shopify, quando la revoca ne nomina uno. */
  shopifyCustomerId?: string | number | null;
}

export interface RecordedRevocation {
  id: string;
  /** Vero se questa revoca era gia' stata presa in carico. */
  duplicate: boolean;
  /** Vero se la riga esistente e' gia' conclusa: non c'e' piu' niente da fare. */
  alreadyDone: boolean;
}

/**
 * Scrive che la revoca e' stata chiesta.
 *
 * Solleva se la scrittura non riesce: chi chiama traduce quel lancio in un
 * segnale di ritentativo per il chiamante. E' l'unico caso in cui il
 * ritentativo cambia qualcosa — la riga non c'e', quindi nessuno applichera'
 * mai quella revoca.
 */
export async function recordRevocation(
  richiesta: RevocationRequest,
): Promise<RecordedRevocation> {
  if (!isRevocationScope(richiesta.scope)) {
    // Uno scopo che nessuno sa lavorare non deve diventare una riga: resterebbe
    // in attesa per sempre. E' il difetto che la coda ha gia' pagato una volta.
    throw new Error(`scopo di revoca non gestito: ${richiesta.scope}`);
  }

  const idempotencyKey = revocationIdempotencyKey({
    shopId: richiesta.shopId,
    scope: richiesta.scope,
    subject: richiesta.externalId,
  });

  try {
    const creata = await prisma.consentRevocation.create({
      data: {
        shopId: richiesta.shopId,
        scope: richiesta.scope,
        idempotencyKey,
        subjectCipher: sealSubject(richiesta.externalId),
        customerCipher:
          richiesta.shopifyCustomerId == null
            ? null
            : sealSubject(String(richiesta.shopifyCustomerId)),
        status: 'queued',
      },
      select: { id: true },
    });
    return { id: creata.id, duplicate: false, alreadyDone: false };
  } catch (error) {
    // Due revoche arrivate insieme: una delle due ha perso la corsa sull'indice
    // unico. Non e' un guasto, e' la deduplica che ha funzionato — si rilegge
    // la riga dell'altra e si va avanti con quella.
    if (!isUniqueViolation(error)) throw error;

    const vincitrice = await prisma.consentRevocation.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true },
    });
    if (!vincitrice) throw error;

    return {
      id: vincitrice.id,
      duplicate: true,
      // Gia' conclusa: la riga NON si riapre. Quello che c'era da cancellare e'
      // stato cancellato, e riaprirla vorrebbe dire rifare un lavoro senza piu'
      // il soggetto — che alla conclusione e' stato tolto di mezzo apposta.
      alreadyDone: vincitrice.status === 'completed',
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

/** Chi sa applicare una revoca. Iniettabile: e' cosi' che si prova. */
export type RevocationRunner = (params: {
  shopId: string;
  scope: RevocationScope;
  externalId: string;
}) => Promise<ForgetResult>;

/**
 * Il processore vero: dal negozio al progetto del merchant, e da li' ai tre
 * gesti della revoca.
 *
 * Un negozio che non c'e' piu' o che non e' collegato non e' un fallimento:
 * non esiste nessun database su cui applicare la revoca, quindi non c'e' niente
 * da cancellare e non c'e' niente da ritentare. Si dichiara saltata, non morta.
 */
export const applyRevocation: RevocationRunner = async ({ shopId, externalId }) => {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { supabaseConfig: true },
  });

  if (!shop?.supabaseConfig) {
    return {
      outcome: 'forgotten',
      steps: [
        { step: 'customer_unlink', outcome: 'skipped', detail: 'progetto non collegato' },
        { step: 'merge_pointers', outcome: 'skipped', detail: 'progetto non collegato' },
        { step: 'user_delete', outcome: 'skipped', detail: 'progetto non collegato' },
      ],
    };
  }

  return forgetVisitor(createSupabaseClient(shop.supabaseConfig), externalId);
};

export type ProcessResult = 'done' | 'retried' | 'dead_letter' | 'skipped';

/**
 * Lavora una revoca presa in carico.
 *
 * Non solleva: un fallimento diventa uno stato sulla riga, perche' e' li' che
 * devono poterlo leggere sia il ritentativo sia chi va a guardare dopo. Chi la
 * chiama — il drenaggio, o la rotta subito dopo la presa in carico — non ha
 * niente da decidere.
 */
export async function processRevocation(
  revocationId: string,
  runner: RevocationRunner = applyRevocation,
  now: Date = new Date(),
): Promise<ProcessResult> {
  const presa = await claim(revocationId, now);
  if (!presa) return 'skipped';

  const { row, lease } = presa;

  const scope = row.scope;
  if (!isRevocationScope(scope)) {
    // Non puo' succedere passando dalla presa in carico, che gli scopi li
    // controlla. Puo' succedere dopo una modifica dell'elenco con righe gia'
    // scritte: in lettera morta, non in attesa per sempre.
    return await concludi(row, lease, 'dead_letter', [], `scopo non gestito: ${scope}`, now);
  }

  const externalId = openSubject(row.subjectCipher);
  if (!externalId) {
    // Senza soggetto non c'e' niente da cancellare e non c'e' niente da
    // ritentare: la chiave e' cambiata, o la ritenzione breve ha gia' portato
    // via il testo cifrato. Riprovare darebbe lo stesso risultato per cinque
    // volte, quindi si smette subito e lo si dice.
    return await concludi(
      row,
      lease,
      'dead_letter',
      [],
      'soggetto cifrato illeggibile: revoca non ripetibile',
      now,
    );
  }

  let esito: RevocationOutcome;
  let steps: RevocationStep[] = [];
  let motivo: string | null = null;

  try {
    const risultato = await runner({ shopId: row.shopId ?? '', scope, externalId });
    steps = risultato.steps;
    esito = risultato.outcome === 'forgotten' ? 'done' : 'retry';
    motivo = failureSummary(steps);
  } catch (error) {
    // Un lancio e' sempre un "riprova": chi vuole fermarsi lo dice restituendo
    // dei passi falliti in modo definitivo, non sollevando. Cosi' un guasto di
    // rete non consuma la stessa strada di un errore di configurazione.
    esito = 'retry';
    motivo = redactError(error);
  }

  return concludi(row, lease, esito, steps, motivo, now);
}

interface ClaimedRow {
  id: string;
  shopId: string | null;
  scope: string;
  subjectCipher: string | null;
  attempts: number;
}

/**
 * La presa, con il suo lease.
 *
 * L'identita' del proprietario e' NUOVA a ogni presa, e questo e' il punto: chi
 * ha perso il possesso — un'invocazione sopravvissuta a un deploy, per dire —
 * si ripresenta con un'identita' che sulla riga non c'e' piu', e le sue
 * scritture toccano zero righe. E' lo stesso effetto del gettone di `queue-model`,
 * ottenuto senza un contatore in piu' da tenere.
 *
 * Due rami nella condizione: la riga in attesa e ormai dovuta, e la riga rimasta
 * 'processing' con il lease scaduto. Senza il secondo, un'invocazione morta a
 * meta' lascerebbe la revoca in quello stato per sempre — cioe' il legame
 * browser-cliente resterebbe li', che e' il guasto di partenza.
 */
async function claim(
  revocationId: string,
  now: Date,
): Promise<{ row: ClaimedRow; lease: string } | null> {
  const lease = randomUUID();

  const presa = await prisma.consentRevocation.updateMany({
    where: {
      id: revocationId,
      OR: [
        { status: 'queued', nextAttemptAt: { lte: now } },
        { status: 'processing', leaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      status: 'processing',
      startedAt: now,
      leaseOwner: lease,
      leaseExpiresAt: new Date(now.getTime() + REVOCATION_LEASE_MS),
      attempts: { increment: 1 },
    },
  });
  if (presa.count === 0) return null;

  const row = await prisma.consentRevocation.findUnique({
    where: { id: revocationId },
    select: { id: true, shopId: true, scope: true, subjectCipher: true, attempts: true },
  });
  return row ? { row, lease } : null;
}

/**
 * Chiude il tentativo, e — se e' andata bene — porta via il soggetto.
 *
 * IL PUNTO PIU' IMPORTANTE DEL FILE: sulla riuscita il testo cifrato si azzera
 * nella stessa scrittura che dichiara conclusa la revoca. Non dopo, non con una
 * potatura: tenere l'identificativo che si e' appena finito di cancellare
 * sarebbe conservare esattamente il dato che la revoca doveva togliere. Quel
 * che resta e' l'impronta HMAC, che e' la prova e non e' un identificativo.
 *
 * Ogni scrittura porta il lease nella `WHERE`. Se non e' piu' il nostro
 * l'aggiornamento tocca zero righe, e la revoca la sta lavorando qualcun altro:
 * si esce senza fare niente. E' quello che impedisce a un processo sopravvissuto
 * a un deploy di dichiarare applicata una revoca che sta applicando un altro.
 */
async function concludi(
  row: ClaimedRow,
  lease: string,
  outcome: RevocationOutcome,
  steps: RevocationStep[],
  motivo: string | null,
  now: Date,
): Promise<ProcessResult> {
  const stato = statusAfterAttempt(outcome, row.attempts);
  const riuscita = stato === 'completed';

  const scritta = await prisma.consentRevocation.updateMany({
    where: { id: row.id, leaseOwner: lease, status: 'processing' },
    data: {
      status: stato,
      completedAt: riuscita ? now : null,
      nextAttemptAt: stato === 'queued' ? nextRevocationAttemptAt(row.attempts, now) : now,
      steps: steps.length > 0 ? (steps as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      lastError: motivo ? motivo.slice(0, 500) : null,
      // Il lease si rilascia comunque: chi ha finito non tiene in mano niente.
      leaseOwner: null,
      leaseExpiresAt: null,
      ...(riuscita
        ? { subjectCipher: null, customerCipher: null, subjectPurgedAt: now }
        : {}),
    },
  });

  // Zero righe: il lease non era piu' nostro. Non si scrive niente e non si
  // segnala niente — la revoca e' in mano a qualcun altro, e due allarmi per lo
  // stesso lavoro sono peggio di nessuno.
  if (scritta.count === 0) return 'skipped';

  if (stato === 'dead_letter') {
    segnala(row, motivo ?? 'nessun dettaglio');
    return 'dead_letter';
  }

  return riuscita ? 'done' : 'retried';
}

/**
 * L'allarme.
 *
 * NESSUN DATO PERSONALE, e qui la regola pesa piu' che altrove: la riga che
 * segnala una revoca non applicata non puo' contenere proprio l'identificativo
 * che la revoca doveva far sparire. Escono l'id della riga, il negozio, i
 * tentativi e il motivo gia' redatto — che nomina i passi falliti, non il
 * soggetto.
 */
function segnala(row: ClaimedRow, motivo: string): void {
  console.error(
    `[revoche] ALLARME revoca ${row.scope} del negozio ${row.shopId ?? 'sconosciuto'} ferma ` +
      `dopo ${row.attempts} tentativi (id ${row.id}): ${motivo}. ` +
      `npm run consent:replay -- ${row.id}`,
  );
}

/** Quante revoche si lavorano in un solo giro. */
const DRAIN_BATCH = 50;

export interface RevocationDrainResult {
  processed: number;
  retried: number;
  deadLettered: number;
}

/**
 * Il drenaggio: quel che era stato preso in carico e non e' ancora applicato.
 *
 * Legge le righe, non la coda, ed e' questo a renderlo l'unica strada che
 * funziona anche quando il primo tentativo sincrono non e' mai avvenuto — la
 * funzione morta un istante dopo la presa in carico, il deploy a meta'. Con il
 * tentativo sincrono non si pestano i piedi perche' la presa e' la stessa.
 */
export async function drainRevocations(
  runner: RevocationRunner = applyRevocation,
  now: Date = new Date(),
  limit: number = DRAIN_BATCH,
): Promise<RevocationDrainResult> {
  const pronte = await prisma.consentRevocation.findMany({
    where: {
      OR: [
        { status: 'queued', nextAttemptAt: { lte: now } },
        { status: 'processing', leaseExpiresAt: { lt: now } },
      ],
    },
    orderBy: { requestedAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  const esito: RevocationDrainResult = { processed: 0, retried: 0, deadLettered: 0 };

  for (const riga of pronte) {
    const risultato = await processRevocation(riga.id, runner, now);
    if (risultato === 'done') esito.processed++;
    else if (risultato === 'retried') esito.retried++;
    else if (risultato === 'dead_letter') esito.deadLettered++;
  }

  return esito;
}

export interface RevocationPruneResult {
  /** Righe concluse da un pezzo, tolte di mezzo. */
  pruned: number;
  /** Abbandonate a cui e' scaduta la ritenzione breve del testo cifrato. */
  subjectsPurged: number;
}

/**
 * Le due pulizie del registro.
 *
 * La prima toglie le concluse da oltre una settimana. Le morte restano: sono
 * l'unica traccia di una revoca che non e' stata applicata, e cancellarle
 * vorrebbe dire far sparire il problema invece di risolverlo.
 *
 * La seconda porta via il testo cifrato dalle morte piu' vecchie della
 * ritenzione breve. Sulle riuscite non serve — li' il soggetto sparisce
 * nell'istante del completamento — ma su una lettera morta il soggetto e'
 * l'unica cosa da cui il replay puo' ripartire, e va tenuto: non per sempre
 * pero'. Dopo trenta giorni nessuno ci sta piu' lavorando, e quel che resta e'
 * la sola prova HMAC.
 */
export async function pruneRevocations(now: Date = new Date()): Promise<RevocationPruneResult> {
  const potate = await prisma.consentRevocation.deleteMany({
    where: {
      status: 'completed',
      completedAt: { lt: new Date(now.getTime() - REVOCATION_COMPLETED_TTL_MS) },
    },
  });

  const scadute = await prisma.consentRevocation.updateMany({
    where: {
      status: 'dead_letter',
      subjectCipher: { not: null },
      updatedAt: { lt: new Date(now.getTime() - REVOCATION_CIPHERTEXT_TTL_MS) },
    },
    data: { subjectCipher: null, customerCipher: null, subjectPurgedAt: now },
  });

  return { pruned: potate.count, subjectsPurged: scadute.count };
}

/**
 * Le revoche ferme in lettera morta.
 *
 * Serve al comando di replay e a chi va a guardare dopo un allarme: e' l'elenco
 * delle persone che hanno chiesto di non essere piu' riconosciute e a cui non
 * abbiamo ancora dato seguito. Non contiene il soggetto — quello sta cifrato e
 * non esce da qui.
 */
export async function listDeadRevocations(limit = 50) {
  return prisma.consentRevocation.findMany({
    where: { status: 'dead_letter' },
    orderBy: { requestedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      shopId: true,
      scope: true,
      attempts: true,
      lastError: true,
      requestedAt: true,
      subjectPurgedAt: true,
    },
  });
}

/**
 * Rimette in lavorazione quel che era stato abbandonato.
 *
 * Azzera i tentativi di proposito: la lettera morta si ripiglia dopo aver
 * aggiustato la causa, e ripartire con il contatore gia' pieno vorrebbe dire un
 * solo tentativo prima di tornare dov'era.
 *
 * Solo quelle che hanno ancora il soggetto: una revoca a cui la ritenzione
 * breve ha gia' portato via il testo cifrato non e' ripetibile, e rimetterla in
 * lavorazione servirebbe solo a farle consumare altri cinque tentativi per
 * tornare esattamente dov'era.
 */
export async function replayDeadRevocations(
  ids?: string[],
  now: Date = new Date(),
): Promise<number> {
  const esito = await prisma.consentRevocation.updateMany({
    where: {
      status: 'dead_letter',
      subjectCipher: { not: null },
      ...(ids && ids.length > 0 ? { id: { in: ids } } : {}),
    },
    data: {
      status: 'queued',
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });
  return esito.count;
}

/** Quanti tentativi ha una revoca prima di essere abbandonata. Per i messaggi. */
export { MAX_REVOCATION_ATTEMPTS };
