import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from '@remix-run/node';
import { defer, json } from '@remix-run/node';
import { Await, useLoaderData, useNavigation, useRevalidator, useSearchParams } from '@remix-run/react';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Icon,
  IndexTable,
  InlineGrid,
  InlineStack,
  Link,
  Page,
  SkeletonBodyText,
  Spinner,
  Tabs,
  Text,
  TextField,
  Tooltip,
  useIndexResourceState,
} from '@shopify/polaris';
import type { IndexTableProps } from '@shopify/polaris';
import { AlertCircleIcon, CheckCircleIcon } from '@shopify/polaris-icons';
import { PlanChangeBanner } from '~/components/Dashboard/PlanChangeBanner';
import { prisma } from '~/db.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { firstPlanWithCustomersSync } from '~/components/Dashboard/account-format';
import { BASE_CURRENCY } from '~/lib/billing/money';
import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import type { CustomersReport } from '~/lib/customers/customers.server';
import { fetchConflictCustomerNames } from '~/lib/customers/customers.server';
import {
  startCustomersPageData,
  type BirthdateData,
} from '~/lib/customers/page-data.server';
import { dismissBirthdateNotice } from '~/lib/customers/birthdate-dismissal.server';
import { ServerTiming } from '~/lib/timing/server-timing';
import { isCalendarDate } from '~/lib/customers/customers-query';
import {
  ALL_TIME_START,
  CUSTOMERS_DEFAULT_PRESET,
  defaultRange,
  type DateRange,
} from '~/lib/dates/ranges';
import { DateRangePicker } from '~/components/Dashboard/DateRangePicker';
import { CUSTOMERS_PER_PAGE, pageCount, pageSlice } from '~/lib/table/pagination';
import { TablePagination } from '~/components/Dashboard/TablePagination';
import { matchesCustomerSearch } from '~/lib/customers/customer-search';
import { formatMoney } from '~/lib/billing/money';
import { useLocale, useT } from '~/lib/i18n/context';
import { ProductOverflowBanner } from '~/components/Dashboard/ProductOverflowBanner';
import { PlanUpgradeAction } from '~/components/Dashboard/PlanUpgradeAction';
import {
  BirthdateMetafieldCard,
  useBirthdateNotice,
} from '~/components/Customers/BirthdateMetafieldCard';
import { BirthdateStatusRow } from '~/components/Customers/BirthdateStatusRow';
import { ExtraFieldsCard } from '~/components/Customers/ExtraFieldsCard';
import { IntegrationsCard } from '~/components/Customers/IntegrationsCard';
import { IntegrationsModal } from '~/components/Customers/IntegrationsModal';
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import {
  BIRTHDATE_METAFIELD_KEY,
  birthdateMetafieldOf,
  formatMetafieldKey,
  parseMetafieldKey,
} from '~/lib/customers/birthdate-metafield';
import { storeHandle } from '~/utils/admin-page';
import {
  requireShopCapability,
  shopCapabilityOutcome,
} from '~/lib/authz/require-capability.server';
import { listConflicts } from '~/lib/integrations/conflicts.server';
import { conflictRows, effectiveView } from '~/lib/customers/conflict-rows';


/**
 * I tempi del caricamento, anche quando la pagina arriva intera e non da una
 * navigazione: senza, l'header resterebbe sulla sola risposta dei dati.
 */
export const headers: HeadersFunction = ({ loaderHeaders }) => {
  const out = new Headers();
  const timing = loaderHeaders.get('Server-Timing');
  if (timing) out.set('Server-Timing', timing);
  return out;
};

