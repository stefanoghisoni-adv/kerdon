// app/lib/gdpr/process-compliance.server.ts
//
// La seconda meta' di una richiesta di conformita': quella che fa il lavoro,
// dopo che il webhook ha gia' risposto ricevuto.
//
// Gira dove girano gia' le sincronizzazioni — la coda drenata dal cron —
// perche' una seconda infrastruttura per tre webhook sarebbe una seconda cosa
// da tenere viva, da monitorare e da ricordarsi quando si rompe. La riga su
// Postgres e' pero' la fonte di verita', non l'item di coda: l'item e' una
// sveglia, e una sveglia persa e' un ritardo, mentre una riga persa sarebbe una
// richiesta GDPR mai eseguita.
//
// Per questo `drainComplianceRequests` continua a esistere accanto alla coda e
// non e' un doppione: legge le righe, non la coda, ed e' l'unica strada che
// funziona anche quando l'accodamento non e' mai avvenuto. Le due non si pestano
// i piedi perche' la presa e' la stessa — la condizione sullo stato qui sotto.
//
// COME SI EVITANO I DOPPIONI. Non con un controllo prima, che due invocazioni
// simultanee passerebbero tutte e due, ma con la presa: si aggiorna la riga da
// 'queued'/'failed' a 'processing' con una condizione sullo stato, e chi trova
// zero righe aggiornate se ne va senza fare niente. Da li' in poi l'esecuzione
// e' una sola, e la seconda consegna dello stesso webhook non produce una
// seconda esportazione ne' una cancellazione in corsa con la prima.
//
// COSA SUCCEDE QUANDO VA MALE. La riga torna 'failed' e conta un tentativo:
// il giro dopo la riprende, distanziata. Dopo l'ultimo tentativo diventa
// 'dead_letter' e smette di riprovarci da sola — con una riga nel log che
// comincia per ALLARME, perche' a quel punto la richiesta di una persona vera
// e' ferma e serve qualcuno che la guardi. Restare a ritentare in eterno
// sarebbe peggio: nessuno se ne accorgerebbe.

import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { runWithShopLease } from '~/lib/queue/shop-lock.server';
import type { GdprStep } from './steps';
import { stepsFailed, failureMessage } from './steps';
import {
  collectCustomerData,
  emptyCustomerDataPackage,
  eraseCustomerFromAppDatabase,
  eraseCustomerFromMerchant,
} from './customer-record.server';
import { eraseShopRecord } from './shop-record.server';
import { customerRef, saveGdprOutcome, trySaveGdprOutcome } from './audit.server';
import type { GdprJobType } from './audit.server';

/**
 * Per quanto resta scaricabile un'esportazione.
 *
 * Trenta giorni sono il termine entro cui i dati vanno messi a disposizione del
 * titolare del negozio: la copia vive esattamente quella finestra e poi se ne
 * va. Non e' pignoleria — questa e' una copia in piu' dei dati di una persona,
 * tenuta da noi, e una copia senza scadenza e' una copia per sempre.
 */
export const EXPORT_TTL_DAYS = 30;

/** Quanti tentativi prima di smettere e chiamare qualcuno. */
export const MAX_ATTEMPTS = 5;

/** Quanto si aspetta prima di riprovare una richiesta fallita. */
export const RETRY_DELAY_MS = 5 * 60 * 1000;

/** Quante richieste si lavorano in un solo giro del cron. */
const DRAIN_BATCH = 10;

const JOB_TYPE: Record<string, GdprJobType> = {
  'customers/data_request': 'gdpr_data_request',
  'customers/redact': 'gdpr_redact',
  'shop/redact': 'gdpr_shop_redact',
};

interface Payload {
  shop_domain?: string;
  customer?: { id?: string | number };
}

function customerIdOf(payload: unknown): string | null {
  const id = (payload as Payload)?.customer?.id;
  return id === undefined || id === null ? null : String(id);
}

/**
 * Lavora una richiesta presa in carico.
 *
 * Non solleva: un fallimento diventa uno stato sulla riga, perche' e' li' che
 * deve poterlo leggere sia il ritentativo sia chi va a guardare. Chi la chiama
 * — il drenaggio del cron — non ha niente da decidere.
 */
