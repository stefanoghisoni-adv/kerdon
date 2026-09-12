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
import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import { shopCanUseFeeds } from '~/lib/feeds/feed-access.server';
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
import {
  requireShopCapability,
  shopCapabilityOutcome,
} from '~/lib/authz/require-capability.server';

export async function loader({ request }: LoaderFunctionArgs) {
  // `use_app` e non `use_feeds`: la pagina resta leggibile a chi i feed non li
  // ha nel piano, perche' e' qui che vede cosa otterrebbe. A restare fuori e'
  // il negozio fermo — sospeso, prova finita, cancellazione in corso — e per
  // quello il rifiuto e' un ritorno alla dashboard, dove c'e' scritto perche'.
  const { session, shop } = await requireShopCapability(request, 'use_app', {
    onDenied: 'redirect',
  });
  await requireSetupComplete(session.shop);

  const id = shop.id;

  const [feed, catalog] = await Promise.all([getFeed(id, 'meta'), loadCatalogReport(id)]);

  return json({
    feed,
    url: feed ? feedUrl(feed.token, feed.format) : null,
    catalog,
    // Per aprire la scheda del prodotto: da qui il merchant sistema quello che
    // manca, ed e' il gesto successivo a leggere la riga.
    adminBase: `https://admin.shopify.com/store/${session.shop.replace('.myshopify.com', '')}`,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  // Il rifiuto si restituisce: la pagina dei feed lavora a fetcher, e una
  // Response sollevata da qui le toglierebbe lo schermo di sotto.
  const cancello = await shopCapabilityOutcome(request, 'use_app');
  if (!cancello.ok) return json({ ok: false, error: cancello.denial }, { status: 403 });
  const { session, shop } = cancello.grant;
  await requireSetupComplete(session.shop);

  const id = shop.id;

  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const rawFormat = String(form.get('format') ?? 'xml');
  const format: FeedFormat = isFeedFormat(rawFormat) ? rawFormat : 'xml';

  // Accendere un feed e' l'unica azione che il piano puo' vietare: le altre
  // agiscono su qualcosa che esiste gia', e chi l'ha ottenuto quando il piano
  // lo prevedeva deve poterlo spegnere anche dopo.
  if (intent === 'enable' || intent === 'format') {
    if (!(await shopCanUseFeeds(session.shop))) {
      return json({ ok: false, error: 'plan_required' }, { status: 403 });
    }
  }

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
  const { feed, url, catalog, adminBase } = useLoaderData<typeof loader>();
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
              <MetaLogo size={28} />
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
                  // Il collegamento sta dentro il passo che dice di aprirlo, non
                  // in fondo alla card: li' era una voce in piu' da capire, qui
                  // e' la parola su cui si clicca mentre si legge cosa fare.
                  <Text as="span" key="one">
                    {t.catalogs.steps.oneBefore}{' '}
                    <Link url="https://business.facebook.com/commerce" target="_blank">
                      {t.catalogs.steps.oneLink}
                    </Link>{' '}
                    {t.catalogs.steps.oneAfter}
                  </Text>,
                  <Text as="span" key="two">
                    {t.catalogs.steps.two}
                  </Text>,
                  <Text as="span" key="three">
                    {t.catalogs.steps.three}
                  </Text>,
                  <Text as="span" key="four">
                    {t.catalogs.steps.four}
                  </Text>,
                ].map((step, index) => (
                  <InlineStack key={index} gap="300" blockAlign="start" wrap={false}>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {index + 1}.
                    </Text>
                    {step}
                  </InlineStack>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        )}

        {/* L'elenco dei prodotti compare solo a integrazione attivata, come nel
            Merchant Center.
            Prima si vedeva subito, e prometteva una cosa che non stava
            succedendo: quei prodotti nel catalogo di Meta non c'erano ancora, e
            leggerli in tabella faceva credere il contrario. Finche' il feed non
            esiste non c'e' niente da mostrare — c'e' da attivarlo, e il comando
            per farlo e' nella card qui sopra. */}
        {feed && (
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
              // Due colonne e non una: l'icona dice quanto e' grave, il badge
              // dice cosa succede al prodotto quando il feed parte. Sono due
              // domande, e finivano sotto un'intestazione sola.
              // Al centro: e' una colonna di soli simboli, e allineati a un
              // bordo sembrano appoggiati alla colonna accanto invece che alla
              // propria.
              { title: t.catalogs.table.state, alignment: 'center' as const },
              { title: t.catalogs.table.sync },
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
                    {row.productId ? (
                      // _top e non una scheda nuova: l'admin di Shopify rifiuta
                      // di essere incorniciato, e un collegamento normale da qui
                      // dentro finirebbe in "Connessione negata".
                      <Link url={`${adminBase}/products/${row.productId}`} target="_top">
                        {row.title}
                      </Link>
                    ) : (
                      <Text as="span" variant="bodyMd" fontWeight="medium">
                        {row.title}
                      </Text>
                    )}
                  </InlineStack>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {row.price === null ? '—' : formatMoney(row.price, catalog.currency, locale)}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <InlineStack align="center">
                    <StateIcon row={row} />
                  </InlineStack>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <StateBadge row={row} />
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>
        )}
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
 * I motivi per cui una riga non va bene, uno per frase.
 *
 * Su una riga esclusa le avvertenze non contano: il prodotto non c'e', e sapere
 * che gli manca anche la marca non aiuta finche' non torna dentro.
 */
function reasons(row: { blocked: boolean; issues: IssueCode[] }): IssueCode[] {
  return row.blocked ? row.issues.filter((code) => severityOf(code) === 'blocking') : row.issues;
}

/**
 * La gravita', in un'icona.
 *
 * L'icona non dice perche': quello sta nel tooltip, che e' l'unico posto dove
 * ci sta una frase intera senza allargare la colonna.
 */
function StateIcon({ row }: { row: { blocked: boolean; issues: IssueCode[] } }) {
  const t = useT();
  if (row.issues.length === 0) return null;

  return (
    <Tooltip
      content={
        <BlockStack gap="100">
          {reasons(row).map((code) => (
            <Text as="span" key={code} variant="bodySm">
              {t.catalogs.issues[code]}
            </Text>
          ))}
        </BlockStack>
      }
    >
      <Icon
        source={row.blocked ? DisabledIcon : AlertTriangleIcon}
        tone={row.blocked ? 'critical' : 'caution'}
      />
    </Tooltip>
  );
}

/** Cosa succede a questa riga quando il feed parte. */
function StateBadge({ row }: { row: { blocked: boolean; issues: IssueCode[] } }) {
  const t = useT();

  if (row.issues.length === 0) {
    return <Badge tone="success">{t.catalogs.table.okBadge}</Badge>;
  }

  return (
    <Badge tone={row.blocked ? 'critical' : 'warning'}>
      {row.blocked ? t.catalogs.table.blockedBadge : t.catalogs.table.warnBadge}
    </Badge>
  );
}
