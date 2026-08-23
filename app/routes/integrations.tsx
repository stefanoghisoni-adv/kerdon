import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  Text,
  Thumbnail,
} from '@shopify/polaris';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import {
  canInstall,
  categoryLabel,
  groupByCategory,
  normalizeStatus,
  platformInitials,
  statusLabel,
} from '~/lib/integrations/platforms';
import { useT } from '~/lib/i18n/context';

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  await requireSetupComplete(session.shop);

  // L'elenco vive sul database dell'owner: aggiungere una piattaforma o
  // cambiarne lo stato non richiede un rilascio dell'app.
  const platforms = await prisma.integrationPlatform.findMany({
    orderBy: [{ category: 'asc' }, { position: 'asc' }, { name: 'asc' }],
  });

  return json({
    platforms: platforms.map((platform) => ({
      slug: platform.slug,
      name: platform.name,
      category: platform.category,
      logoUrl: platform.logoUrl,
      status: normalizeStatus(platform.status),
    })),
  });
}

export default function Integrations() {
  const { platforms } = useLoaderData<typeof loader>();
  const t = useT();
  const groups = groupByCategory(platforms);

  return (
    <Page fullWidth title={t.integrations.title} backAction={{ url: '/' }}>
      <BlockStack gap="500">
        <Text as="p" tone="subdued">
          {t.integrations.intro}
        </Text>

        {groups.length === 0 && (
          <Text as="p" tone="subdued">
            {t.integrations.empty}
          </Text>
        )}

        {groups.map((group) => (
          <BlockStack key={group.category} gap="300">
            <Text as="h2" variant="headingMd">
              {categoryLabel(group.category, t)}
            </Text>

            <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="300">
              {group.items.map((platform) => {
                const installable = canInstall(platform.status);
                return (
                  <Card key={platform.slug} padding="400">
                    {/* Colonna a tutta altezza: il pulsante cade in fondo su
                        tutte le card, anche dove il nome va a capo. */}
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                      <BlockStack gap="300">
                        <InlineStack gap="300" blockAlign="center" wrap={false}>
                          {/* Il logo arriva dal database. Senza, restano le
                              iniziali: una card senza immagine si riconosce
                              lo stesso, un riquadro vuoto no. */}
                          {platform.logoUrl ? (
                            <Thumbnail source={platform.logoUrl} alt={platform.name} size="small" />
                          ) : (
                            <Box
                              background="bg-surface-secondary"
                              borderRadius="200"
                              minWidth="40px"
                              padding="200"
                            >
                              <Text as="span" alignment="center" fontWeight="semibold">
                                {platformInitials(platform.name)}
                              </Text>
                            </Box>
                          )}
                          <Text as="h3" variant="headingSm">
                            {platform.name}
                          </Text>
                        </InlineStack>

                        <InlineStack>
                          <Badge tone={installable ? 'success' : undefined}>
                            {statusLabel(platform.status, t)}
                          </Badge>
                        </InlineStack>
                      </BlockStack>

                      <div
                        style={{
                          marginBlockStart: 'auto',
                          paddingBlockStart: 'var(--p-space-400)',
                        }}
                      >
                        {/* Spento finche' la connessione di quella piattaforma
                            non esiste davvero: un pulsante che si preme e non
                            fa niente e' peggio di un pulsante spento. */}
                        <Button variant="primary" fullWidth disabled={!installable}>
                          {t.integrations.install}
                        </Button>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </InlineGrid>
          </BlockStack>
        ))}
      </BlockStack>
      <Box paddingBlockEnd="800" />
    </Page>
  );
}