export async function processComplianceRequest(
  requestId: string,
  now: Date = new Date(),
): Promise<'done' | 'failed' | 'skipped'> {
  // La presa. La condizione sullo stato e' quello che rende innocua la
  // consegna doppia: chi arriva secondo aggiorna zero righe e se ne va.
  const claimed = await prisma.complianceRequest.updateMany({
    where: { id: requestId, status: { in: ['queued', 'failed'] } },
    data: { status: 'processing', startedAt: now, attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return 'skipped';

  const request = await prisma.complianceRequest.findUnique({ where: { id: requestId } });
  if (!request) return 'skipped';

  const shopDomain = request.shopDomain;
  const jobType = JOB_TYPE[request.topic];

  try {
    const outcome = await runTopic(request, now);

    if (stepsFailed(outcome.steps)) {
      // Stesso ragionamento del `catch` in fondo: si sta registrando un
      // fallimento gia' deciso, e la richiesta resta ritentabile comunque.
      await trySaveGdprOutcome(outcome.shopId, {
        jobType,
        shopDomain,
        ref: request.customerRef ?? undefined,
        steps: outcome.steps,
      });
      await giveUpOrRetry(request.id, request.attempts + 1, failureMessage(outcome.steps), shopDomain, request.topic);
      return 'failed';
    }

    await saveGdprOutcome(outcome.shopId, {
      jobType,
      shopDomain,
      ref: request.customerRef ?? undefined,
      steps: outcome.steps,
    });

    if (outcome.removeRow) {
      // shop/redact riuscita: del negozio non deve restare niente, e questa
      // riga porta il suo dominio in chiaro — quindi se ne va anche lei.
      //
      // SI PUO' FARE SOLO PERCHE' LA PROVA E' GIA' SCRITTA. `eraseShopRecord`
      // la scrive dentro la stessa transazione che cancella il negozio, e se
      // non fosse riuscita non saremmo qui: `outcome.steps` direbbe fallito e
      // la richiesta sarebbe tornata ritentabile senza toccare questa riga.
      // Quel che resta e' la prova minimizzata — impronta del negozio,
      // conteggi, istante — e nient'altro.
      await prisma.complianceRequest.deleteMany({ where: { shopDomain } });
      return 'done';
    }

    await prisma.complianceRequest.update({
      where: { id: request.id },
      data: {
        status: 'completed',
        completedAt: now,
        shopId: outcome.shopId,
        lastError: null,
        // Il payload ha finito il suo lavoro: dentro c'e' l'id della persona, e
        // una richiesta chiusa non ha piu' ragione di conservarlo.
        //
        // `Prisma.DbNull` e non `undefined`: su un campo Json `undefined`
        // significa "non toccare", quindi la riga sarebbe rimasta li' con
        // dentro l'id — proprio la cosa che questa riga dichiara di togliere.
        payload: Prisma.DbNull,
        ...(outcome.export
          ? {
              export: outcome.export as never,
              exportExpiresAt: new Date(now.getTime() + EXPORT_TTL_DAYS * 86_400_000),
            }
          : {}),
      },
    });
    return 'done';
  } catch (error) {
    const message = error instanceof Error ? error.message : 'errore sconosciuto';
    console.error(`[gdpr] ${request.topic} non riuscita per ${shopDomain}:`, message);
    // `trySave` e non `save`: si sta gia' registrando un fallimento, e una
    // traccia che non si riesce a scrivere non deve coprire l'errore vero con
    // un secondo errore. La richiesta torna comunque ritentabile qui sotto, che
    // e' l'effetto che il lancio avrebbe avuto.
    await trySaveGdprOutcome(request.shopId, {
      jobType,
      shopDomain,
      ref: request.customerRef ?? undefined,
      steps: [{ table: 'richiesta', outcome: 'failed', rows: 0, detail: message }],
    });
    await giveUpOrRetry(request.id, request.attempts + 1, message, shopDomain, request.topic);
    return 'failed';
  }
}

interface TopicOutcome {
  steps: GdprStep[];
  shopId: string | null;
  /** L'esportazione pronta, per le sole richieste di accesso. */
  export?: unknown;
  /** Vero quando la riga stessa non deve sopravvivere alla richiesta. */
  removeRow?: boolean;
}

async function runTopic(
  request: {
    id: string;
    webhookId: string;
    topic: string;
    shopDomain: string;
    payload: unknown;
  },
  now: Date,
): Promise<TopicOutcome> {
  if (request.topic === 'shop/redact') {
    // Il lucchetto, la marcatura del ciclo di vita, la transazione e la prova
    // stanno tutti dentro `eraseShopRecord`: qui resta solo la traduzione
    // dell'esito in quel che il processore sa gia' leggere.
    //
    // L'id della consegna arriva fin qui perche' e' la chiave su cui la prova
    // e' idempotente: e' cosi' che la seconda consegna della stessa richiesta
    // trova la prova gia' scritta invece di ripartire da capo su un negozio che
    // non esiste piu'.
    const esito = await eraseShopRecord({
      shopDomain: request.shopDomain,
      webhookId: request.webhookId,
      topic: request.topic,
      now,
    });

    // Su un esito andato male lo `shopId` torna indietro valorizzato, ed e' il
    // punto di tutta la revisione: la transazione annullata ha lasciato la riga
    // `shops` dov'era, quindi il ritentativo — e la traccia di controllo — hanno
    // ancora un negozio a cui legarsi. Prima, a quel punto, non l'avevano piu'.
    if (esito.outcome === 'erased' || esito.outcome === 'already_erased') {
      return { shopId: null, steps: esito.steps, removeRow: true };
    }
    return { shopId: esito.shopId, steps: esito.steps };
  }

  const customerId = customerIdOf(request.payload);
  if (!customerId) {
    // Il payload e' stato validato prima di essere accettato, quindi qui non ci
    // si arriva. Se ci si arriva e' una riga scritta male, e ritentarla per
    // giorni non la aggiusterebbe: si dichiara fallita una volta sola.
    return {
      shopId: null,
      steps: [
        {
          table: 'richiesta',
          outcome: 'failed',
          rows: 0,
          detail: 'payload senza id cliente',
        },
      ],
    };
  }

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: request.shopDomain },
    include: { supabaseConfig: true },
  });

  if (request.topic === 'customers/data_request') {
    return dataRequest(shop, customerId);
  }
  return redactCustomer(shop, customerId, request.shopDomain, now);
}

