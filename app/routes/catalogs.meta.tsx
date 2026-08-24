import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useFetcher, useLoaderData } from '@remix-run/react';
import { useMemo, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  EmptySearchResult,
  Icon,
  IndexTable,
  InlineStack,
  Link,
  Modal,
  Page,
  Text,
  TextField,
  Thumbnail,
  Tooltip,
} from '@shopify/polaris';
import { AlertTriangleIcon, DisabledIcon, ImageIcon, SearchIcon } from '@shopify/polaris-icons';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import {
  disableFeed,
  enableFeed,
  feedUrl,
  getFeed,
  isFeedFormat,
  rotateToken,
  type FeedFormat,
} from '~/lib/feeds/feed.server';
import { loadCatalogReport } from '~/lib/feeds/catalog.server';
import { severityOf, type IssueCode } from '~/lib/feeds/meta';
import { MetaLogo } from '~/components/Catalogs/MetaLogo';
import { CopyIconButton } from '~/components/Dashboard/CopyIconButton';
import { formatMoney } from '~/lib/billing/money';
import { useLocale, useT } from '~/lib/i18n/context';

async function shopId(shopDomain: string): Promise<string | null> {
  const shop = await prisma.shop.findUnique({ where: { shopDomain }, select: { id: true } });
  return shop?.id ?? null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  await requireSetupComplete(session.shop);

  const id = await shopId(session.shop);
  if (!id) throw new Response('Not found', { status: 404 });

  const [feed, catalog] = await Promise.all([getFeed(id, 'meta'), loadCatalogReport(id)]);

  return json({
    feed,
    url: feed ? feedUrl(feed.token, feed.format) : null,
    catalog,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  await requireSetupComplete(session.shop);

  const id = await shopId(session.shop);
  if (!id) return json({ ok: false }, { status: 404 });

  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const rawFormat = String(form.get('format') ?? 'xml');
  const format: FeedFormat = isFeedFormat(rawFormat) ? rawFormat : 'xml';

  switch (intent) {
    case 'enable':
      await enableFeed(id, 'meta', format);
      break;
    case 'format':
      await enableFeed(id, 'meta', format);
      break;
    case 'disable':
      await disableFeed(id, 'meta');
      break;
    case 'rotate':
      await rotateToken(id, 'meta');
      break;
    default:
      return json({ ok: false }, { status: 400 });
  }

  return json({ ok: true });
}

type Filter = 'all' | 'blocked' | 'warned';

export default function CatalogMeta() {
  const { feed, url, catalog } = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();
  const fetcher = useFetcher<{ ok: boolean }>();
  const busy = fetcher.state !== 'idle';

  const [confirming, setConfirming] = useState<'rotate' | 'disable' | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const send = (intent: string, format?: FeedFormat) => {
    const data = new FormData();
    data.set('intent', intent);
    if (format) data.set('format', format);
    fetcher.submit(data, { method: 'post' });
    setConfirming(null);
  };

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.rows.filter((row) => {
      if (filter === 'blocked' && !row.blocked) return false;
      if (filter === 'warned' && (row.blocked || row.issues.length === 0)) return false;
      return !needle || row.title.toLowerCase().includes(needle);
    });
  }, [catalog.rows, query, filter]);

  const total = catalog.rows.length;

  return (
    <Page
      title={t.catalogs.meta.name}
      titleMetadata={
        feed?.enabled ? (
          <Badge tone="success">{t.catalogs.active}</Badge>
        ) : feed ? (
          <Badge tone="attention">{t.catalogs.paused}</Badge>
        ) : (
          <Badge>{t.catalogs.available}</Badge>
        )
      }
      backAction={{ url: '/catalogs' }}
    >
      <BlockStack gap="500">
        {catalog.unavailable === 'not_connected' && (
          <Banner tone="warning">{t.catalogs.notConnected}</Banner>
        )}

        <Card>
          <BlockStack gap="400">
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              <MetaLogo size={24} />
              <Text as="h2" variant="headingMd">
                {t.catalogs.feed.title}
              </Text>
            </InlineStack>

            <Text as="p" tone="subdued">
              {t.catalogs.feed.description}
            </Text>

            {feed && url ? (
              <BlockStack gap="400">
                {/* L'indirizzo e' lungo e va copiato intero: sta su una riga
                    sua, che scorre, con il pulsante fermo accanto. */}
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  <Box
                    background="bg-surface-secondary"
                    borderRadius="200"
                    padding="300"
                    width="100%"
                    overflowX="scroll"
                  >
                    <Text as="span" variant="bodySm" breakWord={false}>
                      {url}
                    </Text>
                  </Box>
                  <CopyIconButton value={url} />
                </InlineStack>

                <InlineStack gap="400" blockAlign="center" wrap>
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">
                      {t.catalogs.feed.format}
                    </Text>
                    <ButtonGroup variant="segmented">
                      <Button
                        pressed={feed.format === 'xml'}
                        disabled={busy}
                        onClick={() => send('format', 'xml')}
                      >
                        {t.catalogs.feed.formatXml}
                      </Button>
                      <Button
                        pressed={feed.format === 'csv'}
                        disabled={busy}
                        onClick={() => send('format', 'csv')}
                      >
                        {t.catalogs.feed.formatCsv}
                      </Button>
                    </ButtonGroup>
                  </BlockStack>

                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" tone="subdued">
                      {t.catalogs.feed.lastFetch}
                    </Text>
                    <Text as="span">
                      {feed.lastFetchedAt
                        ? new Date(feed.lastFetchedAt).toLocaleString(locale)
                        : t.catalogs.feed.never}
                    </Text>
                  </BlockStack>
                </InlineStack>

                <Text as="p" variant="bodySm" tone="subdued">
                  {t.catalogs.feed.formatHelp}
                </Text>

                <InlineStack gap="200">
                  <Button url={url} target="_blank">
                    {t.catalogs.feed.open}
                  </Button>
                  <Button disabled={busy} onClick={() => setConfirming('rotate')}>
                    {t.catalogs.feed.rotate}
                  </Button>
                  {feed.enabled ? (
                    <Button tone="critical" disabled={busy} onClick={() => setConfirming('disable')}>
                      {t.catalogs.feed.disable}
                    </Button>
                  ) : (
                    <Button variant="primary" disabled={busy} onClick={() => send('enable')}>
                      {t.catalogs.feed.enable}
                    </Button>
                  )}
                </InlineStack>
              </BlockStack>
            ) : (
              <InlineStack>
                <Button variant="primary" loading={busy} onClick={() => send('enable')}>
                  {t.catalogs.install}
                </Button>
              </InlineStack>
            )}
          </BlockStack>
        </Card>

        {feed && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t.catalogs.steps.title}
              </Text>
              <BlockStack gap="200">
                {[
                  t.catalogs.steps.one,
                  t.catalogs.steps.two,
                  t.catalogs.steps.three,
                  t.catalogs.steps.four,
                ].map((step, index) => (
                  <InlineStack key={step} gap="300" blockAlign="start" wrap={false}>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {index + 1}.
                    </Text>
                    <Text as="span">{step}</Text>
                  </InlineStack>
                ))}
              </BlockStack>
              <Text as="p" variant="bodySm" tone="subdued">
                <Link url="https://business.facebook.com/commerce" target="_blank">
                  Commerce Manager
                </Link>
              </Text>
            </BlockStack>
          </Card>
        )}

        <Card padding="0">
          <Box padding="400">
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" wrap>
                <Text as="h2" variant="headingMd">
                  {t.catalogs.table.title}
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <Text as="span" tone="subdued" variant="bodySm">
                    {t.catalogs.table.summary(catalog.included, total)}
                  </Text>
                </InlineStack>
              </InlineStack>

              <InlineStack gap="200" wrap>
                <ButtonGroup variant="segmented">
                  <Button pressed={filter === 'all'} onClick={() => setFilter('all')}>
                    {t.catalogs.table.all}
                  </Button>
                  <Button pressed={filter === 'warned'} onClick={() => setFilter('warned')}>
                    {t.catalogs.table.warnedCount(catalog.warned)}
                  </Button>
                  <Button pressed={filter === 'blocked'} onClick={() => setFilter('blocked')}>
                    {t.catalogs.table.blockedCount(catalog.blocked)}
                  </Button>
                </ButtonGroup>
              </InlineStack>

              <TextField
                label=""
                labelHidden
                value={query}
                onChange={setQuery}
                placeholder={t.catalogs.table.searchPlaceholder}
                prefix={<Icon source={SearchIcon} />}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => setQuery('')}
              />
            </BlockStack>
          </Box>

          <IndexTable
            resourceName={{ singular: 'prodotto', plural: 'prodotti' }}
            itemCount={rows.length}
            selectable={false}
            emptyState={
              <EmptySearchResult
                title={total === 0 ? t.catalogs.table.empty : t.catalogs.table.noMatch}
                description=""
                withIllustration
              />
            }
            headings={[
              { title: t.catalogs.table.product },
              { title: t.catalogs.table.price },
              { title: t.catalogs.table.included },
            ]}
          >
            {rows.map((row, index) => (
              <IndexTable.Row id={row.id} key={row.id} position={index}>
                <IndexTable.Cell>
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <Thumbnail
                      source={row.imageUrl ?? ImageIcon}
                      alt=""
                      size="extraSmall"
                    />
                    <Text as="span" variant="bodyMd" fontWeight="medium">
                      {row.title}
                    </Text>
                  </InlineStack>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {row.price === null ? '—' : formatMoney(row.price, catalog.currency, locale)}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <StateBadge row={row} />
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>
      </BlockStack>

      <Modal
        open={confirming === 'rotate'}
        onClose={() => setConfirming(null)}
        title={t.catalogs.feed.rotateTitle}
        primaryAction={{
          content: t.catalogs.feed.rotateConfirm,
          destructive: true,
          onAction: () => send('rotate'),
        }}
        secondaryActions={[{ content: t.common.cancel, onAction: () => setConfirming(null) }]}
      >
        <Modal.Section>
          <Text as="p">{t.catalogs.feed.rotateBody}</Text>
        </Modal.Section>
      </Modal>

      <Modal
        open={confirming === 'disable'}
        onClose={() => setConfirming(null)}
        title={t.catalogs.feed.disableTitle}
        primaryAction={{
          content: t.catalogs.feed.disableConfirm,
          destructive: true,
          onAction: () => send('disable'),
        }}
        secondaryActions={[{ content: t.common.cancel, onAction: () => setConfirming(null) }]}
      >
        <Modal.Section>
          <Text as="p">{t.catalogs.feed.disableBody}</Text>
        </Modal.Section>
      </Modal>

      <Box paddingBlockEnd="800" />
    </Page>
  );
}

/**
 * Lo stato di una riga: pronta, da sistemare, esclusa.
 *
 * Il badge dice il verdetto e l'icona la gravita', ma nessuno dei due dice
 * perche': quello sta nel tooltip, che e' l'unico posto dove ci sta una frase
 * intera senza allargare la colonna.
 */
function StateBadge({
  row,
}: {
  row: { blocked: boolean; issues: IssueCode[] };
}) {
  const t = useT();

  if (row.issues.length === 0) {
    return <Badge tone="success">{t.catalogs.table.okBadge}</Badge>;
  }

  // Su una riga esclusa le avvertenze non contano: il prodotto non c'e', e
  // sapere che gli manca anche la marca non aiuta finche' non torna dentro.
  const shown = row.blocked
    ? row.issues.filter((code) => severityOf(code) === 'blocking')
    : row.issues;

  return (
    <Tooltip
      content={
        <BlockStack gap="100">
          {shown.map((code) => (
            <Text as="span" key={code} variant="bodySm">
              {t.catalogs.issues[code]}
            </Text>
          ))}
        </BlockStack>
      }
    >
      <InlineStack gap="100" blockAlign="center" wrap={false}>
        <Icon
          source={row.blocked ? DisabledIcon : AlertTriangleIcon}
          tone={row.blocked ? 'critical' : 'caution'}
        />
        <Badge tone={row.blocked ? 'critical' : 'warning'}>
          {row.blocked ? t.catalogs.table.blockedBadge : t.catalogs.table.warnBadge}
        </Badge>
      </InlineStack>
    </Tooltip>
  );
}
