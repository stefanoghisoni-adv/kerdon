import { dictionaryForShop } from '~/lib/i18n/server';
import { useT } from '~/lib/i18n/context';
import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import {
  useLoaderData,
  useFetcher,
  useRevalidator,
  useRouteLoaderData,
  useSearchParams,
} from '@remix-run/react';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Page,
  Box,
  BlockStack,
  InlineGrid,
  InlineStack,
  Button,
  Text,
  Icon,
  Banner,
  SkeletonDisplayText,
  Tooltip,
} from '@shopify/polaris';
import { ProductIcon, PersonIcon, SettingsIcon, LockIcon } from '@shopify/polaris-icons';
import { ProfitCard } from '~/components/Dashboard/ProfitCard';
import { MarginCard } from '~/components/Dashboard/MarginCard';
import { ProfitabilityChart } from '~/components/Dashboard/ProfitabilityChart';
import { TopProductsCard } from '~/components/Dashboard/TopProductsCard';
import { ComparisonSelect, DateRangePicker } from '~/components/Dashboard/DateRangePicker';
import { presetRange, type ComparisonId, type DateRange } from '~/lib/dates/ranges';
import type { Metric } from '~/lib/customers/top-products';
import type { TopProductsReport } from '~/lib/customers/top-products.server';
import type { ShopAverages, ShopProfit } from '~/lib/customers/profit.server';
import { CoverageCard } from '~/components/Dashboard/CoverageCard';
import { CustomersCard } from '~/components/Dashboard/CustomersCard';
import { Stepper, type StepperItem } from '~/components/Dashboard/Stepper';
import { allStepsComplete, resolveStepStates } from '~/components/Dashboard/stepper-state';
import { SupabaseAccountConnect } from '~/components/Dashboard/SupabaseAccountConnect';
import { SupabaseProjectConnect } from '~/components/Dashboard/SupabaseProjectConnect';
import { prisma } from '~/db.server';
import { getOrCreateShop } from '~/utils/shop.server';
import { normalizeAuthorization, isAuthorized } from '~/utils/authorization.server';
import { resolveSyncState } from '~/components/Dashboard/sync-state';
import { enqueueManualSync, triggerSyncDrain } from '~/lib/queue/trigger.server';
import { authenticate } from '~/shopify.server';
import {
  hasPlanChanged,
  planChangeBanner,
  shouldTriggerPlanCatchUp,
} from '~/components/Dashboard/plan-upgrade';
import { firstPlanWithCustomersSync } from '~/components/Dashboard/account-format';
import { normalizePlanName, samePlanName } from '~/lib/billing/plan-name';
import { authorizationBanners } from '~/components/Dashboard/authorization-banners';
import { SchemaUpdateBanner } from '~/components/Dashboard/SchemaUpdateBanner';
import { TrackingConflicts } from '~/components/Dashboard/TrackingConflicts';
import { ProductOverflowBanner } from '~/components/Dashboard/ProductOverflowBanner';
import { suggestPlanForProducts } from '~/components/Dashboard/plan-suggestion';
import type { TrackingFinding } from '~/lib/tracking/detect';
import { needsSchemaUpdate } from '~/lib/supabase/merchant-migrations';
import { triggerMerchantSchemaUpdate } from '~/lib/supabase/apply-schema-update.server';
import {
  refreshShopProfile,
  triggerShopProfileRefresh,
} from '~/lib/shop/refresh-shop-profile.server';
import { useNavLoading } from '~/components/Dashboard/nav-loading';
import { SyncCard } from '~/components/Dashboard/SyncCard';
import { RecentRunsCard } from '~/components/Dashboard/RecentRunsCard';
import { loadSyncRuns, syncTimingFrom } from '~/lib/sync/sync-timing.server';
import { buildPlanCards } from '~/components/Billing/plan-catalog';
import { canAccessPlanTab } from '~/components/Billing/plan-access';
import type { SubscribeResponse } from '~/routes/billing.subscribe';
import type { BillingInterval } from '~/lib/billing/partner-pricing';
import { PlanStep } from '~/components/Dashboard/PlanStep';
import { TrackingCheckStep } from '~/components/Dashboard/TrackingCheckStep';
import { AdvancedSetupCard } from '~/components/Dashboard/AdvancedSetupCard';
import {
  defaultSelection,
  type ServerSideAnswer,
} from '~/components/Dashboard/tracking-platforms';
import { preselectedPlan, recommendedPlan } from '~/components/Dashboard/plan-step';
import { resolveShopPricing } from '~/lib/billing/shop-pricing.server';
import { SETUP_CONTAINER } from '~/components/Dashboard/setup-container';
import { wantedCurrency } from '~/lib/i18n/preferences';
import {
  PreferencesSelect,
  type Preferences,
} from '~/components/Dashboard/PreferencesSelect';
import type { loader as rootLoader } from '~/root';


// Solo per questo store mostriamo il messaggio d'errore reale (utile in debug),
// invece del generico "Errore interno": gli altri merchant non devono vedere
// dettagli tecnici. In produzione Remix maschererebbe altrimenti tutto.
const DEBUG_SHOP_DOMAIN = 'test-negozio-11.myshopify.com';