type ShopWithConfig = Prisma.ShopGetPayload<{ include: { supabaseConfig: true } }> | null;

async function dataRequest(shop: ShopWithConfig, customerId: string): Promise<TopicOutcome> {
  // Nessun negozio, o nessun progetto collegato: non abbiamo mai avuto dove
  // scrivere, quindi non c'e' niente da consegnare. Non e' un errore, ed e' una
  // risposta piena — "di questa persona non teniamo nulla" e' esattamente cio'
  // che il diritto di accesso chiede quando e' vero.
  if (!shop?.supabaseConfig) {
    return {
      shopId: shop?.id ?? null,
      steps: [
        {
          table: 'progetto Supabase del merchant',
          outcome: 'skipped',
          rows: 0,
          detail: 'nessun progetto collegato: nessun dato conservato per questo negozio',
        },
      ],
      export: emptyCustomerDataPackage(),
    };
  }

  const supabase = createSupabaseClient(shop.supabaseConfig);
  const { data, steps } = await collectCustomerData(
    supabase,
    shop.supabaseConfig.tableNameCustomers,
    customerId,
  );

  // Una tabella che non ha risposto vuol dire un'esportazione incompleta, e
  // un'esportazione incompleta messa a disposizione come completa e' peggio di
  // una ritentata: chi la legge crederebbe che il resto non esiste.
  if (stepsFailed(steps)) return { shopId: shop.id, steps };

  return { shopId: shop.id, steps, export: data };
}

async function redactCustomer(
  shop: ShopWithConfig,
  customerId: string,
  shopDomain: string,
  now: Date,
): Promise<TopicOutcome> {
  if (!shop) {
    // Un negozio che non abbiamo mai avuto non ha dati di nessuno.
    return {
      shopId: null,
      steps: [{ table: 'shops', outcome: 'skipped', rows: 0, detail: 'negozio mai registrato' }],
    };
  }

  const steps: GdprStep[] = [];

  const esitoLucchetto = await runWithShopLease(shop.id, async (lease) => {
    // Sotto lo stesso lucchetto della sincronizzazione, e non e' zelo: una
    // corsa avviata un istante prima sta riscrivendo proprio le righe che
    // stiamo togliendo, e riscriverebbe il cliente subito dopo la sua
    // cancellazione. Il lucchetto occupato non e' un errore — si riprova.
    if (shop.supabaseConfig) {
      // E il possesso si verifica un istante prima di cancellare: se il lease
      // e' scaduto mentre leggevamo, un'altra corsa sta gia' riscrivendo quel
      // cliente e la nostra cancellazione arriverebbe fuori tempo.
      await lease.assertHeld();
      const supabase = createSupabaseClient(shop.supabaseConfig);
      steps.push(
        ...(await eraseCustomerFromMerchant(
          supabase,
          shop.supabaseConfig.tableNameCustomers,
          customerId,
        )),
      );
    } else {
      steps.push({
        table: 'progetto Supabase del merchant',
        outcome: 'skipped',
        rows: 0,
        detail: 'nessun progetto collegato: non abbiamo mai scritto dati per questo negozio',
      });
    }

    steps.push(
      ...(await eraseCustomerFromAppDatabase(
        shop.id,
        customerId,
        customerRef(shopDomain, customerId),
      )),
    );
  });

  if (esitoLucchetto !== 'eseguito') {
    return {
      shopId: shop.id,
      steps: [
        {
          table: 'richiesta',
          outcome: 'failed',
          rows: 0,
          detail:
            esitoLucchetto === 'occupato'
              ? 'negozio occupato da una sincronizzazione: si riprova'
              : 'lucchetto del negozio non disponibile: si riprova',
        },
      ],
    };
  }

  void now;
  return { shopId: shop.id, steps };
}

