import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from '@remix-run/node';
import { defer, json } from '@remix-run/node';
import { Await, useLoaderData, useNavigation, useSearchParams } from '@remix-run/react';
import { Suspense, useEffect, useState } from 'react';
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
  Text,
  TextField,
  Tooltip,
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
    ? startCustomersPageData({ shopDomain: session.shop, shop, range, timing })
    : {
        report: { rows: [], currency: 'EUR', lifetimeCustomers: 0, unavailable: 'plan_required' },
        // Il riquadro del campo "Data di nascita" c'e' solo con un piano che
        // sincronizza i clienti: senza, il campo non arriverebbe da nessuna
        // parte e il merchant lo compilerebbe per niente.
        birthdate: null,
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

/** Cio' che la pagina riceve quando i dati sono arrivati. */
interface CustomersPageView {
  report: CustomersReport;
  birthdate: BirthdateData | null;
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

  // Il filtro sta in uno stato e non nell'indirizzo: non ricarica niente —
  // le righe sono gia' tutte qui — e passare dal server per nascondere delle
  // righe che si hanno gia' sarebbe un viaggio per nulla. Vale anche per la
  // ricerca, che lavora sulle stesse righe.
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [query, setQuery] = useState('');

  // Il periodo invece sta nell'indirizzo: cambiarlo vuol dire chiedere al
  // database altri ordini, e il caricamento lo legge da li'. Si toccano solo
  // `from` e `to`: gli altri parametri (quelli con cui l'admin apre l'app)
  // restano dove sono. Ricerca e filtro restano quelli scelti.
  const [searchParams, setSearchParams] = useSearchParams();
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

        {/* Due filtri, come nei prodotti non idonei: a sinistra, sopra la
            tabella. "Richiedono un intervento" tiene solo le righe con la spia
            gialla — quelle il cui profitto e' calcolato su prodotti senza
            costo. Sono le uniche su cui c'e' qualcosa da fare, e in un elenco
            lungo si perdono fra quelle a posto. */}
        {unavailable === null && (
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
            {/* Le colonne non si riassestano a ogni lettera scritta nella
                ricerca: le larghezze stanno in `dashboard.css`, dichiarate una
                volta nell'ordine delle intestazioni qui sotto. */}
            <div className="stable-columns stable-columns--customers">
            <IndexTable
              resourceName={t.customers.resource}
              itemCount={CUSTOMERS_PER_PAGE}
              selectable={false}
              loading={periodLoading}
              headings={customerHeadings(t)}
            >
              {visibleRows.length === 0 ? (
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
                  {/* Righe di riempimento per mantenere l'altezza costante */}
                  {Array.from({ length: CUSTOMERS_PER_PAGE - 1 }, (_, i) => (
                    <IndexTable.Row
                      key={`filler-${i}`}
                      id={`filler-${i}`}
                      position={i + 1}
                      disabled
                    >
                      {Array.from({ length: 7 }, (_, colIdx) => (
                        <IndexTable.Cell key={colIdx}>
                          <span aria-hidden="true" style={{ visibility: 'hidden' }}>
                            &nbsp;
                          </span>
                        </IndexTable.Cell>
                      ))}
                    </IndexTable.Row>
                  ))}
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
                          {/* La variazione sul periodo precedente, in grigio quando
                              non c'e' nulla da confrontare: verde e rosso dicono da
                              soli in che direzione si sta andando. */}
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
                        {/* Solo dove c'e' qualcosa da risolvere. Un comando su ogni
                            riga, anche su quelle a posto, si smette di leggere: e'
                            la riga senza comando che deve saltare all'occhio. */}
                        {/* Il cliente viaggia nell'indirizzo: di la' l'elenco si
                            restringe ai soli prodotti che compaiono nei SUOI
                            ordini. Chi preme "Risolvi problemi" da questa riga
                            vuole sistemare il profitto di questo cliente, non fare
                            le pulizie di primavera nel catalogo. */}
                        {row.coveredLines < row.totalLines && (
                          // Altezza esatta e lineHeight 0: lo Spinner di Polaris 13.9.5 rende
                          // uno span inline con svg inline, che poggia sulla baseline lasciando
                          // sotto lo spazio per i discendenti del line box (~4-5px). Il flex con
                          // height fissa e lineHeight 0 elimina quel gap, mantenendo l'altezza
                          // costante quando il Link diventa Spinner.
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
                  {/* Righe di riempimento per mantenere l'altezza costante */}
                  {Array.from({ length: Math.max(0, CUSTOMERS_PER_PAGE - visibleRows.length) }, (_, i) => (
                    <IndexTable.Row
                      key={`filler-${i}`}
                      id={`filler-${i}`}
                      position={visibleRows.length + i}
                      disabled
                    >
                      {Array.from({ length: 7 }, (_, colIdx) => (
                        <IndexTable.Cell key={colIdx}>
                          <span aria-hidden="true" style={{ visibility: 'hidden' }}>
                            &nbsp;
                          </span>
                        </IndexTable.Cell>
                      ))}
                    </IndexTable.Row>
                  ))}
                </>
              )}
            </IndexTable>
            </div>
            <TablePagination total={matching.length} page={page} onPage={setPage} perPage={CUSTOMERS_PER_PAGE} />
          </Card>

          {birthdate && notice.view === 'status' && (
            <ExtraFieldsCard>
              <BirthdateStatusRow active={birthdate.state === 'in_use'} onOpen={notice.open} />
            </ExtraFieldsCard>
          )}
          </InlineGrid>
        )}
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
