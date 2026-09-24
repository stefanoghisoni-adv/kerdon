import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { prisma } from '~/db.server';
import { drainSyncRequests, type DrainResult } from '~/lib/queue/drain.server';
import { pruneSyncRequests } from '~/lib/queue/queue-store.server';
import { pruneExpiredShopLocks } from '~/lib/queue/shop-lock.server';
import { pruneRepairs } from '~/lib/sync/repair-outbox.server';
import {
  enqueueInitialBulkSync,
  enqueuePeriodicSyncCheck,
} from '~/lib/queue/trigger.server';
import { recordEligibilitySnapshotIfMissing } from '~/lib/stats/eligibility-snapshot.server';
import { hasPlanChanged } from '~/components/Dashboard/plan-upgrade';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilitiesWithPlan } from '~/lib/authz/shop-capabilities.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { SYNC_ACTIVE_CONFIG_FILTER } from '~/lib/sync/sync-active';
import { pruneAccessLog } from '~/lib/read-proxy/access-log.server';
import { drainPendingCancellations } from '~/lib/billing/cancel-outbox.server';
import { drainWebhookEvents, pruneWebhookEvents } from '~/lib/webhooks/inbox.server';
import { drainRevocations, pruneRevocations } from '~/lib/consent/revocation-register.server';
import { WEBHOOK_PROCESSORS } from '~/lib/webhooks/processors.server';
import { reconcileShopStates } from '~/lib/webhooks/reconcile.server';
import { runAutoResume } from '~/lib/supabase/auto-resume.server';
import { unauthenticated } from '~/shopify.server';
import { pruneAnonymousUsers } from '~/lib/tracking/users.server';
import { createSupabaseClient } from '~/lib/supabase.server';
import {
  drainComplianceRequests,
  pruneExpiredExports,
} from '~/lib/gdpr/process-compliance.server';

/**
 * Il drenaggio della coda, innescato dal cron.
 *
 * Su Vercel Free non esistono processi long-running: non gira nessun Worker, e
 * questa rotta e' il solo consumatore della coda. Ci arriva un GET con
 * `Authorization: Bearer CRON_SECRET` da:
 * - Vercel Cron (giro giornaliero di sicurezza, vercel.json)
 * - GitHub Actions (ogni 30 minuti, .github/workflows/sync-cron.yml)
 * - l'app stessa, subito dopo un gesto manuale (corsia veloce, `?shopId=`)
 *
 * A ogni giro: (1) si drena quel che e' in coda, (2) si accoda il lavoro
 * periodico dei negozi la cui cadenza e' scaduta, (3) si drena di nuovo, cosi'
 * quel che si e' appena accodato non aspetta il giro dopo. Un negozio che
 * fallisce non ferma gli altri, e nessun fallimento cancella lavoro: l'item
 * torna in coda distanziato.
 *
 * Cosa NON fa piu': leggere i job in attesa da BullMQ e chiamare i processor
 * direttamente. Quel modello non prendeva possesso di niente — due drenaggi
 * simultanei lavoravano lo stesso job — e su eccezione rimuoveva il job, quindi
 * un errore di rete perdeva la sincronizzazione per sempre. Il perche' per
 * esteso sta in docs/architecture/queue-adr.md.
 */
// Distanza minima fra due tentativi di provvedere la tabella clienti quando il
// piano la include ma non risulta ancora creata.
const CUSTOMERS_RETRY_MS = 3_600_000;

/**
 * Somma l'esito di un drenaggio ai conteggi del giro.
 *
 * Serve perche' i drenaggi sono due — prima quel che era gia' in coda, poi quel
 * che il giro stesso ha accodato — e i numeri della risposta devono
 * raccontarli entrambi. Sommare a mano nei due punti era la strada per averne
 * uno aggiornato e l'altro no.
 */