/**
 * Dopo un fallimento: si riprova, oppure si smette e si chiama qualcuno.
 *
 * Smettere e' una decisione, non una resa. Una richiesta che continua a fallire
 * non si aggiusta ritentandola altre mille volte, e finche' resta 'failed'
 * nessuno la guarda: 'dead_letter' e' lo stato che la rende visibile.
 */
async function giveUpOrRetry(
  requestId: string,
  attempts: number,
  message: string,
  shopDomain: string,
  topic: string,
): Promise<void> {
  const exhausted = attempts >= MAX_ATTEMPTS;

  await prisma.complianceRequest.update({
    where: { id: requestId },
    data: { status: exhausted ? 'dead_letter' : 'failed', lastError: message.slice(0, 1000) },
  });

  if (exhausted) {
    console.error(
      `[gdpr] ALLARME richiesta ${topic} ferma dopo ${attempts} tentativi per ${shopDomain}: ${message}`,
    );
  }
}

/**
 * Il giro del cron: prende quello che e' rimasto indietro e lo lavora.
 *
 * Non dipende dalla coda. Se la sveglia non e' mai arrivata — Redis giu' al
 * momento della presa in carico, job perso — la riga e' comunque qui, ed e'
 * questo passaggio che la rende una coda durevole invece di una speranza.
 */
export async function drainComplianceRequests(
  now: Date = new Date(),
  limit: number = DRAIN_BATCH,
): Promise<{ processed: number; failed: number }> {
  const pending = await prisma.complianceRequest.findMany({
    where: {
      OR: [
        { status: 'queued' },
        // Le fallite si riprendono distanziate: riprovare subito rifarebbe lo
        // stesso errore e brucerebbe i tentativi in un giro solo.
        { status: 'failed', startedAt: { lt: new Date(now.getTime() - RETRY_DELAY_MS) } },
        // Una 'processing' molto vecchia e' un'invocazione morta a meta': su
        // una funzione serverless succede, e senza questo la richiesta
        // resterebbe bloccata in quello stato per sempre.
        { status: 'processing', startedAt: { lt: new Date(now.getTime() - STALE_MS) } },
      ],
    },
    orderBy: { receivedAt: 'asc' },
    take: limit,
    select: { id: true, status: true },
  });

  let processed = 0;
  let failed = 0;

  for (const row of pending) {
    // Una 'processing' abbandonata va prima riportata a 'failed', altrimenti la
    // presa non la prende: e' la stessa condizione sullo stato che protegge dai
    // doppioni, e qui deve valere lo stesso.
    if (row.status === 'processing') {
      await prisma.complianceRequest.updateMany({
        where: { id: row.id, status: 'processing' },
        data: { status: 'failed', lastError: 'lavorazione interrotta: ripresa dal cron' },
      });
    }

    const result = await processComplianceRequest(row.id, now);
    if (result === 'done') processed++;
    else if (result === 'failed') failed++;
  }

  return { processed, failed };
}

/** Oltre quanto una 'processing' e' da considerare abbandonata. */
const STALE_MS = 15 * 60 * 1000;

/**
 * Toglie le esportazioni scadute.
 *
 * Non e' pulizia, e' la seconda meta' della decisione di tenerle: si conserva
 * una copia dei dati di una persona per il tempo che serve a consegnarla, e
 * quel tempo finisce.
 */
export async function pruneExpiredExports(now: Date = new Date()): Promise<number> {
  // `Prisma.DbNull` di nuovo, e per la stessa ragione di sopra: `undefined` su
  // un campo Json vuol dire "lascia stare", e questa funzione sarebbe stata
  // un giro a vuoto che contava righe senza svuotarne nessuna. La condizione
  // guarda solo la scadenza — una riga senza esportazione non ha nemmeno la
  // data, quindi non entra da sola.
  const expired = await prisma.complianceRequest.updateMany({
    where: { exportExpiresAt: { lt: now } },
    data: { export: Prisma.DbNull, exportExpiresAt: null },
  });
  return expired.count;
}