export async function loader({ request }: LoaderFunctionArgs) {
  let sessionShop: string | undefined;
  try {
    const { session } = await authenticate.admin(request);
    sessionShop = session.shop;

    // Self-heal: crea il record shop se manca (reinstall, cancellazione manuale,
    // race durante l'embedded auth) invece di mandare l'app in 404.
    const shop = await getOrCreateShop(session);

    // Dati che vivono su Shopify e possono cambiare senza dirci nulla: il
    // dominio principale e il fuso orario.
    //
    // Al primo giro si aspetta: il fuso lo consuma subito la tab Logs, e senza
    // le date ricadrebbero su UTC. Dalle volte successive il controllo va in
    // sottofondo (ogni ora al massimo), cosi' l'apertura dell'app non paga una
    // chiamata a Shopify per un dato che cambia una volta ogni tanto.
    // Best effort in entrambi i casi: se Shopify non risponde, la dashboard si
    // carica comunque.
    if (!shop.ianaTimezone) {
      try {
        await refreshShopProfile(shop);
      } catch (err) {
        console.warn(
          '[dashboard loader] lettura dati negozio fallita:',
          err instanceof Error ? err.message : 'errore sconosciuto',
        );
      }
    } else {
      triggerShopProfileRefresh(shop);
    }

    // Piano e job recenti dipendono entrambi solo da `shop`: in parallelo, così
    // il loader costa due round-trip in profondità invece di tre. Su Vercel il
    // DB è remoto, quindi ogni round-trip risparmiato è latenza in meno sul TTFB
    // — che è ciò che domina l'LCP di questa pagina.
    const [plans, recentJobs, customersTableJob, oauthToken, syncRuns, partnerPrices, trackingSetup] = await Promise.all([
      // Tutti i piani, non solo quello in uso: quando i clienti restano fuori
      // serve anche sapere quale piano li rimetterebbe dentro, e leggerli tutti
      // costa come leggerne uno (la tabella e' di poche righe).
      prisma.plan.findMany(),
      prisma.syncJob.findMany({
        where: { shopId: shop.id },
        orderBy: { startedAt: 'desc' },
        take: 10,
      }),
      // La tabella dei clienti risulta gia' provveduta? Vale sia l'evento di
      // creazione sia una sincronizzazione che ci ha davvero scritto dentro (la
      // tabella poteva esistere gia' nel progetto, e in quel caso nessuno ha
      // registrato una creazione).
      prisma.syncJob.findFirst({
        where: {
          shopId: shop.id,
          OR: [
            { jobType: { in: ['table_create_customers', 'table_create_both'] } },
            { customersSynced: { gt: 0 } },
          ],
        },
        select: { id: true },
      }),
      // Accesso a Supabase gia' fatto? E' il primo dei tre passi, e vale anche
      // senza un database scelto: chi chiude l'app a meta' flusso lo ritrova
      // concluso. Del token non serve altro che l'esistenza.
      prisma.supabaseOAuthToken.findUnique({
        where: { shopId: shop.id },
        select: { id: true },
      }),
      // Ultima corsa completata e ultima periodica: da qui escono "Ultima" e
      // "Prossima" della card Sincronizzazione. Non dipendono dal piano, quindi
      // viaggiano con le altre invece di costare un round-trip proprio.
      loadSyncRuns(shop.id),
      // Listino riservato del partner, se il negozio ne ha uno: il terzo passo
      // mostra i prezzi che il merchant paga davvero, non quelli di listino.
      shop.partnerName
        ? prisma.partnerPlanPrice.findMany({ where: { partnerName: shop.partnerName } })
        : Promise.resolve([]),
      prisma.trackingSetup.findUnique({ where: { shopId: shop.id } }),
    ]);

    // La valuta che il merchant si aspetta: la sua scelta, o quella che di
    // solito accompagna la sua lingua.

    // In che valuta parlare a questo negozio, e il listino gia' riscritto in
    // quella valuta. Da qui in giu' nessuno tocca piu' i prezzi: quelli mostrati
    // nelle card e quelli che finiscono in fattura escono dalla stessa lista.
    const pricing = await resolveShopPricing(
      plans.map((p) => ({
        planName: p.planName,
        maxProducts: p.maxProducts,
        maxCustomers: p.maxCustomers,
        maxSyncFrequencyHours: p.maxSyncFrequencyHours,
        customersSyncEnabled: p.customersSyncEnabled,
        supportLevel: p.supportLevel,
      })),
      { preferredCurrency: wantedCurrency(shop), hasReservedPrice: partnerPrices.length > 0 },
    );

    const plan = plans.find((p) => samePlanName(p.planName, shop.currentPlan)) ?? null;

    // Autorizzazione: se il trial (giorni definiti nel piano) è scaduto e il
    // negozio è ancora ENABLED, lo portiamo automaticamente in PENDING (persistente).
    let authorization = normalizeAuthorization(shop.authorization);
    let trackingAuthorization = normalizeAuthorization(shop.trackingAuthorization);
    if (authorization === 'ENABLED' && shop.isInTrial && plan?.trialDays) {
      const trialEnd = shop.installedAt.getTime() + plan.trialDays * 86_400_000;
      if (Date.now() > trialEnd) {
        authorization = 'PENDING';
        // Alla fine della prova si fermano entrambe: e' quello che il periodo di
        // prova concede. Restano comunque due interruttori distinti, e l'owner
        // puo' riaccendere il solo tracciamento senza riaprire l'app.
        trackingAuthorization = 'PENDING';
        await prisma.shop.update({
          where: { id: shop.id },
          data: { authorization: 'PENDING', trackingAuthorization: 'PENDING' },
        });
      }
    }

    const supabaseConnected = !!shop.supabaseConfig?.connectionVerifiedAt;
    // Tabelle del merchant indietro rispetto a cio' che l'app si aspetta: il
    // tentativo parte subito in sottofondo (senza attesa, cosi' la dashboard non
    // rallenta) e il banner resta finche' non e' andato a buon fine.
    const schemaUpdatePending =
      supabaseConnected && needsSchemaUpdate(shop.supabaseConfig?.schemaVersion);
    if (schemaUpdatePending) {
      triggerMerchantSchemaUpdate(shop.id);
    }
    const supabaseAccountConnected = oauthToken !== null;
    const customersEnabled = plan?.customersSyncEnabled ?? false;

    // Stato della sync iniziale/manuale, legato alla connessione CORRENTE
    // (job avviati dopo connectionVerifiedAt): così una riconnessione — anche a
    // un progetto diverso o vuoto — riabilita il pulsante e non eredita lo stato
    // "completato" della connessione precedente. Guida lo stato del pulsante.
    const syncState = resolveSyncState(
      recentJobs,
      shop.supabaseConfig?.connectionVerifiedAt,
    );

    // Piano dell'ultima sync: serve a capire se c'e' altro da sincronizzare e a
    // dire, nel banner, se il tetto prodotti e' salito o sceso.
    const planChanged = hasPlanChanged(shop.currentPlan, shop.lastSyncedPlan);
    // I piani sono gia' tutti in memoria: nessuna seconda interrogazione.
    const previousPlan = planChanged && shop.lastSyncedPlan
      ? plans.find((p) => samePlanName(p.planName, shop.lastSyncedPlan)) ?? null
      : null;

    // Cambio di piano: l'allineamento non lo chiediamo al merchant, parte da solo.
    // Qui non si accoda nulla (la dashboard non deve toccare la coda): si innesca
    // il giro di sincronizzazione, che riconosce da se' il negozio da recuperare.
    // Best effort e senza attesa: se non parte, ci pensa il giro programmato.
    // Anche la sola tabella clienti mancante fa scattare il recupero: dopo un
    // upgrade il piano dell'ultima sync puo' gia' risultare allineato mentre la
    // tabella non e' ancora stata provveduta.
    const customersPending =
      supabaseConnected && customersEnabled && customersTableJob === null;

    if (
      shouldTriggerPlanCatchUp({
        planChanged: planChanged || customersPending,
        syncInProgress: syncState === 'in_progress',
        lastBulkStartedAt:
          recentJobs.find((job) => job.jobType === 'initial_bulk')?.startedAt ?? null,
      })
    ) {
      triggerSyncDrain();
    }

    // Il banner del cambio di piano si mostra finche' c'e' un cambio da
    // annunciare, non una volta sola nella vita del negozio: ogni passaggio di
    // piano ne ha uno suo da comunicare (clienti sbloccati, oppure sync clienti
    // sospesa). La chiusura vale per la sessione, con un minimo di due minuti
    // prima che compaia la X.
    return json({
      shop,
      plan,
      supabaseConnected,
      supabaseAccountConnected,
      customersEnabled,
      syncState,
      authorization,
      trackingAuthorization,
      schemaUpdatePending,
      planChanged,
      currentMaxProducts: plan?.maxProducts ?? null,
      previousMaxProducts: previousPlan?.maxProducts ?? null,
      // Serve a distinguere "clienti sbloccati adesso" da "clienti che c'erano
      // gia'": la sola presenza della tabella non lo dice, perche' resta li'
      // anche dopo un downgrade.
      previousCustomersEnabled: previousPlan?.customersSyncEnabled ?? null,
      // Piano che rimetterebbe i clienti nella sincronizzazione: serve al banner
      // del cambio di piano quando li ha appena persi.
      customersUpgradePlan: customersEnabled
        ? null
        : // Dai piani gia' prezzati: qui il prezzo serve solo a ordinarli, e
          // riprenderlo da `plans` vorrebbe dire una seconda fonte per il
          // listino — quella che questa modifica ha appena tolto.
          firstPlanWithCustomersSync(pricing.plans, shop.currentPlan),
      customersTableCreated: customersTableJob !== null,
      // Il negozio ha gia' scelto un piano almeno una volta? planStartedAt lo
      // scrive l'attivazione, gratuita o a pagamento che sia. Al passo del
      // piano serve a sapere se chiedere una scelta o una conferma.
      planChosen: shop.planStartedAt !== null,
      // Il controllo delle altre fonti di eventi risulta gia' fatto per questo
      // collegamento? La risposta arriva da una richiesta del browser, che
      // riparte da zero a ogni apertura: senza saperlo qui, la configurazione
      // risultava incompleta per i primi secondi e i passi ricomparivano sopra
      // una dashboard gia' pronta.
      // La configurazione e' gia' stata attraversata: da li' in poi la
      // dashboard non rimostra i passi, nemmeno quando qualche dato cambia
      // (un database nuovo, un piano nuovo).
      setupDone: shop.setupCompletedAt != null,
      trackingCheckedForConnection:
        shop.trackingCheckedAt != null &&
        shop.supabaseConfig?.connectionVerifiedAt != null &&
        shop.trackingCheckedAt >= shop.supabaseConfig.connectionVerifiedAt,
      // La conferma vale per il collegamento di adesso? Confermare e' un gesto
      // che riguarda questa configurazione: dopo un ri-collegamento il passo
      // torna a chiederlo, come fa gia' la sincronizzazione.
      planConfirmedForConnection:
        shop.planConfirmedAt != null &&
        shop.supabaseConfig?.connectionVerifiedAt != null &&
        shop.planConfirmedAt >= shop.supabaseConfig.connectionVerifiedAt,
      // Risposta gia' data sull'infrastruttura server side: chiude l'ultimo
      // passo, e ricomparire dopo che si e' risposto sarebbe una domanda a cui
      // il merchant ha gia' risposto.
      serverSideAnswer: trackingSetup?.answer ?? null,
      serverSidePlatforms: trackingSetup?.platforms ?? [],
      // I piani interni assegnati dall'owner non si comprano e non si cambiano:
      // per quei negozi il terzo passo non ha nessuna scelta da proporre.
      planPickable: canAccessPlanTab(shop.currentPlan),
      // Le card del listino come le vede la tab Piano, prezzi riservati
      // compresi: il terzo passo ne fa un elenco a scelta singola.
      // La valuta va al client insieme ai prezzi: e' l'unico modo perche' le
      // card non debbano indovinare come scrivere le cifre che ricevono.
      currency: pricing.currency,
      planCards: buildPlanCards(
        pricing.plans,
        Object.fromEntries(
          partnerPrices.map((p) => [
            p.planName,
            { priceMonthly: Number(p.priceMonthly), priceYearly: Number(p.priceYearly) },
          ]),
        ),
      ),
      discountIntervals: shop.discountIntervals,
      // Cadenza e date della sincronizzazione: la dashboard e' il posto dove il
      // merchant le cerca, e finora stavano solo in Impostazioni.
      sync: {
        frequencyHours: plan?.maxSyncFrequencyHours ?? null,
        ...syncTimingFrom(syncRuns, plan?.maxSyncFrequencyHours ?? null),
      },
      // Le ultime corse, per la card accanto al grafico: quel che serve a
      // scriverne una riga, non il job intero.
      recentRuns: recentJobs.slice(0, 6).map((job) => ({
        id: job.id,
        jobType: job.jobType,
        status: job.status,
        startedAt: job.startedAt.toISOString(),
      })),
      // Listino completo: serve al banner che propone il piano giusto a chi ha
      // piu' prodotti di quanti il suo ne sincronizzi. Sono poche righe e le
      // abbiamo gia' in memoria: passarle costa meno di una seconda richiesta.
      planOptions: pricing.plans.map((p) => ({
        planName: p.planName,
        priceMonthly: p.priceMonthly,
        priceYearly: p.priceYearly,
        maxProducts: p.maxProducts,
        maxCustomers: p.maxCustomers,
        customersSyncEnabled: p.customersSyncEnabled,
      })),
    });
  } catch (err) {
    // Le Response (redirect di auth, 404) devono passare intatte.
    if (err instanceof Response) throw err;
    // Il dettaglio completo va SOLO nei log del server: rilanciare il testo
    // grezzo al browser esporrebbe dettagli interni (info-disclosure). Eccezione:
    // il nostro store di test, per diagnosticare in produzione.
    console.error('[dashboard loader] errore non gestito:', err);
    const isDev = process.env.NODE_ENV !== 'production';
    const showDetail = isDev || sessionShop === DEBUG_SHOP_DOMAIN;
    const detail =
      showDetail && err instanceof Error
        ? `[debug] ${err.message}`
        : "Errore interno del server. Controlla i log dell'app per il dettaglio.";
    throw new Response(detail, { status: 500, statusText: 'Errore dashboard' });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  try {
    const shop = await getOrCreateShop(session);

    // Gate autorizzazione: nessuna azione se il negozio non è ENABLED (ban o
    // trial scaduto). Enforcement server-side: vale anche se l'utente riabilita
    // i pulsanti nell'HTML.
    if (!isAuthorized(shop.authorization)) {
      return json(
        {
          error: (await dictionaryForShop(session.shop)).errors.suspended,
          code: 'not_authorized',
        },
        { status: 403 },
      );
    }

    // Sync in background durabile: mettiamo il job in coda (sopravvive a browser
    // chiuso / timeout) e inneschiamo SUBITO il drain in un'invocazione separata,
    // così la prima sync parte immediatamente senza attendere il cron. Se il
    // trigger fallisce, il cron ogni 30 min drena comunque la coda. Le sync
    // periodiche restano gestite dal cron secondo l'intervallo in Impostazioni.
    await enqueueManualSync(shop.id);
    triggerSyncDrain();

    // La sincronizzazione parte da qui solo per una via: il pulsante "Conferma
    // e sincronizza" del passo del piano. Quindi qui la conferma c'e' stata, e
    // va segnata: confermare il piano che si ha gia' non attiva nessun
    // abbonamento, quindi `planStartedAt` resterebbe vuoto e il passo non si
    // chiuderebbe mai — restava aperto anche a sincronizzazione conclusa, con
    // il passo successivo bloccato dietro di lui.
    await prisma.shop.update({
      where: { id: shop.id },
      data: { planConfirmedAt: new Date() },
    });

    return json({ queued: true });
  } catch (err) {
    // Non far crashare la pagina con "Unexpected Server Error": errore gestito.
    console.error('[dashboard action] sync fallita:', err instanceof Error ? err.message : 'errore sconosciuto');
    // Il messaggio NON deve indicare una causa che non conosciamo. Qui si
    // finisce per qualunque intoppo nell'avvio, e mandare il merchant a
    // controllare il collegamento a Supabase — come diceva prima — gli fa
    // cercare un guasto dove non c'e', mentre quello vero e' dalla nostra parte
    // e lui non puo' farci niente.
    return json(
      {
        error:
          'Non siamo riusciti ad avviare la sincronizzazione. Riprova fra qualche minuto: se continua, scrivici e ce ne occupiamo noi.',
      },
      { status: 502 },
    );
  }
}

interface CountsResponse {
  totalProducts: number;
  customersEnabled: boolean;
  customerCount: number | null;
}

interface ReadinessResponse {
  totalProducts: number;
  // Totale varianti esposto dall'endpoint. La card lo ricalcola comunque come
  // readyCount + problemCount (vero per costruzione): qui il campo completa il
  // contratto dell'API, non e' la fonte usata per il rendering.
  totalVariants: number;
  readyCount: number;
  problemCount: number;
  // true se il risultato arriva dalla cache: il client innesca poi il refresh live.
  cached?: boolean;
}

interface CustomerStatsResponse {
  enabled: boolean;
  totalCustomers: number;
  optIn: number;
  optOut: number;
  cached?: boolean;
}

interface ProductHistoryResponse {
  /** Un punto per giorno del mese corrente; count null = giorno non ancora arrivato. */
  points: { day: number; count: number | null }[];
  monthLabel: string;
  /** Primo giorno del mese mostrato, in ISO. */
  monthStart: string;
  planLimit: number | null;
}

export default function Dashboard() {
  const { shop, plan, supabaseConnected, supabaseAccountConnected, customersEnabled, authorization, syncState, planChanged, currentMaxProducts, previousMaxProducts, previousCustomersEnabled, customersTableCreated, customersUpgradePlan, trackingAuthorization, schemaUpdatePending, planOptions, sync, recentRuns, planChosen, planConfirmedForConnection, trackingCheckedForConnection, setupDone, planCards, discountIntervals, currency, serverSideAnswer, serverSidePlatforms } =
    useLoaderData<typeof loader>();
  const blocked = authorization !== 'ENABLED';
  const t = useT();

  // Altre fonti di eventi gia' attive sul negozio. Si chiede una volta sola: e'
  // un controllo di configurazione, non un dato che cambia mentre il merchant
  // guarda.
  //
  // E si chiede solo a database collegato. Prima di quel momento il controllo
  // e' il terzo passo, e un passo ancora bloccato non deve aver gia' fatto il
  // proprio lavoro: si aprirebbe con l'esito gia' pronto, senza che nessuno
  // abbia visto controllare niente. In piu' sono due chiamate a Shopify —
  // canali e tema — che chi si ferma al primo passo non ha motivo di pagare.
  const conflictsFetcher = useFetcher<{
    findings: TrackingFinding[];
    adminBase?: string;
    themeId?: number | null;
  }>();
  useEffect(() => {
    if (!supabaseConnected) return;
    if (conflictsFetcher.state === 'idle' && !conflictsFetcher.data) {
      conflictsFetcher.load('/api/tracking/conflicts');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabaseConnected]);

  // Pulsante-link Impostazioni: mentre Remix carica la rotta di destinazione
  // mostriamo lo spinner e disabilitiamo il pulsante, così un clic su un DB
  // remoto (Vercel) non sembra "morto". Solo pero' se e' stato quel pulsante a
  // far partire la navigazione: cambiando sezione dal menu laterale dell'admin
  // si accendeva lo stesso, senza che nessuno l'avesse premuto.
  const settingsNav = useNavLoading('/settings/supabase');
  // La pagina dei prodotti non idonei interroga Shopify pagina per pagina:
  // l'attesa si sente, e senza un segnale il merchant clicca due volte.
  const issuesNav = useNavLoading('/products/issues');

  // Stato del collegamento Supabase per il badge del primo step: Non collegato
  // (grigio) → In corso (arancione) → Fallito (rosso) / Collegato (verde).
  const [connectStatus, setConnectStatus] = useState<'idle' | 'in_progress' | 'failed'>('idle');
  // Esito dell'ultima disconnessione. Vive qui e non dentro SupabaseProjectConnect
  // perche' quel componente viene rimontato appena il collegamento cade: il
  // banner sparirebbe nello stesso istante in cui deve comparire.
  const [disconnectDone, setDisconnectDone] = useState<'delete' | 'keep' | null>(null);
  // Ricollegato qualcosa, l'esito della disconnessione precedente non parla piu'
  // di niente: "Tabelle e dati eliminati" sopra un account appena collegato
  // racconta una storia finita, e per giunta allarmante. Sparisce da solo,
  // senza aspettare la "x".
  useEffect(() => {
    if (supabaseAccountConnected || supabaseConnected) setDisconnectDone(null);
  }, [supabaseAccountConnected, supabaseConnected]);
  // Badge del primo passo. "Collegato" lo decide il server (l'accesso risulta
  // fatto); gli stati intermedi li conosce solo il componente, che li riporta.
  const connectBadge = supabaseAccountConnected || supabaseConnected
    ? { tone: 'success' as const, label: t.steps.connectAccount.complete }
    : connectStatus === 'failed'
      ? { tone: 'critical' as const, label: t.steps.connectAccount.failed }
      : connectStatus === 'in_progress'
        ? { tone: 'warning' as const, label: t.steps.connectAccount.inProgress }
        : { tone: undefined, label: t.steps.connectAccount.notConnected };

  // Due fetcher separati: i conteggi (totale prodotti/clienti) sono chiamate
  // "count" istantanee e alimentano subito PlanBanner, card totali e anteprima;
  // la readiness (pronti/problemi) richiede la paginazione completa e riempie solo
  // le sue due card in un secondo momento, senza bloccare il resto.
  const countsFetcher = useFetcher<CountsResponse>();
  const readinessFetcher = useFetcher<ReadinessResponse>();
  const readinessRefreshFetcher = useFetcher<ReadinessResponse>();
  const customerStatsFetcher = useFetcher<CustomerStatsResponse>();
  const customerStatsRefreshFetcher = useFetcher<CustomerStatsResponse>();
  // Il profitto arriva per conto suo: sono due interrogazioni al database del
  // merchant, e aspettarle prima di mostrare qualsiasi cosa ritarderebbe
  // l'intera dashboard per un numero che puo' comparire un istante dopo.
  const profitFetcher = useFetcher<ShopProfit & { averages: ShopAverages }>();

  // La metrica vive qui e non nella card: cambiandola si ricarica la rotta, e
  // la card non deve sapere da dove arrivano le sue righe.
  const topFetcher = useFetcher<TopProductsReport>();
  const [topMetric, setTopMetric] = useState<Metric>('cm');

  // Il periodo vale per tutta la pagina: profitto e prodotti rispondono alla
  // stessa domanda su archi diversi solo se glielo si chiede, e due periodi
  // nella stessa schermata sono due schermate.
  const [range, setRange] = useState<DateRange>(() => presetRange('monthToDate')!);
  // Spento di partenza: un confronto acceso senza averlo chiesto fa leggere
  // ogni numero come una variazione, e la variazione e' una seconda domanda.
  const [comparison, setComparison] = useState<ComparisonId>('none');
  const loadTop = useCallback(
    (metric: Metric, period: DateRange = range) => {
      setTopMetric(metric);
      topFetcher.load(
        `/api/stats/top-products?metric=${metric}&from=${period.from}&to=${period.to}`,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range],
  );

  // Cambiando periodo o confronto si ricaricano le due letture che ne
  // dipendono. Non la pagina intera: il resto — copertura, clienti, corse — non
  // guarda un periodo.
  const reloadForPeriod = useCallback(
    (period: DateRange, compare: ComparisonId) => {
      profitFetcher.load(
        `/api/stats/profit?from=${period.from}&to=${period.to}&compare=${compare}`,
      );
      topFetcher.load(
        `/api/stats/top-products?metric=${topMetric}&from=${period.from}&to=${period.to}`,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topMetric],
  );

  useEffect(() => {
    countsFetcher.load('/api/stats/counts');
    readinessFetcher.load('/api/stats/products');
    customerStatsFetcher.load('/api/stats/customers');
    reloadForPeriod(range, comparison);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Se il primo risultato arriva dalla cache, ricalcola live in background:
  // la card resta piena con i numeri cache e si aggiorna quando il fresco è pronto.
  useEffect(() => {
    if (readinessFetcher.data?.cached) {
      readinessRefreshFetcher.load('/api/stats/products?refresh=1');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readinessFetcher.data]);

  useEffect(() => {
    if (customerStatsFetcher.data?.cached) {
      customerStatsRefreshFetcher.load('/api/stats/customers?refresh=1');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerStatsFetcher.data]);

  const counts = countsFetcher.data;
  // Il valore live (refresh) vince appena disponibile, altrimenti la cache/primo calcolo.
  const readiness = readinessRefreshFetcher.data ?? readinessFetcher.data;
  const customerStats = customerStatsRefreshFetcher.data ?? customerStatsFetcher.data;
  const readinessLoading = !readiness;
  const customerStatsLoading = !customerStats;

  // Sync in background durabile (coda + drain). Il pulsante mostra il loader
  // mentre la sync è in corso — anche se prosegue in background a pagina chiusa —
  // e resta disabilitato dopo il completamento (le successive sono automatiche).
  const revalidator = useRevalidator();

  // La lingua durante la configurazione. Il selettore vive nella barra del
  // titolo perche' Impostazioni li' non e' raggiungibile — e la lingua e' la
  // sola cosa che serve poter cambiare prima ancora di aver capito cosa fa
  // l'app: chi non legge l'italiano non arriva al primo passo. La scelta vale
  // per tutta l'app, quindi si rilegge il dato di root, che e' dove la lingua
  // vive.
  const root = useRouteLoaderData<typeof rootLoader>('root');
  const localeFetcher = useFetcher<{ ok?: boolean }>();
  const changeLocale = useCallback(
    (next: Preferences) => {
      localeFetcher.submit(
        { locale: next.locale, currency: next.currency },
        { method: 'POST', action: '/api/locale' },
      );
    },
    [localeFetcher],
  );
  // La lingua cambia in due tempi: prima la si salva, poi la pagina torna con i
  // testi nuovi. In mezzo ci sono un paio di secondi in cui meta' schermata e'
  // ancora nella lingua di prima: i comandi restano fermi, cosi' nessuno
  // conferma un passo leggendo una frase che sta per cambiare.
  // Mentre la traduzione arriva i comandi dei passi restano fermi: confermare
  // un passo leggendo una frase che sta per cambiare sarebbe una scelta fatta
  // su un testo che non c'e' piu'.
  const [translating, setTranslating] = useState(false);
  useEffect(() => {
    if (localeFetcher.state === 'submitting') setTranslating(true);
  }, [localeFetcher.state]);
  useEffect(() => {
    if (translating && localeFetcher.state === 'idle' && revalidator.state === 'idle') {
      setTranslating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translating, localeFetcher.state, revalidator.state]);

  useEffect(() => {
    if (localeFetcher.state === 'idle' && localeFetcher.data?.ok) revalidator.revalidate();
    // revalidator fuori dalle dipendenze: revalidate() ne cambia lo stato, e
    // averlo qui rifarebbe partire l'effetto all'infinito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localeFetcher.state, localeFetcher.data]);

  const syncFetcher = useFetcher<{ queued?: boolean; error?: string }>();
  const [justQueued, setJustQueued] = useState(false);

  // Appena il job è in coda: mostra subito "in corso" e avvia il polling finché
  // il loader non riflette lo stato running/completed dal DB.
  useEffect(() => {
    if (syncFetcher.data?.queued) {
      setJustQueued(true);
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncFetcher.data]);

  const syncCompleted = syncState === 'completed';
  const submitting = syncFetcher.state !== 'idle';
  const inProgress =
    submitting || syncState === 'in_progress' || (justQueued && !syncCompleted);

  // Terzo passo: il piano, e con esso la prima sincronizzazione. Se il piano
  // scelto e' gia' quello attivo non c'e' niente da acquistare e si sincronizza
  // e basta; se e' un altro, prima si passa dall'addebito di Shopify.
  const subscribeFetcher = useFetcher<SubscribeResponse>();
  const [selectedPlan, setSelectedPlan] = useState(() =>
    preselectedPlan(planCards, shop.currentPlan),
  );
  // Il merchant ha toccato la scelta: da quel momento nessun consiglio la
  // sovrascrive piu'. Senza questo, il conteggio dei prodotti che arriva un
  // istante dopo riporterebbe la selezione sul consigliato, cancellando quella
  // appena fatta a mano.
  const [planTouched, setPlanTouched] = useState(false);
  // Mensile o annuale. Si parte dal mensile: e' l'impegno piu' leggero, e chi
  // sta configurando sta ancora decidendo se il servizio gli serve.
  const [billingInterval, setBillingInterval] = useState<BillingInterval>('monthly');
  const choosePlan = useCallback((name: string) => {
    setPlanTouched(true);
    setSelectedPlan(name);
  }, []);
  const [planError, setPlanError] = useState<string | null>(null);
  const subscribing = subscribeFetcher.state !== 'idle';

  const startSync = useCallback(() => {
    syncFetcher.submit({}, { method: 'post' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncFetcher]);

  const confirmPlanAndSync = useCallback(() => {
    setPlanError(null);
    // Piano gia' scelto in passato: qui si conferma quello attivo, e il cambio
    // sta nella tab Piano. Nessun acquisto da avviare.
    const changing =
      !planChosen && selectedPlan && !samePlanName(selectedPlan, shop.currentPlan);
    if (!changing) {
      startSync();
      return;
    }
    subscribeFetcher.submit(
      { plan: selectedPlan, interval: billingInterval, returnTo: 'dashboard' },
      { method: 'POST', action: '/billing/subscribe' },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planChosen, selectedPlan, billingInterval, shop.currentPlan, startSync, subscribeFetcher]);

  // Esito dell'avvio dell'acquisto.
  useEffect(() => {
    const data = subscribeFetcher.data;
    if (!data) return;
    if ('confirmationUrl' in data) {
      // Fuori dal riquadro: la pagina di approvazione di Shopify non si lascia
      // incorniciare. App Bridge intercetta il '_top' e naviga il contenitore.
      window.open(data.confirmationUrl, '_top');
      return;
    }
    if ('ok' in data) {
      // Piano senza addebito: applicato subito, si sincronizza senza uscire.
      startSync();
      return;
    }
    if ('error' in data) setPlanError(data.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribeFetcher.data]);

  // Quinto passo: le piattaforme spuntate e la risposta sull'infrastruttura.
  // Le spunte partono da quelle che quasi ogni negozio usa, oppure da quelle
  // gia' indicate se la risposta e' stata data e si sta solo rileggendo.
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>(() =>
    serverSidePlatforms.length > 0 ? serverSidePlatforms : defaultSelection(),
  );
  const [answeringServerSide, setAnsweringServerSide] = useState<ServerSideAnswer | null>(
    null,
  );
  const [serverSideError, setServerSideError] = useState<string | null>(null);

  const answerServerSide = useCallback(
    async (answer: ServerSideAnswer) => {
      setServerSideError(null);
      setAnsweringServerSide(answer);
      try {
        const response = await fetch('/api/tracking/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ answer, platforms: selectedPlatforms }),
        });
        const data = (await response.json()) as { ok?: boolean; error?: string };
        if (!data.ok) {
          setServerSideError(data.error ?? t.tracking.serverSide.failed);
          return;
        }
        // La risposta la dice il server: ricaricandola il passo risulta chiuso e
        // la configurazione finita.
        revalidator.revalidate();
      } catch {
        setServerSideError(t.tracking.serverSide.failed);
      } finally {
        setAnsweringServerSide(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedPlatforms],
  );

  // Ritorno dall'approvazione dell'addebito: il piano ora c'e', e la
  // sincronizzazione parte da sola. E' la promessa del pulsante che ha avviato
  // l'acquisto — "Conferma e sincronizza" — mantenuta dall'altra parte del giro.
  const [searchParams, setSearchParams] = useSearchParams();
  const billingApproved = searchParams.get('billing') === 'ok';
  useEffect(() => {
    if (!billingApproved) return;
    // Il parametro si toglie subito: ricaricando la pagina non deve rilanciare
    // una seconda sincronizzazione.
    const next = new URLSearchParams(searchParams);
    next.delete('billing');
    setSearchParams(next, { replace: true });
    if (supabaseConnected && !syncCompleted) startSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingApproved]);

  // Polling mentre la sync è in corso: rileva il passaggio a "completed".
  useEffect(() => {
    if (!inProgress || syncCompleted) return;
    const id = setInterval(() => revalidator.revalidate(), 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inProgress, syncCompleted]);

  // Allineamento automatico dopo un cambio di piano: si conclude fuori dalla
  // pagina, quindi si ricontrolla a intervalli piu' larghi finche' il piano
  // dell'ultima sync non torna allineato (allora planChanged diventa falso).
  // Il tetto di tentativi evita di continuare all'infinito se il recupero non
  // riesce: la dashboard resta comunque aggiornabile ricaricandola.
  const [catchUpTicks, setCatchUpTicks] = useState(0);
  // Anche la tabella clienti ancora mancante e' un allineamento in corso: si
  // ricontrolla finche' non risulta provveduta.
  const catchUpPending =
    planChanged || (supabaseConnected && customersEnabled && !customersTableCreated);
  useEffect(() => {
    if (!catchUpPending || catchUpTicks >= 20) return;
    const id = setTimeout(() => {
      setCatchUpTicks((n) => n + 1);
      revalidator.revalidate();
    }, 15000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catchUpPending, catchUpTicks]);

  // Prodotti TOTALI, idonei e non: il tetto del piano li taglia comunque, e un
  // prodotto oggi senza costo diventa idoneo appena il merchant lo compila.
  const totalProducts = (readiness?.readyCount ?? 0) + (readiness?.problemCount ?? 0);
  const currentPlanOption = planOptions.find((p) => samePlanName(p.planName, shop.currentPlan)) ?? null;
  const suggestedPlan =
    currentPlanOption && readiness
      ? suggestPlanForProducts(planOptions, shop.currentPlan, totalProducts)
      : null;

  // Il controllo delle altre fonti di eventi ha dato una risposta: il passo si
  // chiude quando il controllo e' finito, non quando il merchant ha fatto
  // qualcosa. E' un'informazione, non un compito — e per un canale collegato al
  // solo catalogo non c'e' niente da fare.
  // Il controllo e' fatto se il server lo sa gia' (apertura successiva) oppure
  // se la risposta e' appena arrivata (la prima volta).
  const trackingChecked =
    supabaseConnected && (trackingCheckedForConnection || conflictsFetcher.data != null);

  // Il piano e' deciso quando c'e' una scelta alle spalle e la sincronizzazione
  // di questa connessione e' arrivata in fondo. Le due cose contano a parte:
  // ora che la sincronizzazione parte da sola al collegamento del database, puo'
  // concludersi prima che qualcuno abbia scelto un piano, e il passo sparirebbe
  // portandosi via quella scelta. Chi ha un piano assegnato dall'owner non ha
  // invece niente da scegliere, e per lui la questione e' chiusa in partenza.
  const planConfirmed = syncCompleted && planConfirmedForConnection;

  // Il piano che basta a questo catalogo. Dipende dal conteggio dei prodotti,
  // che arriva da una richiesta: finche' non c'e' non si consiglia niente.
  const recommendedPlanName = recommendedPlan(
    planCards,
    readiness ? totalProducts : null,
    Object.fromEntries(planOptions.map((p) => [p.planName, p.maxProducts])),
  );

  // Il consigliato parte selezionato, appena si sa quale sia. Confermarlo non
  // acquista niente: un piano a pagamento passa comunque dall'approvazione di
  // Shopify, che e' dove la spesa si accetta davvero.
  useEffect(() => {
    if (planTouched || !recommendedPlanName) return;
    setSelectedPlan(recommendedPlanName);
  }, [planTouched, recommendedPlanName]);

  const steps = resolveStepStates({
    accountConnected: supabaseAccountConnected,
    databaseConnected: supabaseConnected,
    trackingChecked,
    planConfirmed,
  });

  // Tutti e cinque conclusi: la configurazione non ha piu' niente da chiedere.
  // Da qui in poi lo stepper sparisce — continuare a mostrarlo significa tenere
  // spazio occupato da caselle tutte spuntate — e quel che di utile conteneva,
  // account e database e disconnessione, passa nella card Connessione.
  // Conclusa una volta, conclusa per sempre: ci si torna solo scollegando
  // l'account, che azzera il segno lasciato dal server.
  const setupComplete = setupDone || allStepsComplete(steps);

  const planBanner = planChangeBanner({
    planChanged,
    currentMax: currentMaxProducts,
    previousMax: previousMaxProducts,
    customersEnabled,
    customersTableCreated,
    customersUpgradePlan,
    previousCustomersEnabled,
  }, t);
  const hasPlanBanner = planBanner !== null;

  // Ciclo di vita del banner. Compare appena c'e' un cambio di piano da
  // annunciare e, una volta comparso, resta per tutta la sessione: il
  // sessionStorage lo tiene vivo navigando fra le tab (stessa iframe) e
  // soprattutto NON lo fa sparire quando l'allineamento automatico finisce e
  // planChanged torna falso — altrimenti il merchant potrebbe non leggerlo mai.
  // Ci muore insieme, cioe' alla chiusura dell'app.
  const BANNER_KEY = 'planChangeBanner';
  // Anche la chiusura va nel sessionStorage: Dashboard e Logs sono route diverse,
  // quindi cambiando tab il componente si smonta e uno useState si azzererebbe —
  // il banner riapparirebbe pur essendo stato chiuso.
  const DISMISSED_KEY = 'planChangeBannerDismissed';

  // Sia il banner conservato sia la chiusura sono legati al piano a cui si
  // riferiscono. Senza, il primo banner della sessione resterebbe l'unico: chi
  // scende a un piano senza clienti e poi risale a uno che li include
  // continuerebbe a leggere "la sincronizzazione dei clienti si interrompe",
  // cioe' l'esatto contrario di quello che ha appena comprato. Per lo stesso
  // motivo la X chiusa una volta non deve zittire anche i cambi successivi.
  const bannerPlanId = normalizePlanName(shop.currentPlan);

  // Il contenuto viene congelato insieme all'istante di comparsa: dopo
  // l'allineamento il loader non conosce piu' il piano precedente, quindi il
  // messaggio va conservato com'era quando il cambio e' stato rilevato.
  const [banner, setBanner] = useState<
    { at: number; plan: string; value: NonNullable<typeof planBanner> } | null
  >(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  // Gli avvisi di sospensione, chiusi per questa visita.
  //
  // Chiudibili come gli altri, ma senza memoria: alla ricarica tornano. Non
  // sono una notifica da leggere una volta, sono lo stato in cui l'app si
  // trova — toglierli per sempre vorrebbe dire nascondere che e' sospesa. Cosi'
  // ci si libera la cima della pagina mentre si lavora, e la prossima apertura
  // lo ridice.
  const [hiddenAuthBanners, setHiddenAuthBanners] = useState<string[]>([]);

  useEffect(() => {
    if (sessionStorage.getItem(DISMISSED_KEY) === bannerPlanId) {
      setBannerDismissed(true);
      setBanner(null);
      return;
    }
    // Chiusura riferita a un piano precedente: non vale piu'.
    setBannerDismissed(false);

    const stored = sessionStorage.getItem(BANNER_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (parsed?.plan === bannerPlanId) {
          setBanner(parsed);
          return;
        }
      } catch {
        // Contenuto illeggibile: si riparte da capo.
      }
      sessionStorage.removeItem(BANNER_KEY);
    }

    if (planBanner) {
      const fresh = { at: Date.now(), plan: bannerPlanId, value: planBanner };
      sessionStorage.setItem(BANNER_KEY, JSON.stringify(fresh));
      setBanner(fresh);
    } else {
      setBanner(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPlanBanner, bannerPlanId]);

  const dismissBanner = () => {
    sessionStorage.setItem(DISMISSED_KEY, bannerPlanId);
    setBannerDismissed(true);
  };

  const showPlanBanner = banner !== null && !bannerDismissed;
  // Chiudibile da subito.
  //
  // Prima la X compariva dopo due minuti, per essere sicuri che il messaggio
  // venisse letto. Ma un avviso che non si puo' togliere non si fa leggere di
  // piu': si fa ignorare, e intanto occupa la cima della pagina mentre si sta
  // lavorando a qualcos'altro. Chi lo chiude subito lo ha gia' letto, e chi non
  // lo legge non lo leggerebbe comunque al secondo minuto.
  const bannerClosable = banner !== null;

  // Skeleton per i numeri di anteprima finché i conteggi non sono pronti.
  const numberSkeleton = (
    <Box minWidth="44px">
      <SkeletonDisplayText size="small" />
    </Box>
  );
  // Varianti idonee, NON il totale a catalogo: e' il numero che verra' davvero
  // scritto su Supabase, coerente con la card Prodotti. Usare counts.totalProducts
  // qui mostrava una grandezza diversa su due assi (prodotti vs varianti, tutti
  // vs idonei), quindi non poteva coincidere con la card.
  const previewProducts = readinessLoading ? (
    numberSkeleton
  ) : (
    <Text as="span" variant="headingMd">
      {readiness?.readyCount ?? 0}
    </Text>
  );
  // Clienti opt-in, NON il totale: e' il numero che verra' davvero scritto su
  // Supabase, ora che la sync filtra i non consenzienti. Stesso criterio gia'
  // applicato ai prodotti, dove il recap mostra le varianti idonee.
  const previewCustomers = customerStatsLoading ? (
    numberSkeleton
  ) : (
    <Text as="span" variant="headingMd">
      {customerStats?.optIn ?? 0}
    </Text>
  );

  const stepperItems: StepperItem[] = [
    {
      id: 'connect-supabase',
      title: t.steps.connectAccount.title,
      state: steps.connectAccount,
      completeLabel: t.steps.connectAccount.complete,
      badge: connectBadge,
      content: (
        // key sullo stato: rimonta il componente quando ci si collega o si
        // scollega, azzerando lo state locale (errori del tentativo precedente).
        <SupabaseAccountConnect
          key={supabaseAccountConnected ? 'connected' : 'disconnected'}
          connected={supabaseAccountConnected}
          disabled={blocked || translating}
          projectName={shop.supabaseConfig?.supabaseProjectRef ?? undefined}
          projectUrl={shop.supabaseConfig?.supabaseUrl ?? undefined}
          onDisconnected={setDisconnectDone}
          onStatusChange={setConnectStatus}
        />
      ),
    },
    {
      id: 'connect-database',
      title: t.steps.connectDatabase.title,
      state: steps.connectDatabase,
      completeLabel: t.steps.connectDatabase.complete,
      lockedHint: t.steps.connectDatabase.locked,
      content: (
        <SupabaseProjectConnect
          key={supabaseConnected ? 'connected' : 'disconnected'}
          connected={supabaseConnected}
          projectName={shop.supabaseConfig?.supabaseProjectRef ?? undefined}
          projectUrl={shop.supabaseConfig?.supabaseUrl ?? undefined}
          disabled={blocked || translating}
          authorization={authorization}
        />
      ),
    },
    {
      id: 'tracking-check',
      title: t.steps.trackingCheck.title,
      state: steps.trackingCheck,
      completeLabel: t.steps.trackingCheck.complete,
      lockedHint: t.steps.trackingCheck.locked,
      content: (
        <TrackingCheckStep
          loading={!trackingChecked}
          findings={conflictsFetcher.data?.findings ?? []}
          adminBase={conflictsFetcher.data?.adminBase}
          themeId={conflictsFetcher.data?.themeId}
        />
      ),
    },
    {
      id: 'plan',
      // Ultimo passo, ed e' la fine vera: confermando il piano parte la
      // sincronizzazione e da quel momento l'app lavora. Tutto quello che viene
      // prima serve a sapere cosa si sta comprando: cosa c'e' da sincronizzare
      // e cos'altro sta gia' leggendo il catalogo.
      //
      // La sincronizzazione non ha un pulsante suo: parte con la conferma.
      title: planChosen ? t.steps.plan.confirm : t.steps.plan.choose,
      state: steps.plan,
      // A sync completata: nessun badge sullo step (né "In corso" né altro).
      hideBadge: syncCompleted,
      lockedHint: t.steps.plan.locked,
      content: (
        <PlanStep
          cards={planCards}
          discountIntervals={discountIntervals}
          currency={currency}
          interval={billingInterval}
          onIntervalChange={setBillingInterval}
          selected={selectedPlan}
          onSelect={choosePlan}
          planChosen={planChosen}
          currentPlanName={shop.currentPlan}
          recommendedPlanName={recommendedPlanName}
          onConfirm={confirmPlanAndSync}
          loading={inProgress || subscribing}
          disabled={blocked || translating}
          error={planError ?? syncFetcher.data?.error ?? null}
        />
      ),
    },
  ];

  return (
    <Page
      fullWidth
      // Durante la configurazione la pagina si chiama come quello che ci si
      // fa: "Dashboard" prometterebbe numeri che ancora non esistono, ed e' la
      // stessa parola che il menu ha gia' sostituito.
      title={setupComplete ? t.dashboard.title : t.nav.configuration}
      // Durante la configurazione la barra porta la sola lingua: Impostazioni
      // parlerebbe di un progetto che non c'e' ancora, ed e' fra le pagine che
      // in questa fase non si raggiungono. A configurazione conclusa il
      // selettore torna dov'e' di casa, nella card Account.
      secondaryActions={
        setupComplete
          ? [
              {
                content: t.common.settings,
                icon: SettingsIcon,
                url: '/settings/supabase',
                accessibilityLabel: t.common.settings,
                onAction: settingsNav.start,
                disabled: settingsNav.loading,
                loading: settingsNav.loading,
              },
            ]
          : (
              <PreferencesSelect
                variant="header"
                locales={root?.locales ?? []}
                currencies={root?.currencies ?? []}
                value={{
                  locale: root?.locale ?? 'en',
                  currency: root?.currency ?? 'USD',
                }}
                onConfirm={changeLocale}
                saving={localeFetcher.state !== 'idle'}
              />
            )
      }
    >
      <BlockStack gap="500">
        {/* Periodo e confronto sotto il titolo, allineati a sinistra: dicono
            cosa si sta guardando, e vanno letti prima di qualsiasi numero.
            Nella barra del titolo finivano a destra, dalla parte opposta a
            quella da cui si comincia a leggere. */}
        {setupComplete && (
          <InlineStack gap="200" blockAlign="center" wrap>
            <DateRangePicker
              value={range}
              onChange={(next) => {
                setRange(next);
                reloadForPeriod(next, comparison);
              }}
            />
            <ComparisonSelect
              value={comparison}
              range={range}
              onChange={(next) => {
                setComparison(next);
                reloadForPeriod(range, next);
              }}
            />
          </InlineStack>
        )}

        {/* Gli avvisi stanno in una pila propria, stretta: sono una lista da
            leggere in fila, non sezioni indipendenti. Tenendoli nel contenitore
            del contenuto avrebbero avuto per forza la stessa distanza delle
            card, che fra un avviso e l'altro e' troppa. Lo stacco piu' ampio
            resta uno solo, fra l'ultimo avviso e il contenuto.

            Durante la configurazione la pila prende la stessa larghezza dei
            passi: un avviso disteso su tutto lo schermo, sopra una colonna
            stretta, sembrerebbe riguardare un'altra pagina. A configurazione
            conclusa la larghezza torna quella delle card, che sono cio' che
            gli avvisi accompagnano. */}
        <div style={setupComplete ? undefined : SETUP_CONTAINER}>
        <BlockStack gap="200">
        {/* Esito della disconnessione: in cima perche' e' la risposta all'ultima
            azione del merchant, e il modal che l'ha avviata e' gia' sparito. */}
        {disconnectDone && (
          <Banner
            tone="success"
            title={
              disconnectDone === 'delete'
                ? t.dashboard.disconnect.deletedTitle
                : t.dashboard.disconnect.keptTitle
            }
            onDismiss={() => setDisconnectDone(null)}
          >
            <Text as="p">
              {disconnectDone === 'delete'
                ? t.dashboard.disconnect.deletedBody
                : t.dashboard.disconnect.keptBody}
            </Text>
          </Banner>
        )}

        {/* Banner di sospensione. Uso dell'app e tracciamento sono due
            autorizzazioni indipendenti: puo' esserci l'una senza l'altra, e il
            banner lo dice invece di dare tutto per spento. */}
        {authorizationBanners(authorization, trackingAuthorization, t)
          .filter((b) => !hiddenAuthBanners.includes(b.id))
          .map((b) => (
            <Banner
              key={b.id}
              tone={b.tone}
              title={b.title}
              onDismiss={() => setHiddenAuthBanners((current) => [...current, b.id])}
            >
              <Text as="p">{b.message}</Text>
            </Banner>
          ))}

        {/* Il cambio di lingua non e' istantaneo: la pagina deve tornare dal
            server con i testi nuovi. Finche' non e' tornata lo si dice, gia'
            nella lingua scelta, e i passi restano fermi. */}
        {translating && (
          <Banner tone="info">
            <Text as="p">{t.language.translating}</Text>
          </Banner>
        )}

        {/* Chi altro sta gia' inviando eventi. Non compare se non c'e' niente
            da segnalare — e durante la configurazione non compare affatto:
            li' e' il terzo passo, non un avviso in cima. La stessa cosa detta
            in due punti della stessa pagina si legge come due problemi. */}
        {setupComplete && (
          <TrackingConflicts
            findings={conflictsFetcher.data?.findings ?? []}
            adminBase={conflictsFetcher.data?.adminBase}
            themeId={conflictsFetcher.data?.themeId}
          />
        )}

        {/* Tabelle da allineare: non si chiude finche' l'aggiornamento non e'
            andato a buon fine. Di norma succede da solo e il banner nemmeno si
            vede. */}
        {schemaUpdatePending && <SchemaUpdateBanner />}

        {/* L'avviso sul cambio di piano parla di una configurazione che gira
            gia': confronta il piano di adesso con quello dell'ultima
            sincronizzazione. Durante la configurazione quel confronto e' con
            una vita precedente dell'installazione — un database appena
            collegato faceva comparire "Piano aggiornato" senza che nessun piano
            fosse cambiato — quindi tace del tutto finche' i passi non sono
            chiusi.

            L'ordine con l'avviso sul tetto prodotti non e' indifferente: il
            piano e' la causa, il tetto raggiunto una delle sue conseguenze, e
            la causa si legge prima. */}
        {setupComplete && showPlanBanner && banner && (
          <Banner
            tone={banner.value.tone}
            title={banner.value.title}
            onDismiss={bannerClosable ? dismissBanner : undefined}
          >
            {/* Un paragrafo per argomento: prodotti e clienti cambiano per
                motivi diversi e vanno letti separatamente. */}
            <BlockStack gap="200">
              {banner.value.messages.map((message, index) => (
                <Text as="p" key={index}>
                  {typeof message === 'string'
                    ? message
                    : // Paragrafo a pezzi: il grassetto sta dentro la frase (il
                      // nuovo tetto prodotti), non su una riga a parte.
                      message.map((segment, segmentIndex) =>
                        segment.bold ? (
                          <Text key={segmentIndex} as="span" fontWeight="bold">
                            {segment.text}
                          </Text>
                        ) : (
                          segment.text
                        ),
                      )}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        )}

        {/* Catalogo piu' grande del tetto: dice quanti restano fuori e propone
            il piano che li contiene tutti. Non prima che un piano sia stato
            scelto e confermato: fino a quel momento il tetto e' quello del
            piano gratuito assegnato all'installazione, che nessuno ha voluto —
            avvisare che non basta sarebbe rimproverare una scelta mai fatta, e
            per giunta accanto al passo che quella scelta la sta chiedendo, dove
            il badge "Consigliato" dice gia' la stessa cosa meglio. */}
        {planConfirmed && <ProductOverflowBanner disabled={blocked} />}

        </BlockStack>
        </div>

        {/* I passi vengono prima di tutto il resto: finche' ce n'e' uno aperto,
            e' quello la cosa da fare, e leggerlo dopo le card significherebbe
            trovarlo dopo aver gia' cercato altrove.

            Larghezza ridotta e centrata: la stessa che la Page aveva prima di
            passare a fullWidth. E' l'espressione di Polaris, non un numero
            copiato, quindi resta allineata anche se il tema cambia. Un modulo
            da compilare largo tutto lo schermo si legge peggio, e le card che
            arrivano dopo hanno bisogno di tutta la larghezza, non lui. */}
        {!setupComplete && (
          <div style={SETUP_CONTAINER}>
            <Stepper steps={stepperItems} />
          </div>
        )}

        {/* La dashboard vera compare a configurazione conclusa, non un passo
            prima. Fino a quel momento c'e' una cosa da fare per volta, ed e'
            nello stepper: card e grafico sotto ai passi ancora aperti si
            leggono come se il lavoro fosse gia' finito, mentre non lo e'. */}
        {setupComplete && (
          <>
        {/* Quattro card in fila: prima il profitto, che e' la domanda, poi le
            tre che dicono quanto ci si possa fidare della risposta. Il profitto
            su una riga tutta sua sprecava mezza schermata per un numero. */}
        <InlineGrid columns={{ xs: 1, sm: 2, xl: 4 }} gap="400">
          <ProfitCard
            profit={profitFetcher.data?.profit ?? null}
            orders={profitFetcher.data?.orders ?? 0}
            change={profitFetcher.data?.change ?? null}
            coveredLines={profitFetcher.data?.coveredLines ?? 0}
            totalLines={profitFetcher.data?.totalLines ?? 0}
            currency={profitFetcher.data?.currency ?? 'EUR'}
            unavailable={profitFetcher.data?.unavailable ?? null}
            loading={!profitFetcher.data}
            onFix={issuesNav.start}
            fixLoading={issuesNav.loading}
          />
          <CoverageCard
            label={t.dashboard.coverage.productsTitle}
            hint={t.dashboard.coverage.productsHint}
            ready={readiness?.readyCount ?? 0}
            total={(readiness?.readyCount ?? 0) + (readiness?.problemCount ?? 0)}
            detail={t.dashboard.coverage.ready}
            issue={(readiness?.problemCount ?? 0) > 0}
            action={{
              label: t.dashboard.coverage.fix,
              url: '/products/issues',
              onAction: issuesNav.start,
              loading: issuesNav.loading,
            }}
            loading={readinessLoading}
          />
          {customersEnabled ? (
            <CoverageCard
              label={t.dashboard.coverage.customersTitle}
              hint={t.dashboard.coverage.customersHint}
              ready={customerStats?.optIn ?? 0}
              total={customerStats?.totalCustomers ?? 0}
              detail={t.dashboard.coverage.optedIn}
              loading={customerStatsLoading}
            />
          ) : (
            // Piano senza clienti: resta la card di prima, che al posto dei
            // numeri porta l'invito ad aggiornare.
            <CustomersCard
              enabled={false}
              totalCustomers={0}
              optIn={0}
              optOut={0}
              loading={false}
            />
          )}
          {/* Al posto delle date — che vivono in Logs, dove le si va a
              cercare — quanto resta di un ordine medio. */}
          <MarginCard
            aov={profitFetcher.data?.averages?.aov ?? null}
            aop={profitFetcher.data?.averages?.aop ?? null}
            currency={profitFetcher.data?.averages?.currency ?? 'EUR'}
            loading={!profitFetcher.data}
          />
        </InlineGrid>

        {/* Il grafico prende i due terzi e accanto gli sta il registro in
            breve. */}
        <InlineGrid
          columns={{ xs: 1, lg: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)' }}
          gap="400"
        >
          {/* Al posto del grafico dei prodotti sincronizzabili, per ora messo
              da parte: contava quanti prodotti stanno nel piano, e in una riga
              che parla di profitto era la domanda meno urgente. */}
          <TopProductsCard
            rows={topFetcher.data?.rows ?? []}
            currency={topFetcher.data?.currency ?? 'EUR'}
            metric={topMetric}
            onMetric={loadTop}
            loading={topFetcher.state !== 'idle' || !topFetcher.data}
            adminBase={conflictsFetcher.data?.adminBase}
          />
          {/* Fra i due: il valore accanto al profitto. E' la stessa domanda
              delle card sopra, guardata da lontano. */}
          <ProfitabilityChart
            aov={profitFetcher.data?.averages?.aov ?? null}
            aop={profitFetcher.data?.averages?.aop ?? null}
            ltv={profitFetcher.data?.averages?.ltv ?? null}
            ltp={profitFetcher.data?.averages?.ltp ?? null}
            currency={profitFetcher.data?.averages?.currency ?? 'EUR'}
            loading={!profitFetcher.data}
          />

          <RecentRunsCard runs={recentRuns} timeZone={shop.ianaTimezone} />
        </InlineGrid>


        {/* In fondo, e chiudibile: e' una proposta, non una cosa da fare.
            Sparisce per sempre appena il merchant risponde — o dice "non
            adesso" con la x. */}
        {serverSideAnswer === null && (
          <AdvancedSetupCard
            selected={selectedPlatforms}
            onSelectedChange={setSelectedPlatforms}
            onAnswer={answerServerSide}
            submitting={answeringServerSide}
            disabled={blocked}
            error={serverSideError}
          />
        )}
          </>
        )}

        {/* Respiro in fondo: senza, il bordo dell'ultima card tocca il fondo dell'iframe. */}
        <Box paddingBlockEnd="800" />
      </BlockStack>
    </Page>
  );
}