function assorbi(results: Conteggi, drain: DrainResult): void {
  results.drained += drain.completed;
  results.retried += drain.retried;
  results.deadLettered += drain.deadLettered;
  results.skippedLocked += drain.skippedLocked;
  results.lockUnavailable += drain.lockUnavailable;
  results.unknownType += drain.unknownType;
  results.errors.push(...drain.errors);
}

interface Conteggi {
  drained: number;
  retried: number;
  deadLettered: number;
  skippedLocked: number;
  lockUnavailable: number;
  unknownType: number;
  errors: string[];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const authHeader = request.headers.get('Authorization');
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // La corsia veloce: un negozio indicato vuol dire "drena la sua coda e
  // basta". Ci si arriva da un gesto manuale — il pulsante di sincronizzazione,
  // o il recupero dopo un cambio di piano — e in quel momento la potatura del
  // registro e il giro su tutti i negozi sono lavoro che qualcuno sta
  // aspettando senza averlo chiesto. Restano dovuti, e li fa il giro completo,
  // che parte comunque dal cron.
  const onlyShopId = new URL(request.url).searchParams.get('shopId');

  const results = {
    /** Lavori portati a termine. */
    drained: 0,
    /** Falliti e rimessi in coda distanziati: rimandati, non persi. */
    retried: 0,
    /** Falliti troppe volte: fermi, segnalati, replicabili a mano. */
    deadLettered: 0,
    /** Restituiti alla coda perche' quel negozio era gia' in lavorazione. */
    skippedLocked: 0,
    /** Restituiti alla coda perche' il lucchetto non era raggiungibile. */
    lockUnavailable: 0,
    /** Item con un tipo che nessuno sa lavorare: in lettera morta, non in attesa. */
    unknownType: 0,
    /** Lavori periodici accodati in questo giro. */
    queued: 0,
    periodicChecks: 0,
    planCatchUps: 0,
    completedRequestsPruned: 0,
    expiredLocksPruned: 0,
    /**
     * Riparazioni chiuse da piu' di una settimana, tolte di mezzo. Solo le
     * chiuse: quelle in lettera morta restano, perche' sono l'unica traccia di
     * una risorsa del merchant che non e' stata rimessa a posto.
     */
    repairsPruned: 0,
    snapshots: 0,
    accessLogPruned: 0,
    anonymousUsersPruned: 0,
    complianceProcessed: 0,
    complianceFailed: 0,
    /** Abbonamenti sostituiti che si e' finalmente riusciti a chiudere. */
    subscriptionsCancelled: 0,
    /** Webhook ricevuti e finalmente applicati. */
    webhooksProcessed: 0,
    /** Ricevuti, non applicati, da ritentare al giro dopo. */
    webhooksRetried: 0,
    /** Fermi: nessuno ci riprova piu' da solo, e c'e' un allarme nel log. */
    webhooksDeadLettered: 0,
    /**
     * Il drenaggio si e' fermato per tempo scaduto, non perche' aveva finito.
     *
     * Vederlo vero un giro ogni tanto e' normale — un arretrato si smaltisce in
     * piu' passate. Vederlo vero sempre vuol dire che gli eventi arrivano piu'
     * in fretta di quanto li si lavori, ed e' l'unica riga che lo dice.
     */
    webhookDrainBudgetExhausted: false,
    webhookEventsPruned: 0,
    /** Revoche del tracciamento prese in carico e finalmente applicate. */
    revocationsProcessed: 0,
    /** Prese in carico, non applicate, da ritentare al giro dopo. */
    revocationsRetried: 0,
    /** Ferme: nessuno ci riprova piu' da solo, e c'e' un allarme nel log. */
    revocationsDeadLettered: 0,
    revocationsPruned: 0,
    /** Soggetti cifrati tolti alle abbandonate a fine ritenzione. */
    revocationSubjectsPurged: 0,
    /** Negozi a cui si e' chiesto a Shopify come stanno davvero le cose. */
    shopsReconciled: 0,
    /** Disinstallazioni scoperte guardando, perche' l'evento era andato perso. */
    reconciledUninstalls: 0,
    /** Piani retrocessi perche' su Shopify non c'era piu' niente di attivo. */
    reconciledDowngrades: 0,
    /** Abbonamenti attivi su Shopify di cui da noi non risultava niente. */
    reconciledActivations: 0,
    expiredExportsPruned: 0,
    /**
     * I database in pausa che questo giro e' andato a guardare, e quelli che ha
     * riacceso.
     *
     * `autoResumeChecked` conta le domande fatte a Supabase, non i negozi
     * guardati: se cresce insieme al numero dei negozi vuol dire che il filtro
     * non sta filtrando, ed e' l'unica riga che lo direbbe.
     */
    autoResumeChecked: 0,
    autoResumeRestored: 0,
    autoResumeRefused: 0,
    /** La tabella delle scelte non c'e' ancora: la funzione e' spenta per tutti. */
    autoResumeUnavailable: false,
    errors: [] as string[],
  };

