import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useFetcher, useLoaderData } from '@remix-run/react';
import { useEffect, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  InlineStack,
  Modal,
  Page,
  Text,
} from '@shopify/polaris';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
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
import { GMC_FIELDS, isVariable, type Variable } from '~/lib/feeds/gmc';
import { loadMapping, saveField } from '~/lib/feeds/mapping.server';
import { GoogleLogo } from '~/components/Catalogs/GoogleLogo';
import { RequiredBadge, VariablePicker } from '~/components/Catalogs/VariablePicker';
import { CopyIconButton } from '~/components/Dashboard/CopyIconButton';
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

  const [feed, mapping] = await Promise.all([getFeed(id, 'google'), loadMapping(id, 'google')]);

  return json({
    feed,
    url: feed ? feedUrl(feed.token, feed.format) : null,
    // I campi con la scelta corrente accanto: la pagina li mostra nell'ordine
    // in cui Google li scrive nel file, che e' anche l'ordine in cui il
    // merchant li ritrova quando apre il feed per controllarlo.
    fields: GMC_FIELDS.map((field) => ({
      name: field.name,
      required: field.required,
      suggested: field.suggested,
      variable: mapping[field.name]?.variable ?? field.suggested,
      recent: mapping[field.name]?.recent ?? [],
    })),
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
    case 'format':
      await enableFeed(id, 'google', format);
      break;
    case 'disable':
      await disableFeed(id, 'google');
      break;
    case 'rotate':
      await rotateToken(id, 'google');
      break;
    case 'field': {
      const field = String(form.get('field') ?? '');
      const variable = String(form.get('variable') ?? '');
      // Nomi che arrivano dal browser: si accettano solo quelli che esistono.
      // Un campo inventato creerebbe una riga che nessuno legge; una variabile
      // inventata farebbe uscire un feed con una colonna vuota.
      if (!GMC_FIELDS.some((f) => f.name === field) || !isVariable(variable)) {
        return json({ ok: false }, { status: 400 });
      }
      await saveField(id, 'google', field, variable);
      break;
    }
    default:
      return json({ ok: false }, { status: 400 });
  }

  return json({ ok: true });
}

export default function CatalogGoogle() {
  const { feed, url, fields } = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();
  const fetcher = useFetcher<{ ok: boolean }>();
  const busy = fetcher.state !== 'idle';

  const [confirming, setConfirming] = useState<'rotate' | 'disable' | null>(null);

  // Le scelte in corso, prima che il server risponda. Senza, ogni tendina
  // resterebbe sul valore vecchio per tutto il tempo del salvataggio, e chi ne
  // cambia cinque di fila vedrebbe la propria scelta tornare indietro.
  const [pending, setPending] = useState<Record<string, Variable>>({});
  useEffect(() => {
    if (fetcher.state === 'idle') setPending({});
  }, [fetcher.state]);

  const send = (intent: string, format?: FeedFormat) => {
    const data = new FormData();
    data.set('intent', intent);
    if (format) data.set('format', format);
    fetcher.submit(data, { method: 'post' });
    setConfirming(null);
  };

  const chooseVariable = (field: string, variable: Variable) => {
    setPending((current) => ({ ...current, [field]: variable }));
    const data = new FormData();
    data.set('intent', 'field');
    data.set('field', field);
    data.set('variable', variable);
    fetcher.submit(data, { method: 'post' });
  };

  const status = !feed ? 'available' : feed.enabled ? 'active' : 'paused';

  return (
    <Page
      title={t.catalogs.google.name}
      titleMetadata={
        status === 'active' ? (
          <Badge tone="success">{t.catalogs.active}</Badge>
        ) : status === 'paused' ? (
          <Badge tone="attention">{t.catalogs.paused}</Badge>
        ) : (
          <Badge>{t.catalogs.available}</Badge>
        )
      }
      backAction={{ url: '/catalogs' }}
    >
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="400">
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              <GoogleLogo size={28} />
              <Text as="h2" variant="headingMd">
                {t.catalogs.feed.title}
              </Text>
            </InlineStack>

            <Text as="p" tone="subdued">
              {t.catalogs.google.description}
            </Text>

            {feed && url ? (
              <BlockStack gap="400">
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

        {/* La corrispondenza dei campi.
            Non e' una tabella di sola lettura come quella di Meta: qui ogni
            riga e' una scelta, e la colonna dei comandi e' larga quanto quella
            dei nomi perche' e' li' che si lavora. */}
        {feed && (
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  {t.catalogs.mapping.title}
                </Text>
                <Text as="p" tone="subdued">
                  {t.catalogs.mapping.intro}
                </Text>
              </BlockStack>

              <Box
                borderColor="border"
                borderWidth="025"
                borderRadius="200"
                overflowX="scroll"
              >
                <table className="gmc-mapping" style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <Th>{t.catalogs.mapping.field}</Th>
                      {/* Senza intestazione: la colonna porta un avviso, non un
                          dato, e "Obbligatorio" si spiega da solo. */}
                      <Th>{''}</Th>
                      <Th>{t.catalogs.mapping.variable}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((field) => (
                      <tr key={field.name}>
                        <Td>
                          <Text as="span" variant="bodyMd">
                            {field.name}
                          </Text>
                        </Td>
                        <Td>
                          <RequiredBadge required={field.required} />
                        </Td>
                        <Td>
                          <VariablePicker
                            value={pending[field.name] ?? (field.variable as Variable)}
                            suggested={field.suggested as Variable}
                            recent={field.recent as Variable[]}
                            onChange={(variable) => chooseVariable(field.name, variable)}
                          />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>
            </BlockStack>
          </Card>
        )}
      </BlockStack>

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={
          confirming === 'rotate' ? t.catalogs.feed.rotateTitle : t.catalogs.feed.disableTitle
        }
        primaryAction={{
          content:
            confirming === 'rotate'
              ? t.catalogs.feed.rotateConfirm
              : t.catalogs.feed.disableConfirm,
          destructive: true,
          onAction: () => confirming && send(confirming),
        }}
        secondaryActions={[{ content: t.common.cancel, onAction: () => setConfirming(null) }]}
      >
        <Modal.Section>
          <Text as="p">
            {confirming === 'rotate'
              ? t.catalogs.feed.rotateBody
              : t.catalogs.feed.disableBody}
          </Text>
        </Modal.Section>
      </Modal>

      <Box paddingBlockEnd="800" />
    </Page>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '0.75rem 1rem',
        borderBottom: '1px solid var(--p-color-border)',
        background: 'var(--p-color-bg-surface-secondary)',
      }}
    >
      <Text as="span" variant="bodySm" tone="subdued">
        {children}
      </Text>
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td
      style={{
        padding: '0.5rem 1rem',
        borderBottom: '1px solid var(--p-color-border-secondary)',
        verticalAlign: 'middle',
      }}
    >
      {children}
    </td>
  );
}
