import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useFetcher, useLoaderData, useNavigate } from '@remix-run/react';
import { useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  InlineGrid,
  Modal,
  Page,
  Text,
} from '@shopify/polaris';
import { PlanChangeBanner } from '~/components/Dashboard/PlanChangeBanner';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import { feedsDenial } from '~/lib/feeds/feed-access.server';
import { deleteFeed, listFeeds, PLATFORMS, type Platform } from '~/lib/feeds/feed.server';
import { useNavLoading } from '~/components/Dashboard/nav-loading';
import { MetaLogo } from '~/components/Catalogs/MetaLogo';
import { GoogleLogo } from '~/components/Catalogs/GoogleLogo';
import { ProductOverflowBanner } from '~/components/Dashboard/ProductOverflowBanner';
import { useT } from '~/lib/i18n/context';

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  await requireSetupComplete(session.shop);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  const feeds = shop ? await listFeeds(shop.id) : [];

  // Un solo interrogatorio della policy, due risposte diverse: se i comandi si
  // possono usare, e se il motivo per cui non si possono e' quello che
  // l'avviso racconta. Tenerle separate serve a non far leggere al merchant una
  // spiegazione che non c'entra: l'avviso parla di piano, e finche' e' il piano
  // a fermarlo va bene — ma un negozio senza database collegato viene fermato
  // per un'altra ragione, e mandarlo a cambiare piano non lo aiuterebbe.
  const denial = await feedsDenial(session.shop);

  return json({
    meta: feeds.find((feed) => feed.platform === 'meta') ?? null,
    google: feeds.find((feed) => feed.platform === 'google') ?? null,
    // I feed sono una funzione del piano. Le card restano visibili anche a chi
    // non li ha — servono a sapere cosa si otterrebbe — ma i comandi che
    // attivano no.
    canUseFeeds: denial === null,
    // L'avviso che invita a passare di piano: solo quando e' davvero il piano.
    feedsNeedPlan: denial === 'plan_required',
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  await requireSetupComplete(session.shop);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) return json({ ok: false }, { status: 404 });

  const form = await request.formData();
  const platform = String(form.get('platform') ?? '');
  // Solo le piattaforme che esistono: il nome arriva dal browser.
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    return json({ ok: false }, { status: 400 });
  }

  await deleteFeed(shop.id, platform as Platform);
  return json({ ok: true });
}

