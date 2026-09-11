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
// simultanee passerebbero tutte e due, ma con la presa: un solo `UPDATE ...
// RETURNING` che porta la riga a 'processing', conta il tentativo, ci scrive
// sopra il proprietario della presa e restituisce quel che serve a lavorarla.
// Chi non riceve nessuna riga se ne va senza fare niente.
//
// PERCHE' UNA ISTRUZIONE SOLA, e prima erano due. La presa incrementava
// `attempts`, poi una lettura separata rileggeva la riga, e chi decideva la
// lettera morta riceveva `attempts + 1`: lo stesso tentativo logico veniva
// contato due volte, e la richiesta di una persona vera si fermava al quarto
// tentativo dichiarando di averne fatti cinque. Adesso il numero del tentativo
// esiste in un posto solo — e' il valore che `RETURNING` riporta indietro — e
// viene passato una volta sola a chi decide. Il tentativo numero MAX_ATTEMPTS
// e' l'ultimo davvero eseguito.
//
// IL LEASE, E COSA RIMETTE IN PIEDI. Sulla riga resta scritto chi la sta
// lavorando e fino a quando. Serve a due cose: ogni scrittura finale porta quel
// nome nella `WHERE`, quindi un'invocazione sopravvissuta a un deploy non puo'
// dichiarare conclusa una pratica che sta lavorando qualcun altro; e una riga
// rimasta 'processing' con il lease scaduto torna prendibile da sola, senza che
// nessuno debba prima riportarla a mano a 'failed'. Prima quel ripristino lo
// faceva il cron con una scrittura in piu', quindi non avveniva mai quando la
// sveglia arrivava dalla coda invece che dal cron.
//
// COSA SUCCEDE QUANDO VA MALE. La riga torna 'failed' e il prossimo tentativo
// si distanzia, esponenziale e con jitter: riprovare subito rifarebbe lo stesso
// errore e brucerebbe i cinque tentativi in un giro solo. Dopo l'ultimo diventa
// 'dead_letter' e smette di riprovarci da sola — con una riga nel log che
// comincia per ALLARME, perche' a quel punto la richiesta di una persona vera
// e' ferma e serve qualcuno che la guardi. Restare a ritentare in eterno
// sarebbe peggio: nessuno se ne accorgerebbe.

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import { runWithShopLease } from '~/lib/queue/shop-lock.server';
import type { GdprStep } from './steps';
import { stepsFailed, failureMessage } from './steps';
import {
  emptyCustomerDataPackage,
  eraseCustomerFromAppDatabase,
  eraseCustomerFromMerchant,
} from './customer-record.server';
import {
  collectSubjectData,
  materializeSubject,
  type SubjectMaterialization,
} from './subject-snapshot.server';
import {
  COMPLIANCE_LEASE_MS,
  nextComplianceAttemptAt,
  statusAfterFailure,
} from './compliance-model';
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

/**
 * Quanti tentativi prima di smettere e chiamare qualcuno.
 *
 * Riesportato da `compliance-model`, dove sta insieme alla regola che lo rende
 * leggibile: il tentativo numero MAX_ATTEMPTS e' l'ultimo che viene eseguito.
 */
export { MAX_ATTEMPTS } from './compliance-model';

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

/** La richiesta come la restituisce la presa, con quel che serve a lavorarla. */
interface ClaimedRequest {
  id: string;
  webhookId: string;
  topic: string;
  shopDomain: string;
  shopId: string | null;
  customerRef: string | null;
  payload: unknown;
}

interface Claim {
  request: ClaimedRequest;
  /** Chi ha in mano la richiesta: va in ogni scrittura finale. */
  lease: string;
  /** Il tentativo in corso, da 1 a MAX_ATTEMPTS. Definito qui e basta. */
  attemptNumber: number;
}

/** Le colonne come si chiamano nel database, che e' come tornano da RETURNING. */
interface ClaimedRow {
  id: string;
  webhook_id: string;
  topic: string;
  shop_domain: string;
  shop_id: string | null;
  customer_ref: string | null;
  payload: Prisma.JsonValue;
  attempts: number;
}

/**
 * La presa: una istruzione sola, che aggiorna e restituisce.
 *
 * Perche' `RETURNING` e non un aggiornamento seguito da una lettura: il numero
 * del tentativo lo deve dire il database, nello stesso istante in cui lo
 * incrementa. Rileggerlo dopo era il modo in cui lo stesso tentativo finiva per
 * essere contato due volte.
 *
 * Tre rami nella condizione:
 *
 *   - 'queued' o 'failed' con l'attesa scaduta: il caso normale, e il primo
 *     tentativo ha l'attesa gia' scaduta perche' nasce con l'istante di adesso;
 *   - 'processing' con il lease scaduto: un'invocazione morta a meta'. Senza
 *     questo ramo la richiesta resterebbe in quello stato per sempre;
 *   - 'processing' senza nessun lease: le righe rimaste in lavorazione da
 *     prima che il lease esistesse. Su `NULL` un confronto non e' falso, e'
 *     nullo — quindi senza dirlo esplicitamente quelle righe non le
 *     riprenderebbe nessuno.
 */
