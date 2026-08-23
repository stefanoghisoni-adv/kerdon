import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useLoaderData, useSearchParams } from '@remix-run/react';
import { useCallback, useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DatePicker,
  IndexTable,
  InlineStack,
  Page,
  Popover,
  Text,
} from '@shopify/polaris';
import { CalendarIcon } from '@shopify/polaris-icons';
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

  return json({ ...report, range });
}

export default function Customers() {
  const { rows, currency, unavailable, range } = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();
  const [, setSearchParams] = useSearchParams();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [selected, setSelected] = useState({
    start: new Date(`${range.from}T00:00:00Z`),
    end: new Date(`${range.to}T00:00:00Z`),
  });
  const [{ month, year }, setMonth] = useState({
    month: new Date(`${range.to}T00:00:00Z`).getUTCMonth(),
    year: new Date(`${range.to}T00:00:00Z`).getUTCFullYear(),
  });

  const apply = useCallback(() => {
    setPickerOpen(false);
    setSearchParams({
      from: selected.start.toISOString().slice(0, 10),
      to: selected.end.toISOString().slice(0, 10),
    });
  }, [selected, setSearchParams]);

  const rangeLabel = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-US', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    return `${fmt.format(new Date(`${range.from}T00:00:00Z`))} – ${fmt.format(
      new Date(`${range.to}T00:00:00Z`),
    )}`;
  }, [range, locale]);

  return (
    <Page
      fullWidth
      title={t.customers.title}
      backAction={{ url: '/' }}
      secondaryActions={
        <Popover
          active={pickerOpen}
          preferredAlignment="right"
          onClose={() => setPickerOpen(false)}
          activator={
            <Button icon={CalendarIcon} disclosure onClick={() => setPickerOpen((o) => !o)}>
              {rangeLabel}
            </Button>
          }
        >
          <Box padding="300" minWidth="320px">
            <BlockStack gap="300">
              <DatePicker
                month={month}
                year={year}
                selected={selected}
                onMonthChange={(m, y) => setMonth({ month: m, year: y })}
                onChange={(next) => setSelected({ start: next.start, end: next.end })}
                allowRange
              />
              <InlineStack align="end">
                <Button variant="primary" onClick={apply}>
                  {t.customers.apply}
                </Button>
              </InlineStack>
            </BlockStack>
          </Box>
        </Popover>
      }
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
                { title: t.customers.columns.orders },
                { title: t.customers.columns.aop },
                { title: t.customers.columns.ltp },
                { title: t.customers.columns.status },
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
                    <BlockStack gap="050">
                      <Text as="span" fontWeight="semibold">
                        {[row.firstName, row.lastName].filter(Boolean).join(' ') ||
                          t.customers.noName}
                      </Text>
                      {/* Quante righe non hanno ancora un costo: senza questa
                          nota il profitto sembrerebbe completo mentre e'
                          parziale. */}
                      {row.coveredLines < row.totalLines && (
                        <Text as="span" tone="subdued" variant="bodySm">
                          {t.customers.partial(row.coveredLines, row.totalLines)}
                        </Text>
                      )}
                    </BlockStack>
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