export async function loader({ request }: LoaderFunctionArgs) {
  // Quanto costa ogni fase, nell'header `Server-Timing`: si legge dagli
  // strumenti del browser, anche in produzione. Le fasi che finiscono dopo la
  // risposta (i dati che arrivano in un secondo momento) vanno nei log.
  const timing = new ServerTiming();

  // IL CANCELLO, E VIENE PRIMA DI TUTTO.
  //
  // Questa pagina e' la piu' esposta dell'app: sotto ci sono nomi, email e
  // quanto ogni cliente ha speso. Finche' l'unica condizione era "la
  // configurazione e' conclusa", un negozio con la prova finita, sospeso o con
  // la cancellazione GDPR gia' cominciata continuava a leggerseli — bastava
  // aprire l'indirizzo, senza passare da nessun pulsante.
  //
  // Il rifiuto qui e' un ritorno alla dashboard e non un 403: una pagina intera
  // sostituita da un codice di stato non dice al merchant che cosa puo' fare,
  // e la dashboard invece glielo dice gia' — con il banner e, quando serve, la
  // strada per aggiornare il piano.
  const { session, shop } = await timing.measure('auth', async () => {
    const grant = await requireShopCapability(request, 'use_app', { onDenied: 'redirect' });
    await requireSetupComplete(grant.session.shop);
    return grant;
  });

  // Le date arrivano dalla URL, quindi da fuori: quello che non e' una data si
  // ignora e si torna al periodo di partenza, invece di far fallire la pagina.
  const params = new URL(request.url).searchParams;
  const wanted = { from: params.get('from') ?? '', to: params.get('to') ?? '' };
  const rangeFromUrl =
    isCalendarDate(wanted.from) && isCalendarDate(wanted.to) && wanted.from <= wanted.to
      ? wanted
      : null;

  // Il periodo di partenza e' "da sempre": la tabella deve mostrare tutti i
  // clienti che hanno comprato, non solo quelli dell'ultimo mese. Con trenta
  // giorni di partenza e nessun selettore a vista, chi aveva ordinato prima
  // spariva senza un segno. Si sceglie dopo aver letto il negozio, perche'
  // "oggi" — la fine del periodo — e' il giorno del SUO fuso.
  const range = rangeFromUrl ?? defaultRange(shop.ianaTimezone, undefined, CUSTOMERS_DEFAULT_PRESET);

  // Il piano decide se questa tabella ha qualcosa da mostrare. Senza la
  // sincronizzazione clienti la tabella nel database del merchant non esiste
  // nemmeno, e la query falliva con un 400 che arrivava fino a schermo come
  // "Unexpected Server Error" — con la pagina d'errore che, per giunta, torna
  // scura. Meglio entrare e trovare scritto perche' non c'e' niente.
  const { customersIncluded, upgradePlan } = await timing.measure('plan', async () => {
    const plan = await findPlanByName(shop.currentPlan);
    const included = plan?.customersSyncEnabled ?? false;
    if (included) return { customersIncluded: true, upgradePlan: null };

    const [plans, basePrices] = await Promise.all([
      prisma.plan.findMany(),
      prisma.planPrice.findMany({ where: { currency: BASE_CURRENCY } }),
    ]);
    const monthlyOf = new Map(basePrices.map((row) => [row.planName, Number(row.priceMonthly)]));
    return {
      customersIncluded: false,
      upgradePlan: firstPlanWithCustomersSync(
        plans.map((p) => ({
          planName: p.planName,
          priceMonthly: monthlyOf.get(p.planName) ?? 0,
          customersSyncEnabled: p.customersSyncEnabled,
        })),
        shop.currentPlan,
      ),
    };
  });

  // Il report dal database del merchant e i campi personalizzati da Shopify
  // sono le due attese lunghe, e la pagina non le aspetta: partono qui, insieme,
  // e arrivano dopo. Il cambio di tab e' immediato — intestazione, periodo e lo
  // scheletro della tabella — invece di restare fermi sulla pagina di prima
  // finche' il database non ha risposto.
  //
  // Senza il piano non c'e' niente da attendere: si sa gia' cosa dire.
  const data: Promise<CustomersPageView> | CustomersPageView = customersIncluded
    ? Promise.all([
        startCustomersPageData({ shopDomain: session.shop, shop, range, timing }),
        timing.measure('conflicts', () =>
          listConflicts(shop.id, { status: 'open' }).catch((error) => {
            console.warn(
              '[customers] conflitti non leggibili:',
              error instanceof Error ? error.message : 'errore sconosciuto',
            );
            return [];
          }),
        ),
      ]).then(async ([pageData, rawConflicts]) => {
        // Fetch nomi dal database del merchant (I3b: validazione interna)
        const ref = shop.supabaseConfig?.supabaseProjectRef;
        if (!ref) {
          return { ...pageData, conflicts: rawConflicts, conflictNames: [] };
        }

        const conflictCustomerIds = rawConflicts.map((c) => c.customerId);
        const nameMap = await timing.measure('conflict-names', () =>
          fetchConflictCustomerNames(shop.id, ref, conflictCustomerIds),
        );

        // Converte Map in array per JSON serialization
        const conflictNames = Array.from(nameMap.entries()).map(([customerId, names]) => ({
          customerId,
          ...names,
        }));

        // Passa rawConflicts e conflictNames: conflictRows fa il merge (I3b)
        return { ...pageData, conflicts: rawConflicts, conflictNames };
      })
    : {
        report: { rows: [], currency: 'EUR', lifetimeCustomers: 0, unavailable: 'plan_required' },
        // Il riquadro del campo "Data di nascita" c'e' solo con un piano che
        // sincronizza i clienti: senza, il campo non arriverebbe da nessuna
        // parte e il merchant lo compilerebbe per niente.
        birthdate: null,
        // Le integrazioni: null se il piano non include clienti.
        integrations: null,
        conflicts: [],
        conflictNames: [],
      };

  return defer(
    {
      data,
      customersIncluded,
      upgradePlan,
      range,
      // Per il selettore: "oggi" e' il giorno del negozio, non del browser.
      timeZone: shop.ianaTimezone ?? null,
      // Per aprire la scheda del cliente: da qui il merchant vede l'anagrafica
      // vera, ed e' il gesto che segue la lettura di una riga.
      adminBase: `https://admin.shopify.com/store/${storeHandle(session.shop)}`,
    },
    { headers: { 'Server-Timing': timing.header() } },
  );
}

/** Le intestazioni della tabella, uguali nello scheletro e nella tabella vera. */
function customerHeadings(t: ReturnType<typeof useT>): IndexTableProps['headings'] {
  return [
    { title: t.customers.columns.customer },
    // Senza intestazione: e' una spia, non un dato. Un titolo sopra due icone
    // chiederebbe di leggere una parola per capire un segno che si capisce
    // gia' da solo.
    { title: '', alignment: 'center' as const },
    { title: t.customers.columns.orders },
    { title: t.customers.columns.aop },
    { title: t.customers.columns.ltp },
    { title: t.customers.columns.status },
    { title: t.customers.columns.actions },
  ];
}

/** Le intestazioni della tabella nella vista conflitti. */
function conflictsHeadings(t: ReturnType<typeof useT>): IndexTableProps['headings'] {
  return [
    { title: t.customers.columns.customer },
    { title: t.customers.conflicts.birthdateColumn },
    { title: t.customers.columns.actions },
  ];
}

/** Formatta una data ISO YYYY-MM-DD per la vista conflitti */
function formatConflictDate(isoDate: string, locale: string): string {
  try {
    const [year, month, day] = isoDate.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
  } catch {
    return isoDate;
  }
}

/**
 * Righe di riempimento per mantenere l'altezza costante della tabella.
 * Estratto in componente per evitare duplicazione (I7).
 */
function FillerRows({ count, cols, start = 0 }: { count: number; cols: number; start?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <IndexTable.Row
          key={`filler-${start + i}`}
          id={`filler-${start + i}`}
          position={start + i}
          disabled
        >
          {Array.from({ length: cols }, (_, colIdx) => (
            <IndexTable.Cell key={colIdx}>
              <span aria-hidden="true" style={{ visibility: 'hidden' }}>
                &nbsp;
              </span>
            </IndexTable.Cell>
          ))}
        </IndexTable.Row>
      ))}
    </>
  );
}