function claimStatement(requestId: string, owner: string, now: Date): Prisma.Sql {
  const scadenza = new Date(now.getTime() + COMPLIANCE_LEASE_MS);

  return Prisma.sql`
    UPDATE "compliance_requests" AS r
    SET "status" = 'processing',
        "lease_owner" = ${owner},
        "lease_expires_at" = ${scadenza},
        "attempts" = r."attempts" + 1,
        "started_at" = ${now}
    WHERE r."id" = ${requestId}
      AND (
            (r."status" IN ('queued', 'failed') AND r."next_attempt_at" <= ${now})
         OR (r."status" = 'processing' AND r."lease_expires_at" <= ${now})
         OR (r."status" = 'processing' AND r."lease_expires_at" IS NULL)
          )
    RETURNING r."id", r."webhook_id", r."topic", r."shop_domain", r."shop_id",
              r."customer_ref", r."payload", r."attempts"
  `;
}

async function claim(requestId: string, now: Date): Promise<Claim | null> {
  // Un'identita' nuova a ogni presa. E' quello che rende innocua l'invocazione
  // che si risveglia dopo aver perso il possesso: si ripresenta con un nome che
  // sulla riga non c'e' piu', e le sue scritture toccano zero righe.
  const owner = `${process.env.VERCEL_DEPLOYMENT_ID ?? 'locale'}:${randomUUID()}`;

  const righe = await prisma.$queryRaw<ClaimedRow[]>(claimStatement(requestId, owner, now));
  const riga = righe[0];
  if (!riga) return null;

  return {
    request: {
      id: riga.id,
      webhookId: riga.webhook_id,
      topic: riga.topic,
      shopDomain: riga.shop_domain,
      shopId: riga.shop_id,
      customerRef: riga.customer_ref,
      payload: riga.payload,
    },
    lease: owner,
    attemptNumber: riga.attempts,
  };
}

