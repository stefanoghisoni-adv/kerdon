import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useFetcher, useLoaderData } from '@remix-run/react';
import { useState } from 'react';
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
  Text,
  TextField,
  Tooltip,
} from '@shopify/polaris';
import { AlertCircleIcon, CheckCircleIcon } from '@shopify/polaris-icons';
import { PlanChangeBanner } from '~/components/Dashboard/PlanChangeBanner';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { firstPlanWithCustomersSync } from '~/components/Dashboard/account-format';
import { BASE_CURRENCY } from '~/lib/billing/money';
import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import { loadCustomersReport } from '~/lib/customers/customers.server';
import { isCalendarDate } from '~/lib/customers/customers-query';
import { defaultRange } from '~/lib/dates/ranges';
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
import { ShopifyAPIClient } from '~/lib/shopify-api.server';
import {
  BIRTHDATE_METAFIELD_KEY,
  birthdateFieldState,
  birthdateMetafieldOf,
  formatMetafieldKey,
  isDateMetafieldType,
  parseMetafieldKey,
} from '~/lib/customers/birthdate-metafield';
import { customerMetafieldsUrl, storeHandle } from '~/utils/admin-page';


export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  await requireSetupComplete(session.shop);

  // Le date arrivano dalla URL, quindi da fuori: quello che non e' una data si
  // ignora e si torna al mese in corso, invece di far fallire la pagina.
  const params = new URL(request.url).searchParams;
  const wanted = { from: params.get('from') ?? '', to: params.get('to') ?? '' };
  const rangeFromUrl =
    isCalendarDate(wanted.from) && isCalendarDate(wanted.to) && wanted.from <= wanted.to
      ? wanted
      : null;

  // Il piano decide se questa tabella ha qualcosa da mostrare. Senza la
  // sincronizzazione clienti la tabella nel database del merchant non esiste
  // nemmeno, e la query falliva con un 400 che arrivava fino a schermo come
  // "Unexpected Server Error" — con la pagina d'errore che, per giunta, torna
  // scura. Meglio entrare e trovare scritto perche' non c'e' niente.
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: {
      currentPlan: true,
      ianaTimezone: true,
      birthdateMetafieldNamespace: true,
      birthdateMetafieldKey: true,
    },
  });

  // Il periodo di partenza si sceglie dopo aver letto il negozio, perche' senza
  // il suo fuso "gli ultimi 30 giorni" finiscono nel giorno di qualcun altro.
  const range = rangeFromUrl ?? defaultRange(shop?.ianaTimezone ?? null);
  const plan = await findPlanByName(shop?.currentPlan);
  const customersIncluded = plan?.customersSyncEnabled ?? false;

  let upgradePlan: string | null = null;
  if (!customersIncluded) {
    const [plans, basePrices] = await Promise.all([
      prisma.plan.findMany(),
      prisma.planPrice.findMany({ where: { currency: BASE_CURRENCY } }),
    ]);
    const monthlyOf = new Map(basePrices.map((row) => [row.planName, Number(row.priceMonthly)]));
    upgradePlan = firstPlanWithCustomersSync(
      plans.map((p) => ({
        planName: p.planName,
        priceMonthly: monthlyOf.get(p.planName) ?? 0,
        customersSyncEnabled: p.customersSyncEnabled,
      })),
      shop?.currentPlan ?? null,
    );
  }

  // I campi personalizzati che il negozio ha sui clienti.
  //
  // Una domanda sola a Shopify, che pero' ne risolve due: riempie la tendina da
  // cui il merchant indica un campo che ha gia', e dice se il nostro c'e' —
  // quest'ultima e' una rilevazione vera, non la deduzione da un tentativo di
  // scrittura andato a vuoto. Chi il campo ce l'ha gia' deve vederselo scritto
  // senza che l'app provi a scrivergli addosso per scoprirlo.
  //
  // Un guasto qui non porta via la pagina: l'elenco resta vuoto e il pulsante
  // si comporta come se il campo mancasse. Crearlo due volte non fa danno,
  // Shopify risponde che quella chiave e' gia' occupata.
  let definitions: { key: string; name: string; type: string }[] = [];
  let definitionsRead = false;
  if (customersIncluded) {
    definitions = await ShopifyAPIClient.forShop(session.shop)
      .then((client) => client.listCustomerMetafieldDefinitions())
      .then((list) => {
        definitionsRead = true;
        return list.map((d) => ({
          key: formatMetafieldKey(d),
          name: d.name,
          type: d.type,
        }));
      })
      .catch((error) => {
        console.warn(
          '[customers] campi personalizzati dei clienti non leggibili:',
          error instanceof Error ? error.message : 'errore sconosciuto',
        );
        return [];
      });
  }

  const configured = birthdateMetafieldOf(shop);
  const configuredKey = formatMetafieldKey(configured);
  const configuredDefinition = definitions.find((d) => d.key === configuredKey);

  // Anche col piano giusto una lettura puo' fallire — tabella non ancora
  // creata, progetto irraggiungibile. Un guasto sul database del merchant non
  // deve diventare una pagina d'errore dell'app.
  const report = customersIncluded
    ? await loadCustomersReport({ shopDomain: session.shop, ...range }).catch((error) => {
        console.warn(
          '[customers] lettura non riuscita:',
          error instanceof Error ? error.message : 'errore sconosciuto',
        );
        return { rows: [], currency: 'EUR', unavailable: 'failed' as const };
      })
    : { rows: [], currency: 'EUR', unavailable: 'plan_required' as const };

  return json({
    ...report,
    upgradePlan,
    range,
    // Il riquadro del campo "Data di nascita": c'e' solo con un piano che
    // sincronizza i clienti, perche' senza quel piano il campo non arriverebbe
    // da nessuna parte e il merchant lo compilerebbe per niente.
    birthdate: customersIncluded
      ? {
          /** Il campo da cui si legge oggi, vuoto se non ne e' stato scelto uno. */
          configured: configuredKey,
          /**
           * Nessuno, in uso, oppure scelto ma non presente sul negozio.
           *
           * Lo decide il server perche' e' l'unico ad avere in mano tutt'e due
           * le meta' della domanda: la scelta salvata e l'elenco vero delle
           * definizioni. L'elenco non letto vale `null` e non "vuoto" — non
           * sapere non e' lo stesso che sapere di no, e su un dubbio non si
           * smentisce una configurazione che il merchant ha fatto davvero.
           */
          state: birthdateFieldState(
            configuredKey,
            definitionsRead ? definitions.map((d) => d.key) : null,
          ),
          /** La nostra definizione esiste gia' sul negozio? */
          ourDefinitionPresent: definitionsRead
            ? definitions.some((d) => d.key === formatMetafieldKey(BIRTHDATE_METAFIELD_KEY))
            : null,
          definitions,
          /**
           * Il campo in uso non contiene una data: si avvisa, perche' da un
           * testo libero la data si ricava solo se e' scritta in modo
           * riconoscibile, e quello che non lo e' lascia la colonna vuota.
           * Nessun avviso quando il campo non e' fra le definizioni: di quello
           * non si conosce il tipo, e un avviso a caso e' peggio di nessuno.
           */
          notADate: configuredDefinition != null && !isDateMetafieldType(configuredDefinition.type),
          adminUrl: customerMetafieldsUrl(session.shop),
        }
      : null,
    // Per aprire la scheda del cliente: da qui il merchant vede l'anagrafica
    // vera, ed e' il gesto che segue la lettura di una riga.
    adminBase: `https://admin.shopify.com/store/${storeHandle(session.shop)}`,
  });
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
  const { session } = await authenticate.admin(request);

  if (request.method !== 'POST') {
    return json({ ok: false as const, error: 'failed' as const }, { status: 405 });
  }

  // Lo stesso cancello del riquadro, ripetuto qui: quello nasconde i comandi,
  // questo nega l'azione. Una richiesta non arriva per forza da un pulsante.
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { currentPlan: true },
  });
  const plan = await findPlanByName(shop?.currentPlan);
  if (!plan?.customersSyncEnabled) {
    return json({ ok: false as const, error: 'failed' as const }, { status: 403 });
  }

  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');

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