/** Cio' che la pagina riceve quando i dati sono arrivati. */
interface CustomersPageView {
  report: CustomersReport;
  birthdate: BirthdateData | null;
  integrations: Array<{
    provider: 'klaviyo';
    status: 'connected' | 'not_connected' | 'needs_reconnect';
    accountName?: string | null;
    mapping: { sourceKey: string; dateFormat: string } | null;
    lastRun: {
      status: 'completed' | 'interrupted';
      finishedAt: string | null;
      counters: { filled?: number; conflicts?: number; [key: string]: unknown };
    } | null;
    openConflicts: number;
  }> | null;
  conflicts: Array<{
    customerId: number;
    field: 'birthdate';
    ours: string | null;
    theirs: string;
    provider: 'klaviyo';
    firstName?: string | null;
    email?: string | null;
  }>;
  conflictNames: Array<{
    customerId: number;
    firstName: string | null;
    email: string | null;
  }>;
}

/**
 * Sceglie da quale campo del cliente leggere la data di nascita.
 *
 * Due strade, e finiscono allo stesso posto — due colonne sulla riga del
 * negozio: `create` accende sul negozio il campo che Shopify prevede per la
 * data di nascita e lo mette in uso, `use` punta a uno che il negozio ha gia'.
 * La colonna sul database del merchant e' sempre `date_of_birth`: qui si decide
 * da dove prende il valore, non dove finisce.
 *
 * Dopo si richiede a Shopify se il campo c'e', con una domanda mirata su
 * namespace e chiave: e' l'unica cosa che autorizza a metterlo in uso. Fidarsi
 * dell'esito della scrittura vorrebbe dire dare per riuscito anche quello che
 * non lo e'.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Lo stesso cancello del riquadro, ripetuto qui: quello nasconde i comandi,
  // questo nega l'azione. Una richiesta non arriva per forza da un pulsante.
  //
  // E prima del piano, perche' sono due domande diverse: il piano dice se
  // questa funzione e' compresa, l'uso dell'app dice se il negozio puo' ancora
  // toccare la propria configurazione. Un negozio con la prova finita passava
  // il primo controllo e cambiava da dove si legge la data di nascita dei suoi
  // clienti come se niente fosse.
  //
  // Il rifiuto si RESTITUISCE: lo legge il riquadro che ha mandato la
  // richiesta, e la pagina resta dov'e'.
  const cancello = await shopCapabilityOutcome(request, 'use_app');
  if (!cancello.ok) return cancello.response;
  const { session, shop } = cancello.grant;

  if (request.method !== 'POST') {
    return json({ ok: false as const, error: 'failed' as const }, { status: 405 });
  }

  const plan = await findPlanByName(shop.currentPlan);
  if (!plan?.customersSyncEnabled) {
    return json({ ok: false as const, error: 'failed' as const }, { status: 403 });
  }

  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

  // "Non mostrarmelo piu'": si segna per QUALE campo, non come un si'/no.
  // Cambiando il campo da cui si legge la data di nascita c'e' una conferma
  // nuova da dare, e un si'/no avrebbe zittito anche quella.
  //
  // Si risponde se la chiusura e' stata davvero registrata: il riquadro riapre
  // l'avviso quando non lo e' stata, invece di lasciar credere al merchant che
  // il suo gesto sia stato preso.
  if (intent === 'dismiss-birthdate-notice') {
    const dismissed = await dismissBirthdateNotice(
      shop.id,
      formatMetafieldKey(birthdateMetafieldOf(shop)),
    );
    return json({ ok: dismissed, dismissed });
  }

  // Il campo che il merchant ha scelto o incollato. Quello che non si divide in
  // namespace e chiave non si salva: una riga interpretata a naso lascerebbe la
  // colonna vuota senza che si capisca il perche'.
  if (intent === 'use') {
    const chosen = parseMetafieldKey(String(form.get('metafield') ?? ''));
    if (!chosen) {
      return json({ ok: false as const, error: 'invalid' as const }, { status: 400 });
    }

    await prisma.shop.update({
      where: { shopDomain: session.shop },
      data: {
        birthdateMetafieldNamespace: chosen.namespace,
        birthdateMetafieldKey: chosen.key,
      },
    });
    return json({ ok: true as const, error: null });
  }

  try {
    const client = await ShopifyAPIClient.forShop(session.shop);
    await client.enableCustomerBirthdateDefinition();

    if (!(await client.hasCustomerBirthdateDefinition())) {
      return json({ ok: false as const, error: 'failed' as const }, { status: 502 });
    }

    await prisma.shop.update({
      where: { shopDomain: session.shop },
      data: {
        birthdateMetafieldNamespace: BIRTHDATE_METAFIELD_KEY.namespace,
        birthdateMetafieldKey: BIRTHDATE_METAFIELD_KEY.key,
      },
    });
    return json({ ok: true as const, error: null });
  } catch (error) {
    console.error(
      '[customers] attivazione del campo data di nascita non riuscita:',
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
    return json({ ok: false as const, error: 'failed' as const }, { status: 500 });
  }
}

/**
 * Il contenuto della tab, una volta arrivati i dati.
 *
 * Sta in un componente a se' perche' vive dentro `<Await>`: i suoi stati —
 * ricerca, filtro, pagina — si conservano quando il periodo cambia, perche'
 * le navigazioni di Remix sono transizioni e React tiene a schermo il
 * contenuto gia' mostrato finche' i dati nuovi non arrivano.
 */
