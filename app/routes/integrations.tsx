import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useFetcher, useLoaderData } from '@remix-run/react';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Page,
  Text,
} from '@shopify/polaris';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import {
  canInstall,
  categoryLabel,
  groupByCategory,
  normalizeStatus,
  platformDescription,
  platformInitials,
  statusLabel,
  type PlatformStatus,
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

interface PlatformView {
  slug: string;
  name: string;
  category: string;
  logoUrl: string | null;
  status: PlatformStatus;
}

/** Quanto resta a schermo un avviso prima di sparire da solo. */
const NOTICE_MS = 10_000;

export default function Integrations() {
  const { platforms } = useLoaderData<typeof loader>();
  const t = useT();
  const groups = groupByCategory(platforms);

  // Un avviso alla volta, e se ne va da solo: e' la risposta a un clic, non uno
  // stato della pagina, e restare li' lo farebbe sembrare un problema aperto.
  const [notice, setNotice] = useState<{ id: number; message: string } | null>(null);
  const showNotice = useCallback((message: string) => {
    setNotice({ id: Date.now(), message });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    // La chiave e' l'istante: un secondo avviso rimette in moto l'attesa invece
    // di ereditare quella del primo, che sarebbe quasi scaduta.
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <Page fullWidth title={t.integrations.title} backAction={{ url: '/' }}>
      <BlockStack gap="500">
        {/* Fra il titolo e la descrizione: e' li' che l'occhio torna dopo aver
            premuto un pulsante piu' in basso. */}
        {notice && (
          <Banner tone="info" onDismiss={() => setNotice(null)}>
            {notice.message}
          </Banner>
        )}

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

            {/* Il doppio delle colonne di prima: sono riquadri di
                riconoscimento — logo, nome, una riga — non schede da leggere. */}
            <InlineGrid columns={{ xs: 1, sm: 2, md: 4, lg: 8 }} gap="300">
              {group.items.map((platform) => (
                <PlatformCard
                  key={platform.slug}
                  platform={platform}
                  onNotice={showNotice}
                />
              ))}
            </InlineGrid>
          </BlockStack>
        ))}
      </BlockStack>
      <Box paddingBlockEnd="800" />
    </Page>
  );
}

/**
 * Una piattaforma, in colonna e al centro: logo, nome, stato, cosa fa, e il
 * comando.
 *
 * Ogni card ha il suo fetcher e non uno condiviso: premendo due pulsanti
 * diversi, un fetcher solo annullerebbe la prima richiesta ancora in volo — e
 * il primo loader resterebbe acceso su un'azione che nessuno sta piu'
 * eseguendo.
 */
function PlatformCard({
  platform,
  onNotice,
}: {
  platform: PlatformView;
  onNotice: (message: string) => void;
}) {
  const t = useT();
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const installable = canInstall(platform.status);
  const installing = fetcher.state !== 'idle';

  // L'esito non resta nella card: dentro un riquadro stretto una frase lunga
  // spingerebbe il pulsante fuori posto, e le card della stessa fila
  // perderebbero l'allineamento. Sale in cima, dove c'e' spazio per leggerla.
  const message = fetcher.data?.error;
  useEffect(() => {
    if (message) onNotice(message);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, fetcher.data]);

  return (
    <Card padding="400">
      {/* Colonna a tutta altezza: il pulsante cade in fondo su tutte le card,
          anche dove il nome o la descrizione vanno a capo. */}
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <BlockStack gap="300" inlineAlign="center">
          {/* Il logo dentro un quadrato bianco molto stondato: i marchi arrivano
              con fondi diversi — alcuni trasparenti, alcuni chiari — e senza una
              cornice comune la fila di card si vedrebbe disallineata. */}
          <div
            style={{
              width: 48,
              height: 48,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--p-color-bg-surface)',
              border: '1px solid var(--p-color-border)',
              borderRadius: 'var(--p-border-radius-300)',
              overflow: 'hidden',
            }}
          >
            {platform.logoUrl ? (
              <img
                src={platform.logoUrl}
                alt={platform.name}
                style={{ width: 28, height: 28, objectFit: 'contain' }}
              />
            ) : (
              <Text as="span" fontWeight="semibold">
                {platformInitials(platform.name)}
              </Text>
            )}
          </div>

          <Text as="h3" variant="headingSm" alignment="center">
            {platform.name}
          </Text>

          <Badge tone={installable ? 'success' : undefined}>
            {statusLabel(platform.status, t)}
          </Badge>

          <Text as="p" tone="subdued" variant="bodySm" alignment="center">
            {platformDescription(platform, t)}
          </Text>

        </BlockStack>

        <div style={{ marginBlockStart: 'auto', paddingBlockStart: 'var(--p-space-400)' }}>
          {/* Spento finche' la connessione di quella piattaforma non esiste
              davvero: un pulsante che si preme e non fa niente e' peggio di un
              pulsante spento. Mentre l'installazione e' in corso resta fermo,
              cosi' due clic non aprono due connessioni. */}
          <Button
            variant="primary"
            fullWidth
            disabled={!installable || installing}
            loading={installing}
            onClick={() =>
              fetcher.submit({ slug: platform.slug }, { method: 'POST', action: '/api/integrations/install' })
            }
          >
            {t.integrations.install}
          </Button>
        </div>
      </div>
    </Card>
  );
}
