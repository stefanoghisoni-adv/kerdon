import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';
import {
  Page,
  Layout,
  Card,
  Box,
  Banner,
  Badge,
  Button,
  BlockStack,
  InlineStack,
  IndexTable,
  EmptyState,
  Text,
} from '@shopify/polaris';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { useLocale, useT } from '~/lib/i18n/context';

/**
 * Dove il titolare del negozio ritira quello che una persona gli ha chiesto.
 *
 * Prima questa pagina non c'era, e non c'era perche' l'esportazione tornava
 * dentro la risposta al webhook — cioe' andava a Shopify, che non e' chi l'ha
 * chiesta. Il destinatario e' il titolare del negozio, ha trenta giorni per
 * consegnarla, e fino a qui non aveva nessun posto dove prenderla.
 *
 * Le richieste di cancellazione compaiono nella stessa lista, senza niente da
 * scaricare: non hanno un contenuto, hanno un esito, e vedere che sono state
 * eseguite e' parte di cio' che serve al merchant per rispondere di se'.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const requests = await prisma.complianceRequest.findMany({
    where: { shopDomain: session.shop },
    orderBy: { receivedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      topic: true,
      status: true,
      receivedAt: true,
      completedAt: true,
      exportExpiresAt: true,
      customerRef: true,
    },
  });

  const now = Date.now();

  return json({
    requests: requests.map((r) => ({
      id: r.id,
      topic: r.topic,
      status: r.status,
      receivedAt: r.receivedAt.toISOString(),
      completedAt: r.completedAt?.toISOString() ?? null,
      expiresAt: r.exportExpiresAt?.toISOString() ?? null,
      // Il riferimento breve serve solo a distinguere due pratiche nella
      // lista. L'id della persona non passa di qui.
      ref: r.customerRef ? r.customerRef.slice(0, 8) : null,
      // Scaricabile solo finche' la copia esiste davvero: dopo la scadenza il
      // cron l'ha tolta, e un pulsante che promette un file che non c'e'
      // sarebbe peggio di nessun pulsante.
      downloadable:
        r.topic === 'customers/data_request' &&
        r.status === 'completed' &&
        r.exportExpiresAt !== null &&
        r.exportExpiresAt.getTime() > now,
    })),
  });
}

const TONE: Record<string, 'success' | 'attention' | 'critical' | 'info'> = {
  completed: 'success',
  queued: 'info',
  processing: 'info',
  failed: 'attention',
  dead_letter: 'critical',
};

export default function PrivacyPage() {
  const { requests } = useLoaderData<typeof loader>();
  const strings = useT().privacy;
  const locale = useLocale();

  const formatDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(locale === 'it' ? 'it-IT' : 'en-US') : '—';

  return (
    <Page title={strings.title} subtitle={strings.subtitle}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Banner tone="info">
              <Text as="p">{strings.intro}</Text>
            </Banner>

            <Card padding="0">
              {requests.length === 0 ? (
                <Box padding="400">
                  <EmptyState heading={strings.emptyTitle} image="">
                    <Text as="p">{strings.emptyBody}</Text>
                  </EmptyState>
                </Box>
              ) : (
                <IndexTable
                  resourceName={{
                    singular: strings.resourceSingular,
                    plural: strings.resourcePlural,
                  }}
                  itemCount={requests.length}
                  selectable={false}
                  headings={[
                    { title: strings.colRequest },
                    { title: strings.colReceived },
                    { title: strings.colStatus },
                    { title: strings.colAvailable },
                    { title: '' },
                  ]}
                >
                  {requests.map((r, index) => (
                    <IndexTable.Row id={r.id} key={r.id} position={index}>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text as="span" fontWeight="semibold">
                            {strings.topics[r.topic as keyof typeof strings.topics] ?? r.topic}
                          </Text>
                          {r.ref ? (
                            <Text as="span" tone="subdued" variant="bodySm">
                              {r.ref}
                            </Text>
                          ) : null}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{formatDate(r.receivedAt)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={TONE[r.status] ?? 'info'}>
                          {strings.statuses[r.status as keyof typeof strings.statuses] ?? r.status}
                        </Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{formatDate(r.expiresAt)}</IndexTable.Cell>
                      <IndexTable.Cell>
                        {r.downloadable ? (
                          <InlineStack align="end">
                            <Button url={`/privacy/export/${r.id}`} download variant="primary">
                              {strings.download}
                            </Button>
                          </InlineStack>
                        ) : null}
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              )}
            </Card>

            {/* Cosa succede senza che nessuno chieda niente.
                Una disiscrizione dal marketing non arriva in questa lista —
                non e' una richiesta privacy — ma cambia i dati del merchant lo
                stesso, e trovarselo spiegato solo dopo e' il modo in cui nasce
                una sorpresa. */}
            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  {strings.retentionTitle}
                </Text>
                <Text as="p">{strings.retentionBody}</Text>
                <Text as="p" tone="subdued">
                  {strings.retentionKept}
                </Text>
                <Text as="p" tone="subdued">
                  {strings.retentionBack}
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