function CustomersContent({
  view,
  upgradePlan,
  adminBase,
  range,
  timeZone,
}: {
  view: CustomersPageView;
  upgradePlan: string | null;
  adminBase: string;
  range: DateRange;
  timeZone: string | null;
}) {
  const { rows, currency, unavailable, lifetimeCustomers } = view.report;
  const birthdate = view.birthdate;
  const integrations = view.integrations;
  const conflicts = view.conflicts;
  const conflictNames = view.conflictNames;
  const t = useT();
  const locale = useLocale();
  // Quale riga ha appena chiesto "Risolvi problemi": la pagina dei prodotti
  // impiega un momento a caricare, e senza un segno sulla riga il clic sembra
  // non aver fatto niente — e si clicca di nuovo.
  const navigation = useNavigation();
  const clienteInApertura =
    navigation.state === 'loading' && navigation.location.pathname === '/products/issues'
      ? new URLSearchParams(navigation.location.search).get('customer')
      : null;

  // Vista effettiva: conflicts solo se richiesto E ci sono conflitti aperti (I4)
  const [searchParams, setSearchParams] = useSearchParams();
  const openConflictsCount = conflicts.length;
  const currentView = effectiveView(searchParams, openConflictsCount);

  // Revalidator per aggiornare i dati dopo la risoluzione
  const revalidator = useRevalidator();

  // Stato per le risoluzioni conflitti (I5: explicit fetch, no useFetcher)
  const [resolving, setResolving] = useState(false);

  // Il filtro sta in uno stato e non nell'indirizzo: non ricarica niente —
  // le righe sono gia' tutte qui — e passare dal server per nascondere delle
  // righe che si hanno gia' sarebbe un viaggio per nulla. Vale anche per la
  // ricerca, che lavora sulle stesse righe.
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [query, setQuery] = useState('');

  // Modal «Gestisci» integrazioni
  const [integrationsModalOpen, setIntegrationsModalOpen] = useState(false);
  const [preselectedProvider, setPreselectedProvider] = useState<'klaviyo' | null>(null);

  const handleManage = (provider: 'klaviyo') => {
    setPreselectedProvider(provider);
    setIntegrationsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIntegrationsModalOpen(false);
    setPreselectedProvider(null);
  };

  // Il periodo invece sta nell'indirizzo: cambiarlo vuol dire chiedere al
  // database altri ordini, e il caricamento lo legge da li'. Si toccano solo
  // `from` e `to`: gli altri parametri (quelli con cui l'admin apre l'app)
  // restano dove sono. Ricerca e filtro restano quelli scelti.
  const choosePeriod = (next: DateRange) => {
    const params = new URLSearchParams(searchParams);
    params.set('from', next.from);
    params.set('to', next.to);
    setSearchParams(params, { replace: true, preventScrollReset: true });
  };
  const periodLoading =
    navigation.state === 'loading' && navigation.location.pathname === '/customers';
  // "Da sempre" non lascia fuori nessuno. Qualunque altro periodo si': chi ha
  // comprato prima non compare, e va detto — altrimenti sembra sparito.
  const isAllTime = range.from <= ALL_TIME_START;
  const periodHidesSome =
    unavailable === null && !isAllTime && (rows.length === 0 || rows.length < lifetimeCustomers);

  // Della data di nascita si vede una cosa sola alla volta: il riquadro con cui
  // si sceglie il campo, l'avviso che conferma la scelta appena fatta, o la
  // riga di stato qui sopra la tabella. Chi decide quale sta nell'hook, non
  // qui: lo stesso verdetto serve al riquadro e alla riga, e due copie della
  // stessa regola sono due cose da tenere allineate. Chiamato sempre, anche
  // senza il riquadro da mostrare: un hook non si salta.
  const notice = useBirthdateNotice(
    birthdate?.configured ?? '',
    birthdate?.state ?? 'none',
    birthdate?.dismissedFor ?? null,
  );

  const needsWork = (row: { coveredLines: number; totalLines: number }) =>
    row.coveredLines < row.totalLines;
  const filtered = onlyIssues ? rows.filter(needsWork) : rows;
  const hiddenByFilter = rows.length - filtered.length;
  const matching = filtered.filter((row) => matchesCustomerSearch(row, query));

  // La pagina che si sta guardando. Le righe le porta il caricamento tutte
  // insieme — sono gia' filtrate dal periodo — quindi si impagina qui, dove si
  // sa anche cosa la ricerca ha lasciato.
  const [page, setPage] = useState(1);
  const visibleRows = pageSlice(matching, page, CUSTOMERS_PER_PAGE);

  // Cambiando ricerca o filtro si riparte da pagina 1: restare a pagina 4 su un
  // risultato che ne ha due mostrerebbe una tabella vuota senza spiegazione.
  // Lo stesso per il periodo: sono altre righe, e si comincia dalla prima.
  useEffect(() => {
    setPage(1);
  }, [query, onlyIssues, range.from, range.to]);

  // E se le righe si accorciano sotto i piedi — un filtro acceso mentre si e'
  // in fondo — si arretra invece di restare su una pagina che non c'e' piu'.
  const totalPages = pageCount(matching.length, CUSTOMERS_PER_PAGE);
  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [totalPages, page]);
  // Con una ricerca senza risultati la tabella resta vuota: senza dirlo
  // sembrerebbe un negozio senza clienti, mentre e' solo la ricerca a non aver
  // trovato nulla.
  const noSearchResults = query.trim().length > 0 && matching.length === 0;

  // Stato per Banner errori (I5)
  const [showNotWrittenBanner, setShowNotWrittenBanner] = useState(false);
  const [notWrittenCount, setNotWrittenCount] = useState(0);
  const [genericError, setGenericError] = useState(false);

  // Funzioni per gestire il cambio di tab
  const handleTabChange = (selectedTabIndex: number) => {
    const params = new URLSearchParams(searchParams);
    if (selectedTabIndex === 0) {
      params.delete('view');
    } else {
      params.set('view', 'conflicts');
    }
    setSearchParams(params, { replace: true, preventScrollReset: true });
  };

  // Paginazione separata per la vista conflitti (I2)
  const [conflictsPage, setConflictsPage] = useState(1);

  // Usa conflictRows per il merge (I3b: funzione testata invece di inline)
  // Converte conflictNames array in CustomerData[] per conflictRows
  const customerDataFromNames = (conflictNames ?? []).map(
    ({ customerId, firstName, email }) => ({
      customerId,
      firstName,
      email,
      // Campi richiesti da CustomerData ma non usati da conflictRows
      lastName: null,
      orders: 0,
      profit: 0,
      coveredLines: 0,
      totalLines: 0,
      currency: 'EUR',
      synced: false,
      phone: null,
    }),
  );
  const conflictRowsData = conflictRows(conflicts, customerDataFromNames);

  const paginatedConflicts = pageSlice(conflictRowsData, conflictsPage, CUSTOMERS_PER_PAGE);
  const conflictsTotalPages = pageCount(conflictRowsData.length, CUSTOMERS_PER_PAGE);

  // Selezione nella vista conflitti con useIndexResourceState (I1)
  const {
    selectedResources,
    allResourcesSelected,
    handleSelectionChange,
    clearSelection,
  } = useIndexResourceState(paginatedConflicts, {
    resourceIDResolver: (r) => String(r.customerId),
  });

  // Reset pagina conflitti quando si cambia vista (I2)
  useEffect(() => {
    setConflictsPage(1);
  }, [currentView]);

  // Clamp conflictsPage a conflictsTotalPages (minor fix)
  useEffect(() => {
    if (conflictsTotalPages > 0 && conflictsPage > conflictsTotalPages) {
      setConflictsPage(conflictsTotalPages);
    }
  }, [conflictsTotalPages, conflictsPage]);

  // Reset selezione quando si cambia vista o pagina (I1)
  useEffect(() => {
    clearSelection();
  }, [currentView, conflictsPage, clearSelection]);

  // Funzioni per risolvere conflitti con explicit fetch (I5)
  const resolveConflicts = useCallback(
    async (customerIds: number[], choice: 'kept_ours' | 'used_theirs') => {
      if (customerIds.length === 0) return;

      // Reset genericError all'inizio di ogni tentativo (I5)
      setGenericError(false);
      setResolving(true);

      try {
        const response = await fetch('/api/integrations/conflicts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerIds, choice }),
        });

        const data = (await response.json()) as {
          ok: boolean;
          resolved?: number;
          notWritten?: number[];
        };

        if (data.ok) {
          const resolved = data.resolved ?? 0;
          const notWritten = data.notWritten ?? [];

          // Toast con copy diverso per kept_ours vs used_theirs
          if (typeof window !== 'undefined' && window.shopify?.toast) {
            const message =
              choice === 'kept_ours'
                ? t.customers.conflicts.resolvedKeptOurs(resolved)
                : t.customers.conflicts.resolvedUsedTheirs(resolved);
            window.shopify.toast.show(message);
          }

          // Banner per notWritten (I5)
          if (notWritten.length > 0) {
            setNotWrittenCount(notWritten.length);
            setShowNotWrittenBanner(true);
            setGenericError(false);
          } else {
            setShowNotWrittenBanner(false);
          }

          // Clear selection e revalidate
          clearSelection();
          revalidator.revalidate();
        } else {
          // Errore generico per !ok (I5)
          setGenericError(true);
          setShowNotWrittenBanner(true);
        }
      } catch (error) {
        // Network error (I5)
        console.warn(
          '[customers] errore nella risoluzione conflitti:',
          error instanceof Error ? error.message : 'errore sconosciuto',
        );
        setGenericError(true);
        setShowNotWrittenBanner(true);
      } finally {
        setResolving(false);
      }
    },
    [clearSelection, revalidator, t],
  );

  const handleResolveConflict = useCallback(
    (customerId: number, choice: 'kept_ours' | 'used_theirs') => {
      resolveConflicts([customerId], choice);
    },
    [resolveConflicts],
  );

  const handleBulkResolve = useCallback(
    (choice: 'kept_ours' | 'used_theirs') => {
      const selectedIds = selectedResources.map(Number);
      resolveConflicts(selectedIds, choice);
    },
    [resolveConflicts, selectedResources],
  );

  // Preparazione tabs
  const tabs = [
    {
      id: 'all',
      content: t.customers.conflicts.tabAll,
    },
  ];

  // Aggiungi la tab "Dati diversi da Klaviyo" solo se ci sono conflitti
  if (openConflictsCount > 0) {
    tabs.push({
      id: 'conflicts',
      content: t.customers.conflicts.tabConflicts(openConflictsCount),
    });
  }

  const selectedTabIndex = currentView === 'conflicts' && openConflictsCount > 0 ? 1 : 0;

  return (
    <>
        {unavailable === 'not_connected' && (
          <Banner tone="info">{t.customers.notConnected}</Banner>
        )}
        {/* Il permesso si concede riaprendo l'app: dirlo e' piu' utile di una
            tabella vuota, che sembrerebbe un negozio senza clienti. */}
        {unavailable === 'no_orders_access' && (
          <Banner tone="warning">{t.customers.noAccess}</Banner>
        )}

        {/* Il piano non prevede i clienti: si entra lo stesso e si legge
            perche' non c'e' niente. Prima la pagina falliva con un errore del
            server, che oltre a non spiegare niente riportava il tema scuro. */}
        {unavailable === 'plan_required' && (
          <Banner tone="info">
            <Text as="p">
              {/* Lo stesso invito della card dei clienti in dashboard, e lo
                  stesso comportamento: il confronto fra i due piani si apre
                  qui. Portare sulla tab Piano da questa pagina e non dall'altra
                  vorrebbe dire due risposte diverse alla stessa domanda, fatta
                  a due giorni di distanza dallo stesso merchant. */}
              <PlanUpgradeAction plan={upgradePlan} />
              {t.customers.planRequired}
            </Text>
          </Banner>
        )}

        {/* Lettura non riuscita: si dice, invece di mostrare una tabella vuota
            che sembrerebbe un negozio senza clienti. */}
        {unavailable === 'failed' && (
          <Banner tone="warning">{t.customers.loadFailed}</Banner>
        )}

        {/* Il campo "Data di nascita" sulla scheda cliente. Compare solo con un
            piano che sincronizza i clienti: senza, sarebbe un campo che il
            merchant compila e che poi non arriva da nessuna parte.
            Il riquadro rende da se' l'avviso di conferma, e non rende niente
            quando la parola passa alla riga di stato qui sotto: e' cosi' che i
            due non finiscono mai a schermo insieme. */}
        {birthdate && <BirthdateMetafieldCard {...birthdate} notice={notice} />}

        {/* Banner per errori nella risoluzione dei conflitti */}
        {/* Banner per errori nella risoluzione dei conflitti (I5) */}
        {showNotWrittenBanner && (
          <Banner tone="warning" onDismiss={() => setShowNotWrittenBanner(false)}>
            {genericError
              ? t.customers.conflicts.genericError
              : t.customers.conflicts.notWrittenWarning(notWrittenCount)}
          </Banner>
        )}

        {/* Tabs: Tutti / Dati diversi da Klaviyo (solo se ci sono conflitti) */}
        {unavailable === null && tabs.length > 1 && (
          <Tabs tabs={tabs} selected={selectedTabIndex} onSelect={handleTabChange} />
        )}

        {/* Filtri e ricerca: solo nella vista "Tutti" (I6) */}
        {unavailable === null && currentView === 'all' && (
          /* Filtri a sinistra e ricerca a destra, mezza riga ciascuno: la
             stessa forma dei prodotti non idonei, dove la ricerca finisce
             all'estrema destra senza doverla dimensionare a mano.
             alignItems="center" allinea i due lati sull'asse verticale,
             altrimenti i pulsanti si appoggerebbero in cima al campo. */
          <InlineGrid columns={2} gap="400" alignItems="center">
            <InlineStack gap="200" blockAlign="center" wrap>
              {/* Il periodo per primo: dice quali clienti si stanno guardando,
                  e va letto prima di qualsiasi riga. Resta anche con la tabella
                  vuota, che e' proprio quando serve allargarlo. */}
              <DateRangePicker
                value={range}
                timeZone={timeZone}
                onChange={choosePeriod}
                disabled={periodLoading}
                allTime
              />

              {rows.length > 0 && (
                <ButtonGroup variant="segmented">
                  <Button pressed={!onlyIssues} onClick={() => setOnlyIssues(false)}>
                    {t.customers.filterAll}
                  </Button>
                  <Button pressed={onlyIssues} onClick={() => setOnlyIssues(true)}>
                    {t.customers.filterIssues}
                  </Button>
                </ButtonGroup>
              )}

              {rows.length > 0 && onlyIssues && hiddenByFilter > 0 && (
                <Text as="span" tone="subdued" variant="bodySm">
                  {t.customers.hiddenCount(hiddenByFilter)}
                </Text>
              )}
            </InlineStack>

            {/* Tre quarti della colonna, allineata a destra: stessa misura e
                stessa impostazione della ricerca nei prodotti, cosi' le due tab
                non si somigliano soltanto — si corrispondono. */}
            <InlineStack align="end">
              {rows.length > 0 && (
                <Box width="75%">
                  <TextField
                    label={t.customers.search}
                    labelHidden
                    value={query}
                    onChange={setQuery}
                    autoComplete="off"
                    placeholder={t.customers.searchPlaceholder}
                    clearButton
                    onClearButtonClick={() => setQuery('')}
                  />
                </Box>
              )}
            </InlineStack>
          </InlineGrid>
        )}

        {/* Tabella a sinistra, campi aggiuntivi a destra.

            `alignItems="start"` e' la riga che conta: senza, la griglia allunga
            la card fino all'altezza della tabella, e accanto a cinquanta righe
            diventa una colonna vuota alta uno schermo con tre parole in cima.
            Con `start` la card e' alta quanto il suo contenuto e resta dov'e'. */}
        {unavailable === null && (
          <InlineGrid
            // Un quarto e non un terzo: dentro c'e' una riga sola, e una colonna
            // larga quanto un terzo dello schermo per tre parole sottrae spazio
            // alla tabella, che di spazio ne ha bisogno davvero.
            // Una stringa e non gli alias: `oneThird` sarebbe il 33%, e qui ne
            // serve un quarto. Polaris passa la stringa a `grid-template-columns`.
            columns={{ xs: 1, md: '3fr 1fr' }}
            gap="400"
            alignItems="start"
          >
          <Card padding="0">
            {currentView === 'all' && (
              <Box padding="400">
                <BlockStack gap="100">
                  <Text as="p" tone="subdued">
                    {t.customers.intro}
                  </Text>
                  {/* Il periodo lascia fuori qualcuno: si dice, e si dice come
                      ritrovarli. */}
                  {periodHidesSome && (
                    <Text as="p" tone="subdued" variant="bodySm">
                      {t.customers.periodHint}
                    </Text>
                  )}
                </BlockStack>
              </Box>
            )}
            {/* Le colonne non si riassestano a ogni lettera scritta nella
                ricerca: le larghezze stanno in `dashboard.css`, dichiarate una
                volta nell'ordine delle intestazioni qui sotto.
                Nella vista conflitti non usiamo stable-columns (minor fix). */}
            <div className={currentView === 'all' ? 'stable-columns stable-columns--customers' : ''}>
            <IndexTable
              resourceName={t.customers.resource}
              itemCount={CUSTOMERS_PER_PAGE}
              selectable={currentView === 'conflicts'}
              selectedItemsCount={
                currentView === 'conflicts'
                  ? allResourcesSelected
                    ? 'All'
                    : selectedResources.length
                  : undefined
              }
              onSelectionChange={currentView === 'conflicts' ? handleSelectionChange : undefined}
              promotedBulkActions={
                currentView === 'conflicts'
                  ? [
                      {
                        content: t.customers.conflicts.bulkKeepOurs,
                        onAction: () => handleBulkResolve('kept_ours'),
                        disabled: resolving,
                      },
                      {
                        content: t.customers.conflicts.bulkUseTheirs,
                        onAction: () => handleBulkResolve('used_theirs'),
                        disabled: resolving,
                      },
                    ]
                  : undefined
              }
              loading={periodLoading}
              headings={currentView === 'conflicts' ? conflictsHeadings(t) : customerHeadings(t)}
            >
              {currentView === 'conflicts' ? (
                /* Vista conflitti (I2: paginati) */
                paginatedConflicts.length === 0 ? (
                  <>
                    <IndexTable.Row id="empty-state" position={0} disabled>
                      <IndexTable.Cell colSpan={3}>
                        <Box paddingBlock="400">
                          <Text as="p" tone="subdued" alignment="center">
                            {t.customers.conflicts.noConflicts}
                          </Text>
                        </Box>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                    <FillerRows count={CUSTOMERS_PER_PAGE - 1} cols={3} start={1} />
                  </>
                ) : (
                  <>
                    {paginatedConflicts.map((row, index) => (
                      <IndexTable.Row
                        id={String(row.customerId)}
                        key={row.customerId}
                        position={index}
                        selected={selectedResources.includes(String(row.customerId))}
                      >
                        <IndexTable.Cell>
                          {row.firstName || row.email ? (
                            <Link
                              url={`${adminBase}/customers/${row.customerId}`}
                              target="_top"
                              removeUnderline
                            >
                              <Text as="span" fontWeight="semibold">
                                {row.firstName || t.customers.noName}
                              </Text>
                              {row.email && (
                                <Text as="p" variant="bodySm" tone="subdued">
                                  {row.email}
                                </Text>
                              )}
                            </Link>
                          ) : (
                            <Text as="span" tone="subdued">
                              ID {row.customerId}
                            </Text>
                          )}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <BlockStack gap="100">
                            <Text as="span" variant="bodySm">
                              {row.ours === null
                                ? t.customers.conflicts.ourValue(t.customers.conflicts.notSet)
                                : t.customers.conflicts.ourValue(formatConflictDate(row.ours, locale))}
                            </Text>
                            <Text as="span" variant="bodySm">
                              {t.customers.conflicts.theirValue(formatConflictDate(row.theirs, locale))}
                            </Text>
                          </BlockStack>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <InlineStack gap="200">
                            <Button
                              size="slim"
                              onClick={() => handleResolveConflict(row.customerId, 'kept_ours')}
                              disabled={resolving}
                            >
                              {t.customers.conflicts.keepOurs}
                            </Button>
                            <Button
                              size="slim"
                              onClick={() => handleResolveConflict(row.customerId, 'used_theirs')}
                              disabled={resolving}
                            >
                              {t.customers.conflicts.useTheirs}
                            </Button>
                          </InlineStack>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                    <FillerRows
                      count={Math.max(0, CUSTOMERS_PER_PAGE - paginatedConflicts.length)}
                      cols={3}
                      start={paginatedConflicts.length}
                    />
                  </>
                )
              ) : (
                /* Vista normale "Tutti" */
                visibleRows.length === 0 ? (
                  <>
                    {/* Messaggio quando non ci sono dati, centrato sotto le intestazioni */}
                    <IndexTable.Row id="empty-state" position={0} disabled>
                      <IndexTable.Cell colSpan={7}>
                        <Box paddingBlock="400">
                          <Text as="p" tone="subdued" alignment="center">
                            {noSearchResults
                              ? t.customers.searchNoResults(query.trim())
                              : t.customers.empty}
                          </Text>
                        </Box>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                    <FillerRows count={CUSTOMERS_PER_PAGE - 1} cols={7} start={1} />
                  </>
                ) : (
                  <>
                    {visibleRows.map((row, index) => (
                      <IndexTable.Row id={String(row.customerId)} key={row.customerId} position={index}>
                        <IndexTable.Cell>
                          {/* Il nome porta alla scheda del cliente. _top e non
                              _blank: dentro l'admin il target nuovo aprirebbe una
                              finestra spoglia, senza il menu di Shopify intorno. */}
                          <Link
                            url={`${adminBase}/customers/${row.customerId}`}
                            target="_top"
                            removeUnderline
                          >
                            <Text as="span" fontWeight="semibold">
                              {[row.firstName, row.lastName].filter(Boolean).join(' ') ||
                                t.customers.noName}
                            </Text>
                          </Link>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {/* Il profitto di questa riga e' completo, oppure e'
                              calcolato su prodotti di cui non si conosce il costo.
                              L'icona lo dice senza occupare una riga di testo sotto
                              ogni nome: la spiegazione sta nel tooltip, per chi la
                              cerca. */}
                          <InlineStack align="center">
                            <Tooltip
                              content={
                                row.coveredLines < row.totalLines
                                  ? t.customers.warning(row.totalLines - row.coveredLines)
                                  : t.customers.allGood
                              }
                            >
                              <Icon
                                source={
                                  row.coveredLines < row.totalLines ? AlertCircleIcon : CheckCircleIcon
                                }
                                tone={row.coveredLines < row.totalLines ? 'warning' : 'success'}
                              />
                            </Tooltip>
                          </InlineStack>
                        </IndexTable.Cell>
                        <IndexTable.Cell>{row.orders}</IndexTable.Cell>
                        <IndexTable.Cell>
                          {row.averageOrderProfit == null
                            ? '—'
                            : formatMoney(row.averageOrderProfit, currency, locale)}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <InlineStack gap="200" blockAlign="center" wrap={false}>
                            <Text as="span">{formatMoney(row.lifetimeProfit, currency, locale)}</Text>
                            {row.profitChange != null && (
                              <Text
                                as="span"
                                variant="bodySm"
                                tone={row.profitChange >= 0 ? 'success' : 'critical'}
                              >
                                {row.profitChange >= 0 ? '+' : ''}
                                {row.profitChange}%
                              </Text>
                            )}
                          </InlineStack>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Badge tone={row.synced ? 'success' : 'warning'}>
                            {row.synced ? t.customers.synced : t.customers.notSynced}
                          </Badge>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {row.coveredLines < row.totalLines && (
                            <div style={{ display: 'flex', alignItems: 'center', height: '20px', lineHeight: 0 }}>
                              {clienteInApertura === String(row.customerId) ? (
                                <Spinner size="small" accessibilityLabel={t.customers.fixIssues} />
                              ) : (
                                <Link url={`/products/issues?customer=${row.customerId}`} removeUnderline>
                                  {t.customers.fixIssues}
                                </Link>
                              )}
                            </div>
                          )}
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                    <FillerRows
                      count={Math.max(0, CUSTOMERS_PER_PAGE - visibleRows.length)}
                      cols={7}
                      start={visibleRows.length}
                    />
                  </>
                )
              )}
            </IndexTable>
            </div>
            <TablePagination
              total={currentView === 'conflicts' ? conflictRowsData.length : matching.length}
              page={currentView === 'conflicts' ? conflictsPage : page}
              onPage={currentView === 'conflicts' ? setConflictsPage : setPage}
              perPage={CUSTOMERS_PER_PAGE}
            />
          </Card>

          <BlockStack gap="400">
            {birthdate && notice.view === 'status' && (
              <ExtraFieldsCard>
                <BirthdateStatusRow active={birthdate.state === 'in_use'} onOpen={notice.open} />
              </ExtraFieldsCard>
            )}
            <IntegrationsCard
              integrations={integrations}
              upgradePlan={upgradePlan}
              onManage={handleManage}
            />
          </BlockStack>
          </InlineGrid>
        )}

        <IntegrationsModal
          open={integrationsModalOpen}
          onClose={handleCloseModal}
          preselected={preselectedProvider}
        />
    </>
  );
}

export default function Customers() {
  const { data, customersIncluded, upgradePlan, adminBase, range, timeZone } =
    useLoaderData<typeof loader>();
  const t = useT();

  return (
    <Page
      fullWidth
      title={t.customers.title}
      backAction={{ url: '/' }}
      // Il periodo si vede, sopra la tabella. Senza, la pagina ne usava uno
      // che nessuno aveva scelto e che non si leggeva da nessuna parte, e i
      // clienti che avevano ordinato prima sparivano in silenzio.
    >
      <BlockStack gap="400">
        {/* Il cambio di piano si legge da ogni tab, non solo da dove e' stato
            fatto: chi lo cambia e va dritto qui deve sapere lo stesso cosa e'
            cambiato. Il contenuto lo calcola la dashboard e lo lascia nel
            sessionStorage; se non c'e' niente da dire, questo non rende nulla. */}
        <PlanChangeBanner />

        <ProductOverflowBanner />

        {/* I clienti arrivano dopo la pagina: intanto si vede la sua forma. */}
        <Suspense
          fallback={
            <CustomersSkeleton range={range} timeZone={timeZone} withPeriod={customersIncluded} />
          }
        >
          <Await
            resolve={data}
            // Non dovrebbe succedere — le letture gestiscono da se' i propri
            // guasti — ma se succede si dice come per una lettura fallita,
            // invece di lasciare lo scheletro a girare per sempre.
            errorElement={<Banner tone="warning">{t.customers.loadFailed}</Banner>}
          >
            {(view) => (
              <CustomersContent
                view={view}
                upgradePlan={upgradePlan}
                adminBase={adminBase}
                range={range}
                timeZone={timeZone}
              />
            )}
          </Await>
        </Suspense>
      </BlockStack>
      <Box paddingBlockEnd="800" />
    </Page>
  );
}

/**
 * La forma della tab mentre i clienti arrivano: il periodo, gia' leggibile, e
 * la tabella con le sue intestazioni e righe in attesa, alta quanto sara'.
 * Cosi' quando i dati arrivano non si sposta niente.
 */
function CustomersSkeleton({
  range,
  timeZone,
  withPeriod,
}: {
  range: DateRange;
  timeZone: string | null;
  withPeriod: boolean;
}) {
  const t = useT();
  return (
    <>
      {withPeriod && (
        <InlineStack gap="200" blockAlign="center">
          <DateRangePicker
            value={range}
            timeZone={timeZone}
            onChange={() => {}}
            disabled
            allTime
          />
        </InlineStack>
      )}
      <InlineGrid columns={{ xs: 1, md: '3fr 1fr' }} gap="400" alignItems="start">
        <Card padding="0">
          <Box padding="400">
            <Text as="p" tone="subdued">
              {t.customers.intro}
            </Text>
          </Box>
          <div className="stable-columns stable-columns--customers">
            <IndexTable
              resourceName={t.customers.resource}
              itemCount={CUSTOMERS_PER_PAGE}
              selectable={false}
              loading
              headings={customerHeadings(t)}
            >
              {Array.from({ length: CUSTOMERS_PER_PAGE }, (_, i) => (
                <IndexTable.Row key={`skeleton-${i}`} id={`skeleton-${i}`} position={i} disabled>
                  {Array.from({ length: 7 }, (_, colIdx) => (
                    <IndexTable.Cell key={colIdx}>
                      <SkeletonBodyText lines={1} />
                    </IndexTable.Cell>
                  ))}
                </IndexTable.Row>
              ))}
            </IndexTable>
          </div>
        </Card>
      </InlineGrid>
    </>
  );
}