export default function Customers() {
  const { rows, currency, unavailable, upgradePlan, adminBase, birthdate } =
    useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();

  // Il filtro sta in uno stato e non nell'indirizzo: non ricarica niente —
  // le righe sono gia' tutte qui — e passare dal server per nascondere delle
  // righe che si hanno gia' sarebbe un viaggio per nulla. Vale anche per la
  // ricerca, che lavora sulle stesse righe.
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [query, setQuery] = useState('');

  // Della data di nascita si vede una cosa sola alla volta: il riquadro con cui
  // si sceglie il campo, l'avviso che conferma la scelta appena fatta, o la
  // riga di stato qui sopra la tabella. Chi decide quale sta nell'hook, non
  // qui: lo stesso verdetto serve al riquadro e alla riga, e due copie della
  // stessa regola sono due cose da tenere allineate. Chiamato sempre, anche
  // senza il riquadro da mostrare: un hook non si salta.
  const notice = useBirthdateNotice(birthdate?.configured ?? '', birthdate?.state ?? 'none');

  const needsWork = (row: { coveredLines: number; totalLines: number }) =>
    row.coveredLines < row.totalLines;
  const filtered = onlyIssues ? rows.filter(needsWork) : rows;
  const hiddenByFilter = rows.length - filtered.length;
  const visibleRows = filtered.filter((row) => matchesCustomerSearch(row, query));
  // Con una ricerca senza risultati la tabella resta vuota: senza dirlo
  // sembrerebbe un negozio senza clienti, mentre e' solo la ricerca a non aver
  // trovato nulla.
  const noSearchResults = query.trim().length > 0 && visibleRows.length === 0;

  return (
    <Page
      fullWidth
      title={t.customers.title}
      backAction={{ url: '/' }}
      // Niente selettore di date qui: il periodo si sceglie in dashboard, ed
      // e' li' che si guarda l'andamento. Questa tabella risponde a un'altra
      // domanda — chi sono i clienti e quanto rendono — e due selettori in due
      // pagine, ognuno col suo periodo, facevano leggere numeri diversi
      // credendoli lo stesso numero.
    >
      <BlockStack gap="400">
        {/* Il cambio di piano si legge da ogni tab, non solo da dove e' stato
            fatto: chi lo cambia e va dritto qui deve sapere lo stesso cosa e'
            cambiato. Il contenuto lo calcola la dashboard e lo lascia nel
            sessionStorage; se non c'e' niente da dire, questo non rende nulla. */}
        <PlanChangeBanner />

        <ProductOverflowBanner />

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

        {/* Sopra la tabella, dove si guardano i clienti: e' li' che viene in
            mente di volerne sapere la data di nascita. Sta nello stesso posto
            del riquadro perche' e' la stessa cosa detta in breve — l'una al
            posto dell'altro, mai le due insieme. */}
        {birthdate && notice.view === 'status' && (
          <BirthdateStatusRow active={birthdate.state === 'in_use'} onOpen={notice.open} />
        )}

        {/* Due filtri, come nei prodotti non idonei: a sinistra, sopra la
            tabella. "Richiedono un intervento" tiene solo le righe con la spia
            gialla — quelle il cui profitto e' calcolato su prodotti senza
            costo. Sono le uniche su cui c'e' qualcosa da fare, e in un elenco
            lungo si perdono fra quelle a posto. */}
        {unavailable === null && rows.length > 0 && (
          /* Filtri a sinistra e ricerca a destra, mezza riga ciascuno: la
             stessa forma dei prodotti non idonei, dove la ricerca finisce
             all'estrema destra senza doverla dimensionare a mano.
             alignItems="center" allinea i due lati sull'asse verticale,
             altrimenti i pulsanti si appoggerebbero in cima al campo. */
          <InlineGrid columns={2} gap="400" alignItems="center">
            <InlineStack gap="200" blockAlign="center" wrap>
              <ButtonGroup variant="segmented">
                <Button pressed={!onlyIssues} onClick={() => setOnlyIssues(false)}>
                  {t.customers.filterAll}
                </Button>
                <Button pressed={onlyIssues} onClick={() => setOnlyIssues(true)}>
                  {t.customers.filterIssues}
                </Button>
              </ButtonGroup>

              {onlyIssues && hiddenByFilter > 0 && (
                <Text as="span" tone="subdued" variant="bodySm">
                  {t.customers.hiddenCount(hiddenByFilter)}
                </Text>
              )}
            </InlineStack>

            {/* Tre quarti della colonna, allineata a destra: stessa misura e
                stessa impostazione della ricerca nei prodotti, cosi' le due tab
                non si somigliano soltanto — si corrispondono. */}
            <InlineStack align="end">
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
            </InlineStack>
          </InlineGrid>
        )}

        {unavailable === null && (
          <Card padding="0">
            <Box padding="400">
              <Text as="p" tone="subdued">
                {t.customers.intro}
              </Text>
            </Box>
            <IndexTable
              resourceName={t.customers.resource}
              itemCount={visibleRows.length}
              selectable={false}
              headings={[
                { title: t.customers.columns.customer },
                // Senza intestazione: e' una spia, non un dato. Un titolo sopra
                // due icone chiederebbe di leggere una parola per capire un
                // segno che si capisce gia' da solo.
                { title: '', alignment: 'center' as const },
                { title: t.customers.columns.orders },
                { title: t.customers.columns.aop },
                { title: t.customers.columns.ltp },
                { title: t.customers.columns.status },
                { title: t.customers.columns.actions },
              ]}
              emptyState={
                <Box padding="600">
                  <Text as="p" tone="subdued" alignment="center">
                    {noSearchResults
                      ? t.customers.searchNoResults(query.trim())
                      : t.customers.empty}
                  </Text>
                </Box>
              }
            >
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
                      <Link url={`/products/issues?customer=${row.customerId}`} removeUnderline>
                        {t.customers.fixIssues}
                      </Link>
                    )}
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        )}
      </BlockStack>
      <Box paddingBlockEnd="800" />
    </Page>
  );
}