export default function Catalogs() {
  const { meta, google, canUseFeeds, feedsNeedPlan } = useLoaderData<typeof loader>();
  const t = useT();
  const navigate = useNavigate();
  const fetcher = useFetcher<{ ok: boolean }>();
  // QUALE integrazione si sta eliminando, non "se ne sta eliminando una". Il
  // fetcher e' uno solo per la pagina, e un booleano condiviso spegneva i
  // pulsanti di tutte le card: eliminando Meta si bloccava anche Google, che
  // con quell'operazione non c'entra niente.
  //
  // Il nome arriva dal form appena inviato, senza tenerne una copia in uno
  // stato a parte: una seconda fonte per la stessa cosa e' una seconda cosa da
  // tenere allineata.
  const deletingPlatform =
    fetcher.state === 'idle' ? null : (fetcher.formData?.get('platform') as string | null);

  // Il modal vive qui e non dentro la card: nell'admin due dialoghi non si
  // impilano, e tenerne uno solo a livello di pagina evita che una seconda card
  // ne apra un altro sotto al primo.
  const [confirming, setConfirming] = useState<Platform | null>(null);

  const remove = (platform: Platform) => {
    const data = new FormData();
    data.set('platform', platform);
    fetcher.submit(data, { method: 'post' });
    setConfirming(null);
  };

  // Tre stati e non due: un feed spento non e' un feed mai attivato — il
  // merchant l'ha gia' collegato una volta, e il pulsante deve dirgli che
  // ritrovera' tutto dov'era.
  const statusOf = (feed: { enabled: boolean } | null) =>
    !feed ? 'available' : feed.enabled ? 'active' : 'paused';
  const status = statusOf(meta);
  const googleStatus = statusOf(google);

  // Il nome per esteso della piattaforma, per i testi che la nominano. Il modal
  // di eliminazione ne parla al singolare: si stacca una integrazione per
  // volta, e leggere il nome giusto e' quello che dice al merchant che le altre
  // restano dove sono.
  const platformName = (platform: Platform | null) =>
    platform === 'google' ? t.catalogs.google.name : t.catalogs.meta.name;

  const badgeFor = (state: string) =>
    state === 'active' ? (
      <Badge tone="success">{t.catalogs.active}</Badge>
    ) : state === 'paused' ? (
      <Badge tone="attention">{t.catalogs.paused}</Badge>
    ) : (
      <Badge>{t.catalogs.available}</Badge>
    );

  return (
    <Page title={t.catalogs.title} backAction={{ url: '/' }}>
      <BlockStack gap="500">
        {/* Il cambio di piano si legge da ogni tab, non solo da dove e' stato
            fatto: chi lo cambia e va dritto qui deve sapere lo stesso cosa e'
            cambiato. Il contenuto lo calcola la dashboard e lo lascia nel
            sessionStorage; se non c'e' niente da dire, questo non rende nulla. */}
        <PlanChangeBanner />

        <Text as="p" tone="subdued">
          {t.catalogs.intro}
        </Text>

        {/* Dice perche' i pulsanti sono spenti, e da li' si passa di piano
            senza cambiare pagina: il modal e' lo stesso del tetto prodotti,
            perche' la domanda e' la stessa — cosa ottengo passando di piano. */}
        {feedsNeedPlan && <ProductOverflowBanner reason="feeds" />}

        <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 4 }} gap="300">
          <PlatformCard
            logo={<MetaLogo />}
            name={t.catalogs.meta.name}
            description={t.catalogs.meta.description}
            badge={badgeFor(status)}
            action={status === 'available' ? t.catalogs.install : t.catalogs.manage}
            primary={status === 'available'}
            // Solo l'attivazione e' vietata: chi ha gia' un feed acceso deve
            // poterlo gestire e spegnere anche dopo un cambio di piano.
            canAct={canUseFeeds || status !== 'available'}
            path="/catalogs/meta"
            onAction={() => navigate('/catalogs/meta')}
            deleteLabel={t.catalogs.delete}
            // Non c'e' niente da eliminare finche' non e' stata attivata: il
            // pulsante resta, spento, cosi' la card ha la stessa forma prima e
            // dopo e non si allunga sotto il dito.
            canDelete={status !== 'available'}
            deleting={deletingPlatform === 'meta'}
            onDelete={() => setConfirming('meta')}
          />

          <PlatformCard
            logo={<GoogleLogo />}
            name={t.catalogs.google.name}
            description={t.catalogs.google.description}
            badge={badgeFor(googleStatus)}
            action={googleStatus === 'available' ? t.catalogs.install : t.catalogs.manage}
            primary={googleStatus === 'available'}
            canAct={canUseFeeds || googleStatus !== 'available'}
            path="/catalogs/google"
            onAction={() => navigate('/catalogs/google')}
            deleteLabel={t.catalogs.delete}
            canDelete={googleStatus !== 'available'}
            deleting={deletingPlatform === 'google'}
            onDelete={() => setConfirming('google')}
          />
        </InlineGrid>
      </BlockStack>

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={t.catalogs.deleteTitle}
        primaryAction={{
          content: t.catalogs.deleteConfirm,
          destructive: true,
          onAction: () => confirming && remove(confirming),
        }}
        secondaryActions={[{ content: t.common.cancel, onAction: () => setConfirming(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p">{t.catalogs.deleteBody(platformName(confirming))}</Text>
            {/* La domanda che si fa chiunque abbia campagne dinamiche accese:
                togliendo l'integrazione ufficiale di Meta spariscono cataloghi e
                shop, e le campagne restano senza riferimenti. Qui non succede, e
                va detto prima del clic, non dopo. */}
            <Banner tone="warning">{t.catalogs.deleteSafe}</Banner>
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Box paddingBlockEnd="800" />
    </Page>
  );
}

/**
 * Una piattaforma: logo, nome, stato, cosa fa, e il comando.
 *
 * In colonna e a tutta altezza, cosi' il pulsante cade in fondo su tutte le
 * card anche dove la descrizione va a capo una volta in piu'.
 */
function PlatformCard({
  logo,
  name,
  description,
  badge,
  action,
  primary,
  path,
  onAction,
  deleteLabel,
  canAct,
  canDelete,
  deleting,
  onDelete,
}: {
  logo: React.ReactNode;
  name: string;
  description: string;
  badge: React.ReactNode;
  action: string;
  primary: boolean;
  /** Dove porta il pulsante principale: serve a sapere quando ha finito. */
  path: string;
  onAction: () => void;
  deleteLabel: string;
  /** Il piano concede i feed: senza, il pulsante che attiva resta spento. */
  canAct: boolean;
  canDelete: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  // L'attesa del pulsante principale e' una navigazione, non una richiesta: si
  // accende solo se e' stato questo pulsante a farla partire, altrimenti anche
  // il menu laterale dell'admin lo accenderebbe.
  const nav = useNavLoading(path);
  // Mentre uno dei due lavora l'altro si spegne: sono due strade opposte sulla
  // stessa integrazione, e premerle insieme non porta da nessuna parte.
  const working = nav.loading || deleting;

  return (
    // La classe rende flessibili i livelli annidati della Card: senza, il
    // "height: 100%" qui sotto si misura su un contenitore che non e' stato
    // steso, e i pulsanti risalgono sotto le descrizioni corte.
    <div className="platform-card">
    <Card padding="400">
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <BlockStack gap="300" inlineAlign="center">
          {/* Il logo dentro un quadrato con la cornice: i marchi arrivano su
              fondi diversi, e senza una cornice comune la fila si vede
              disallineata. */}
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
            {logo}
          </div>

          <BlockStack gap="150" inlineAlign="center">
            <Text as="h3" variant="headingSm" alignment="center">
              {name}
            </Text>
            <div>{badge}</div>
            <Text as="p" variant="bodySm" tone="subdued" alignment="center">
              {description}
            </Text>
          </BlockStack>
        </BlockStack>

        {/* I due pulsanti in fondo, sempre: `auto` mangia lo spazio che avanza
            sopra di loro, cosi' una card con la descrizione corta li tiene alla
            stessa altezza di una con la descrizione lunga. Allineati fra le
            card, si premono senza rimirare dove sono finiti. */}
        <div style={{ marginBlockStart: 'auto', paddingBlockStart: 'var(--p-space-400)' }}>
          <BlockStack gap="200">
            <Button
              variant={primary ? 'primary' : undefined}
              onClick={() => {
                nav.start();
                onAction();
              }}
              loading={nav.loading}
              disabled={working || !canAct}
              fullWidth
            >
              {action}
            </Button>
            {/* Rosso ma non primario: e' l'uscita, non la strada. */}
            <Button
              tone="critical"
              disabled={!canDelete || working}
              loading={deleting && canDelete}
              onClick={onDelete}
              fullWidth
            >
              {deleteLabel}
            </Button>
          </BlockStack>
        </div>
      </div>
    </Card>
    </div>
  );
}