/** La condizione che ogni scrittura finale porta con se'. */
function guardia(requestId: string, lease: string) {
  return { id: requestId, leaseOwner: lease, status: 'processing' };
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
  const presa = await claim(requestId, now);
  if (!presa) return 'skipped';

  const { request, lease, attemptNumber } = presa;
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
      return giveUpOrRetry(request, lease, attemptNumber, failureMessage(outcome.steps), now);
    }

    // LA PROVA E' PARTE DELLA RIUSCITA, e sta PRIMA della chiusura apposta.
    // `saveGdprOutcome` solleva se non riesce a scriverla, il lancio finisce nel
    // `catch` qui sotto, e la richiesta torna ritentabile senza essere mai stata
    // dichiarata completata. Una pratica chiusa di cui non e' rimasta nessuna
    // prova, davanti a chi la chiede, non risulta eseguita affatto.
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

    const chiusa = await prisma.complianceRequest.updateMany({
      where: guardia(request.id, lease),
      data: {
        status: 'completed',
        completedAt: now,
        shopId: outcome.shopId,
        lastError: null,
        // Il lease si rilascia insieme allo stato: chi ha finito non tiene in
        // mano niente, e una riga conclusa con addosso un proprietario sarebbe
        // una contraddizione che la presa leggerebbe come lavoro in corso.
        leaseOwner: null,
        leaseExpiresAt: null,
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

    // Zero righe: il lease non era piu' nostro, e la richiesta la sta lavorando
    // qualcun altro. Non si scrive niente e non si dichiara niente.
    if (chiusa.count === 0) return 'skipped';
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
    return giveUpOrRetry(request, lease, attemptNumber, message, now);
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

async function runTopic(request: ClaimedRequest, now: Date): Promise<TopicOutcome> {
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
    return dataRequest(shop, customerId, now);
  }
  return redactCustomer(shop, customerId, request.shopDomain, now);
}

type ShopWithConfig = Prisma.ShopGetPayload<{ include: { supabaseConfig: true } }> | null;

async function dataRequest(
  shop: ShopWithConfig,
  customerId: string,
  now: Date,
): Promise<TopicOutcome> {
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
  const customersTable = shop.supabaseConfig.tableNameCustomers;

  // LA FOTOGRAFIA STA SOTTO IL LUCCHETTO, LO SCARICAMENTO NO.
  //
  // Sotto lucchetto si stabilisce QUALI righe sono della persona, e basta:
  // sono poche letture di sole chiavi, e durano un attimo. Le righe intere si
  // vanno a prendere dopo, a lucchetto gia' mollato, perche' un negozio con
  // molti ordini resterebbe fermo per minuti — niente sincronizzazione, niente
  // webhook lavorati — ogni volta che qualcuno chiede i propri dati.
  let materializzazione: SubjectMaterialization | null = null;

  const esitoLucchetto = await runWithShopLease(shop.id, async (lease) => {
    // Il possesso si verifica un istante prima di leggere: se il lease e'
    // scaduto mentre lo prendevamo, una corsa e' gia' ripartita e la
    // fotografia uscirebbe da sotto le sue scritture.
    await lease.assertHeld();
    materializzazione = await materializeSubject(supabase, customersTable, customerId, now);
  });

  if (esitoLucchetto !== 'eseguito') {
    // Occupato non e' un guasto: e' una sincronizzazione in corso, e la
    // fotografia si rifa' al giro dopo. Quello che NON si fa e' impaginare a
    // meta' — un'esportazione fatta mentre qualcuno scrive mette insieme due
    // istanti e li presenta come uno.
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

  // TypeScript non sa che la richiamata e' stata eseguita davvero: lo sa il
  // valore di ritorno, che abbiamo appena guardato.
  const fotografia = materializzazione as SubjectMaterialization | null;
  if (!fotografia?.snapshot) {
    return { shopId: shop.id, steps: fotografia?.steps ?? [nessunaFotografia()] };
  }

  const { data, steps } = await collectSubjectData(supabase, customersTable, fotografia.snapshot);

  // Una tabella che non ha risposto, o che non contiene piu' le righe
  // fotografate, vuol dire un'esportazione incompleta o incoerente. Messa a
  // disposizione come completa sarebbe peggio di una ritentata: chi la legge
  // crederebbe che il resto non esiste.
  if (stepsFailed(steps)) return { shopId: shop.id, steps };

  return { shopId: shop.id, steps, export: data };
}

function nessunaFotografia(): GdprStep {
  return {
    table: 'richiesta',
    outcome: 'failed',
    rows: 0,
    detail: 'righe della persona non fissate in un istante solo: si riprova',
  };
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
 * `attemptNumber` arriva gia' incrementato dalla presa e non viene toccato:
 * e' il tentativo appena eseguito, e sommargli uno qui — com'era prima —
 * significava dichiarare esauriti i tentativi con uno ancora da fare.
 *
 * Smettere e' una decisione, non una resa. Una richiesta che continua a fallire
 * non si aggiusta ritentandola altre mille volte, e finche' resta 'failed'
 * nessuno la guarda: 'dead_letter' e' lo stato che la rende visibile.
 */
async function giveUpOrRetry(
  request: ClaimedRequest,
  lease: string,
  attemptNumber: number,
  message: string,
  now: Date,
): Promise<'failed' | 'skipped'> {
  const stato = statusAfterFailure(attemptNumber);

  const scritta = await prisma.complianceRequest.updateMany({
    where: guardia(request.id, lease),
    data: {
      status: stato,
      lastError: message.slice(0, 1000),
      // Distanziato, e non a intervallo fisso: cinque tentativi tutti a cinque
      // minuti l'uno dall'altro contro un progetto che non risponde sono
      // cinque modi di fare lo stesso errore in mezz'ora.
      nextAttemptAt: nextComplianceAttemptAt(attemptNumber, now),
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  });

  // Zero righe: il lease non era piu' nostro. Non si scrive niente e non si
  // segnala niente — la richiesta e' in mano a qualcun altro, e due allarmi per
  // lo stesso lavoro sono peggio di nessuno.
  if (scritta.count === 0) return 'skipped';

  if (stato === 'dead_letter') {
    console.error(
      `[gdpr] ALLARME richiesta ${request.topic} ferma dopo ${attemptNumber} tentativi ` +
        `per ${request.shopDomain}: ${message}`,
    );
  }

  return 'failed';
}

/**
 * Il giro del cron: prende quello che e' rimasto indietro e lo lavora.
 *
 * Non dipende dalla coda. Se la sveglia non e' mai arrivata — Redis giu' al
 * momento della presa in carico, job perso — la riga e' comunque qui, ed e'
 * questo passaggio che la rende una coda durevole invece di una speranza.
 *
 * NON RIMETTE PIU' A MANO IN 'failed' cio' che era rimasto 'processing', e non
 * e' una semplificazione: quel ripristino stava qui, quindi avveniva solo se a
 * passare era il cron. Una richiesta svegliata dalla coda su una riga
 * abbandonata trovava la presa chiusa e se ne andava. Adesso e' la presa stessa
 * a riconoscere il lease scaduto, e vale per tutte e due le strade.
 */
export async function drainComplianceRequests(
  now: Date = new Date(),
  limit: number = DRAIN_BATCH,
): Promise<{ processed: number; failed: number }> {
  const pending = await prisma.complianceRequest.findMany({
    where: {
      OR: [
        // Le fallite si riprendono distanziate: l'attesa e' gia' scritta sulla
        // riga, decisa dal backoff al momento del fallimento.
        { status: { in: ['queued', 'failed'] }, nextAttemptAt: { lte: now } },
        // Una lavorazione abbandonata: l'invocazione e' morta a meta' e il
        // lease e' scaduto senza che nessuno lo rilasciasse.
        { status: 'processing', leaseExpiresAt: { lt: now } },
        { status: 'processing', leaseExpiresAt: null },
      ],
    },
    orderBy: { receivedAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  let processed = 0;
  let failed = 0;

  for (const row of pending) {
    const result = await processComplianceRequest(row.id, now);
    if (result === 'done') processed++;
    else if (result === 'failed') failed++;
  }

  return { processed, failed };
}

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
