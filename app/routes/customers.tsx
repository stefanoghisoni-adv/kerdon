import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
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
import { authenticate } from '~/shopify.server';
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

  const report = await loadCustomersReport({ shopDomain: session.shop, ...range });

  return json({
    ...report,
    range,
    // Per aprire la scheda del cliente: da qui il merchant vede l'anagrafica
    // vera, ed e' il gesto che segue la lettura di una riga.
    adminBase: `https://admin.shopify.com/store/${session.shop.replace('.myshopify.com', '')}`,
  });
}

export default function Customers() {
  const { rows, currency, unavailable, range, adminBase } = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();
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
        <ProductOverflowBanner />

        {unavailable === 'not_connected' && (
          <Banner tone="info">{t.customers.notConnected}</Banner>
        )}
        {/* Il permesso si concede riaprendo l'app: dirlo e' piu' utile di una
            tabella vuota, che sembrerebbe un negozio senza clienti. */}
        {unavailable === 'no_orders_access' && (
          <Banner tone="warning">{t.customers.noAccess}</Banner>
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
              itemCount={rows.length}
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
              {rows.map((row, index) => (
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