  // Potatura del registro accessi. Prima di tutto il resto e fuori dai cicli:
  // e' una sola query, non dipende da nessun negozio, e messa qui gira anche
  // quando la parte di sync si interrompe a meta'.
  if (!onlyShopId) results.accessLogPruned = await pruneAccessLog();

  // Le richieste di conformita' rimaste indietro, e le esportazioni scadute.
  // Fuori dal ciclo dei negozi e prima di tutto il resto: qui sotto ci sono i
  // termini di legge di una persona vera, e non devono dipendere da quanto e'
  // lungo il giro delle sincronizzazioni ne' da come e' andato. Il drenaggio
  // non guarda la coda: legge le righe, ed e' questo a rendere durevole la
  // presa in carico anche quando Redis era giu' nel momento del webhook.
  if (!onlyShopId) {
    try {
      const compliance = await drainComplianceRequests();
      results.complianceProcessed = compliance.processed;
      results.complianceFailed = compliance.failed;
      results.expiredExportsPruned = await pruneExpiredExports();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Cron compliance drain error:', message);
      results.errors.push(`compliance: ${message}`);
    }
  }

  // Gli abbonamenti sostituiti che la callback non e' riuscita a chiudere.
  //
  // La chiusura vive nella callback, ma proprio quando fallisce li' non si
  // conclude niente: qui si riprende quel che era rimasto segnato. Di norma non
  // trova niente e costa una query; quando trova qualcosa, e' un merchant che
  // altrimenti pagherebbe due abbonamenti.
  if (!onlyShopId) {
    try {
      results.subscriptionsCancelled = await drainPendingCancellations(
        async (shopDomain) => (await unauthenticated.admin(shopDomain)).admin,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Cron billing outbox error:', message);
      results.errors.push(`billing outbox: ${message}`);
    }
  }

  // I webhook ricevuti e non ancora applicati.
  //
  // Fuori dal ciclo dei negozi e prima delle sincronizzazioni di proposito: qui
  // dentro ci sono le disinstallazioni e le fini di abbonamento, cioe' proprio i
  // fatti che decidono quali negozi vadano sincronizzati. Lavorarli dopo
  // vorrebbe dire sincronizzare per un giro ancora un negozio che se n'e'
  // andato.
  //
  // Da quando ci passano anche prodotti, clienti e ordini questo non e' piu'
  // un pugno di righe: e' la rete sotto ogni notifica che il negozio manda, e
  // dopo un'interruzione puo' essere un arretrato vero. Per questo il drenaggio
  // ha un tetto al TEMPO oltre che al numero — quel che non entra nel budget
  // resta in attesa e ci ripassa il giro dopo, invece di tenere fermo tutto il
  // resto.
  if (!onlyShopId) {
    try {
      const eventi = await drainWebhookEvents(WEBHOOK_PROCESSORS);
      results.webhooksProcessed = eventi.processed;
      results.webhooksRetried = eventi.retried;
      results.webhooksDeadLettered = eventi.deadLettered;
      results.webhookDrainBudgetExhausted = eventi.budgetExhausted;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Cron webhook inbox error:', message);
      results.errors.push(`webhook inbox: ${message}`);
    }
  }

  // Le revoche del tracciamento prese in carico e non ancora applicate.
  //
  // Prima dei webhook amministrativi e prima delle sincronizzazioni, insieme
  // alle richieste di conformita' e per lo stesso motivo: qui dentro c'e' il no
  // di una persona vera, e non deve dipendere da quanto e' lungo il giro delle
  // sincronizzazioni ne' da come e' andato. Di norma non trova niente — il
  // primo tentativo e' sincrono, dentro la richiesta del visitatore — e quando
  // trova qualcosa e' una revoca che nessun'altra strada riprenderebbe.
  if (!onlyShopId) {
    try {
      const revoche = await drainRevocations();
      results.revocationsProcessed = revoche.processed;
      results.revocationsRetried = revoche.retried;
      results.revocationsDeadLettered = revoche.deadLettered;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Cron consent revocation drain error:', message);
      results.errors.push(`revoche: ${message}`);
    }
  }

  // Cosa Shopify non ci ha mai detto.
  //
  // Il drenaggio qui sopra ripara gli eventi ricevuti; questo ripara quelli che
  // non sono mai arrivati, perche' Shopify ritenta una consegna per una finestra
  // limitata e oltre quella non torna piu'. Un pugno di negozi per giro, i piu'
  // vecchi per ultimo controllo.
  if (!onlyShopId) {
    try {
      const riconciliati = await reconcileShopStates(
        async (shopDomain) => (await unauthenticated.admin(shopDomain)).admin,
      );
      results.shopsReconciled = riconciliati.checked;
      results.reconciledUninstalls = riconciliati.uninstalled;
      results.reconciledDowngrades = riconciliati.downgraded;
      results.reconciledActivations = riconciliati.aligned;
      results.errors.push(...riconciliati.errors.map((e) => `riconciliazione ${e}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Cron reconcile error:', message);
      results.errors.push(`riconciliazione: ${message}`);
    }
  }

  // I database in pausa che stanno per non essere piu' riaccendibili.
  //
  // DOPO la riconciliazione e non prima, ed e' la stessa ragione per cui i
  // webhook stanno prima delle sincronizzazioni: la riconciliazione e' il
  // momento in cui si scopre chi ha disinstallato senza che l'evento arrivasse.
  // Andando prima, questo giro potrebbe riaccendere il database di un negozio
  // che se n'e' gia' andato — che e' esattamente la cosa da non fare.
  //
  // QUI DENTRO E NON IN UN CRON SUO. Su Vercel i cron sono contati e quelli del
  // piano in uso sono gia' impegnati; ma soprattutto un secondo cron
  // rifarebbe da capo l'elenco dei negozi, l'autenticazione col segreto e la
  // riconciliazione di chi e' ancora installato — cioe' tre cose che questa
  // rotta ha gia' fatto, e che dovrebbero restare d'accordo fra loro per
  // sempre. E c'e' un vantaggio in piu': la stessa rotta la chiama anche
  // GitHub Actions ogni mezz'ora, quindi il controllo non aspetta le 3 del
  // mattino. Che possa girare ogni mezz'ora senza pesare e' garantito dal
  // filtro dentro `runAutoResume` — nessuna chiamata a Supabase per un negozio
  // che da' prova di essere vivo — e dall'attesa di sei ore fra due tentativi.
  if (!onlyShopId) {
    try {
      const riattivazioni = await runAutoResume();
      results.autoResumeChecked = riattivazioni.interrogati;
      results.autoResumeRestored = riattivazioni.riattivati;
      results.autoResumeRefused = riattivazioni.rifiutati;
      results.autoResumeUnavailable = riattivazioni.nonConfigurato;
      results.errors.push(...riattivazioni.errori.map((e) => `riattivazione ${e}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Cron auto-resume error:', message);
      results.errors.push(`riattivazione automatica: ${message}`);
    }
  }

  // 1. Si drena quel che e' in coda: gesti manuali, primi allineamenti,
  //    controlli periodici, richieste di conformita'.
  //
  //    In corsia veloce si guarda solo la coda di quel negozio: gli altri li
  //    prende il giro completo, e intanto chi aspetta non paga il loro tempo.
  assorbi(results, await drainSyncRequests({ shopId: onlyShopId }));

  // 2. Periodic check for shops whose plan interval has elapsed
  //
  // Salta del tutto in corsia veloce: e' la parte che costa, ed e' anche quella
  // che con il gesto appena compiuto non c'entra niente.
  if (onlyShopId) return json({ ok: true, ...results });

  const shops = await prisma.shop.findMany({
    where: {
      uninstalledAt: null,
      supabaseConfig: SYNC_ACTIVE_CONFIG_FILTER,
    },
    include: { supabaseConfig: true },
  });

  for (const shop of shops) {
    // Snapshot giornaliero per il grafico: in un try/catch separato perche' una
    // sua rottura non deve impedire la sync vera e propria del negozio.
    try {
      const result = await recordEligibilitySnapshotIfMissing(shop);
      if (result === 'written') results.snapshots++;
    } catch (error) {
      console.error(`Snapshot idoneita' fallito per ${shop.shopDomain}:`, error);
    }

    // Potatura dei browser mai identificati e fermi da oltre un anno. Vive nel
    // giro del cron perche' e' un lavoro che non ha un momento suo: nessuno
    // aspetta il suo esito, e farla altrove vorrebbe dire farla pagare a
    // qualcuno che sta aspettando un'altra cosa.
    //
    // Il filtro tiene fuori le righe legate a un cliente, qualunque sia la loro
    // eta': quelle sono l'elenco dei dispositivi di una persona che dal negozio
    // ci e' passata davvero, ed e' esattamente cio' per cui la tabella esiste.
    // Le altre non diventeranno mai utili — vedi `pruneAnonymousUsers`.
    //
    // In un try/catch suo, come lo snapshot: un progetto che non risponde non
    // deve impedire la sincronizzazione di quel negozio.
    try {
      if (shop.supabaseConfig) {
        results.anonymousUsersPruned += await pruneAnonymousUsers(
          createSupabaseClient(shop.supabaseConfig),
        );
      }
    } catch (error) {
      console.error(`Potatura dei visitatori anonimi fallita per ${shop.shopDomain}:`, error);
    }

    try {
      const plan = await findPlanByName(shop.currentPlan);
      if (!plan) continue;

      // Le stesse capacita' che i processor useranno fra un istante, decise qui
      // una volta sola. Chiederle prima serve a non svegliare un processor solo
      // perche' rifiuti: la query di sopra tiene gia' fuori i disinstallati e
      // gli scollegati, ma non i sospesi.
      const caps = shopCapabilitiesWithPlan(shop, plan);

      // Il piano e' cambiato dopo l'ultima sync completa: allineamento automatico
      // subito, senza aspettare la cadenza del piano e senza che il merchant
      // debba avviare nulla a mano. E' la corsa completa, non il delta, perche'
      // c'e' da recuperare cio' che il piano precedente non copriva (prodotti
      // oltre il vecchio tetto e, se ora inclusa, l'intera tabella clienti).
      // Al termine il bulk riallinea lastSyncedPlan, quindi non si ripete.
      // La capacita' prima del recupero: senza questo controllo un negozio
      // sospeso finirebbe qui a ogni giro solo per far lanciare il processor e
      // riempire di errori il log.
      if (can(caps, 'sync_products') && hasPlanChanged(shop.currentPlan, shop.lastSyncedPlan)) {
        // Si accoda, non si esegue qui. Prima si eseguiva inline, e un errore a
        // meta' non lasciava niente da riprendere: il giro finiva, il recupero
        // non era avvenuto e nessuna riga lo ricordava. Adesso e' un item con i
        // suoi tentativi, e la deduplica per finestra fa si' che ripassare fra
        // un minuto non ne produca un secondo.
        await enqueueInitialBulkSync(shop.id);
        results.planCatchUps++;
        results.queued++;
        continue;
      }

      // Anche le corse parziali contano come "e' passato di qui": hanno letto
      // Shopify e scritto quasi tutto, e rimetterle in coda un minuto dopo
      // vorrebbe dire rifare il lavoro appena fatto per le poche risorse
      // rimaste indietro — che hanno gia' il loro distanziamento.
      const lastCheck = await prisma.syncJob.findFirst({
        where: {
          shopId: shop.id,
          jobType: 'periodic_check',
          status: { in: ['completed', 'completed_with_repairs'] },
        },
        orderBy: { completedAt: 'desc' },
      });

      const intervalMs = plan.maxSyncFrequencyHours * 3600 * 1000;
      let due =
        !lastCheck?.completedAt ||
        Date.now() - lastCheck.completedAt.getTime() >= intervalMs;

      // Piano con clienti inclusi ma tabella clienti mai provveduta: non si
      // aspetta la cadenza del piano (che sul piano base e' di giorni), si
      // riprova alla prima occasione utile. Il nuovo tentativo e' distanziato di
      // almeno un'ora, cosi' un progetto che continua a rifiutare la creazione
      // non si tira dietro una sync completa a ogni giro del cron.
      if (!due && can(caps, 'sync_customers')) {
        const elapsed = Date.now() - (lastCheck?.completedAt?.getTime() ?? 0);
        if (elapsed >= CUSTOMERS_RETRY_MS) {
          const provisioned = await prisma.syncJob.findFirst({
            where: {
              shopId: shop.id,
              OR: [
                { jobType: { in: ['table_create_customers', 'table_create_both'] } },
                { customersSynced: { gt: 0 } },
              ],
            },
            select: { id: true },
          });
          due = provisioned === null;
        }
      }

      if (due) {
        await enqueuePeriodicSyncCheck(shop.id);
        results.periodicChecks++;
        results.queued++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Cron periodic check error for shop ${shop.shopDomain}:`, error);
      results.errors.push(`shop ${shop.shopDomain}: ${message}`);
      // Si prosegue con il negozio successivo: quel che era da accodare per
      // questo lo riprende il giro dopo.
    }
  }

  // 3. Il secondo drenaggio, per quel che si e' appena accodato.
  //
  // Senza, un controllo periodico dovuto adesso aspetterebbe il giro del cron
  // seguente — fino a mezz'ora — solo perche' e' passato dalla coda invece di
  // essere eseguito sul posto. Con, la coda resta l'unica strada e la latenza
  // non cambia.
  if (results.queued > 0) assorbi(results, await drainSyncRequests());

  // Le pulizie della coda. Ultime di proposito: non le aspetta nessuno, e un
  // loro errore non deve costare il lavoro appena fatto.
  try {
    results.completedRequestsPruned = await pruneSyncRequests();
    results.expiredLocksPruned = await pruneExpiredShopLocks();
    results.repairsPruned = await pruneRepairs();
    results.webhookEventsPruned = await pruneWebhookEvents();
    const revoche = await pruneRevocations();
    results.revocationsPruned = revoche.pruned;
    results.revocationSubjectsPurged = revoche.subjectsPurged;
  } catch (error) {
    results.errors.push(`potatura coda: ${error instanceof Error ? error.message : 'errore'}`);
  }

  return json({ ok: true, ...results });
}
