import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';
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
  InlineStack,
  Link,
  Page,
  Text,
  Tooltip,
} from '@shopify/polaris';
import { AlertCircleIcon, CheckCircleIcon } from '@shopify/polaris-icons';
import { PlanChangeBanner } from '~/components/Dashboard/PlanChangeBanner';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { firstPlanWithCustomersSync, planLabel } from '~/components/Dashboard/account-format';
import { BASE_CURRENCY } from '~/lib/billing/money';
import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import { loadCustomersReport } from '~/lib/customers/customers.server';
import { isCalendarDate } from '~/lib/customers/customers-query';
import { formatMoney } from '~/lib/billing/money';
import { useLocale, useT } from '~/lib/i18n/context';
import { ProductOverflowBanner } from '~/components/Dashboard/ProductOverflowBanner';

/** Il mese in corso: il periodo che quasi tutti guardano per primo. */
function currentMonth(now = new Date()): { from: string; to: string } {
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from: first.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  await requireSetupComplete(session.shop);

  // Le date arrivano dalla URL, quindi da fuori: quello che non e' una data si
  // ignora e si torna al mese in corso, invece di far fallire la pagina.
  const params = new URL(request.url).searchParams;
  const wanted = { from: params.get('from') ?? '', to: params.get('to') ?? '' };
  const range =
    isCalendarDate(wanted.from) && isCalendarDate(wanted.to) && wanted.from <= wanted.to
      ? wanted
      : currentMonth();

  // Il piano decide se questa tabella ha qualcosa da mostrare. Senza la
  // sincronizzazione clienti la tabella nel database del merchant non esiste
  // nemmeno, e la query falliva con un 400 che arrivava fino a schermo come
  // "Unexpected Server Error" — con la pagina d'errore che, per giunta, torna
  // scura. Meglio entrare e trovare scritto perche' non c'e' niente.
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { currentPlan: true },
  });
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
    // Per aprire la scheda del cliente: da qui il merchant vede l'anagrafica
    // vera, ed e' il gesto che segue la lettura di una riga.
    adminBase: `https://admin.shopify.com/store/${session.shop.replace('.myshopify.com', '')}`,
  });
}

export default function Customers() {
  const { rows, currency, unavailable, upgradePlan, adminBase } = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();

  // Il filtro sta in uno stato e non nell'indirizzo: non ricarica niente —
  // le righe sono gia' tutte qui — e passare dal server per nascondere delle
  // righe che si hanno gia' sarebbe un viaggio per nulla.
  const [onlyIssues, setOnlyIssues] = useState(false);

  const needsWork = (row: { coveredLines: number; totalLines: number }) =>
    row.coveredLines < row.totalLines;
  const visibleRows = onlyIssues ? rows.filter(needsWork) : rows;
  const hiddenByFilter = rows.length - visibleRows.length;

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
              <Link url="/plan" removeUnderline>
                {t.account.upgradeTo(planLabel(upgradePlan))}
              </Link>
              {t.customers.planRequired}
            </Text>
          </Banner>
        )}

        {/* Lettura non riuscita: si dice, invece di mostrare una tabella vuota
            che sembrerebbe un negozio senza clienti. */}
        {unavailable === 'failed' && (
          <Banner tone="warning">{t.customers.loadFailed}</Banner>
        )}

        {/* Due filtri, come nei prodotti non idonei: a sinistra, sopra la
            tabella. "Richiedono un intervento" tiene solo le righe con la spia
            gialla — quelle il cui profitto e' calcolato su prodotti senza
            costo. Sono le uniche su cui c'e' qualcosa da fare, e in un elenco
            lungo si perdono fra quelle a posto. */}
        {unavailable === null && rows.length > 0 && (
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
                    {t.customers.empty}
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
