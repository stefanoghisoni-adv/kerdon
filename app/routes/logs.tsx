import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useLoaderData } from '@remix-run/react';
import { Page, Layout, Box, Banner, Text } from '@shopify/polaris';
import { SettingsIcon } from '@shopify/polaris-icons';
import { prisma } from '~/db.server';
import { SyncLog } from '~/components/Dashboard/SyncLog';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { useNavLoading } from '~/components/Dashboard/nav-loading';
import { useT } from '~/lib/i18n/context';
import { ProductOverflowBanner } from '~/components/Dashboard/ProductOverflowBanner';
import { nextSyncAt, formatCountdown } from '~/lib/sync/next-sync';
import { requireShopCapability } from '~/lib/authz/require-capability.server';

// Quanti eventi mostrare: la tabella resta una lista unica senza paginazione,
// quindi teniamo il tetto a 20 righe per non allungarla a dismisura.
const MAX_JOBS = 20;

export async function loader({ request }: LoaderFunctionArgs) {
  // Il registro racconta che cosa e' stato sincronizzato e quando, con i nomi
  // dei prodotti toccati: e' lo storico del negozio, e si chiede il permesso
  // prima di aprirlo. Il rifiuto riporta alla dashboard, dove il banner dice
  // che cosa e' successo.
  const { session, shop } = await requireShopCapability(request, 'use_app', {
    onDenied: 'redirect',
  });

  // Questa pagina esiste a configurazione conclusa: prima parlerebbe di dati
  // che non ci sono ancora. Chi ci arriva da un indirizzo salvato torna dove
  // il lavoro e' rimasto.
  await requireSetupComplete(session.shop);

  if (!shop) {
    return json({ jobs: [], customersEnabled: false, timeZone: null, nextSync: null });
  }

  const [plan, jobs] = await Promise.all([
    findPlanByName(shop.currentPlan),
    prisma.syncJob.findMany({
      where: { shopId: shop.id },
      orderBy: { startedAt: 'desc' },
      take: MAX_JOBS,
    }),
  ]);

  // Quando ripartira' la sincronizzazione. Si calcola qui, sull'ultima corsa
  // completata: e' la stessa regola che applica il cron, non una stima a parte.
  const lastCheck = jobs.find(
    (job) =>
      job.jobType === 'periodic_check' &&
      (job.status === 'completed' || job.status === 'completed_with_repairs') &&
      job.completedAt,
  );

  return json({
    jobs,
    customersEnabled: plan?.customersSyncEnabled ?? false,
    timeZone: shop.ianaTimezone,
    nextSync:
      nextSyncAt(
        lastCheck?.completedAt ?? null,
        plan?.maxSyncFrequencyHours ?? null,
        new Date(),
      )?.toISOString() ?? null,
  });
}

export default function Logs() {
  const { jobs, customersEnabled, timeZone, nextSync } = useLoaderData<typeof loader>();
  const t = useT();
  // Il conto alla rovescia si scrive al render: calcolato nel loader
  // invecchierebbe con la pagina aperta, e "fra un minuto" resterebbe li' a
  // lungo dopo che quel minuto e' passato.
  const countdown = nextSync ? formatCountdown(new Date(), new Date(nextSync), t) : null;

  // Spinner e disabilitazione solo se e' stato questo pulsante a far partire
  // la navigazione: dal menu laterale dell'admin deve restare fermo.
  const settings = useNavLoading('/settings/supabase');

  return (
    <Page
      fullWidth
      title={t.logs.title}
      backAction={{ url: '/' }}
      secondaryActions={[
        {
          content: t.common.settings,
          icon: SettingsIcon,
          url: '/settings/supabase',
          accessibilityLabel: t.common.settings,
          onAction: settings.start,
          disabled: settings.loading,
          loading: settings.loading,
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          {/* Il tetto raggiunto si vede anche qui: chi guarda il registro sta
              cercando di capire perche' un prodotto non e' arrivato, ed e'
              esattamente la risposta. */}
          <Box paddingBlockEnd="400">
            <ProductOverflowBanner />
          </Box>
          {/* Solo la frase, senza titolo: e' un'informazione di servizio, e un
              titolo la farebbe pesare come un avviso. Non compare quando non
              c'e' una risposta — meglio tacere che promettere un orario che non
              sappiamo. */}
          {countdown && (
            <Box paddingBlockEnd="400">
              <Banner tone="info">
                <Text as="p">{t.logs.nextSync(countdown)}</Text>
              </Banner>
            </Box>
          )}
          <SyncLog jobs={jobs} customersEnabled={customersEnabled} timeZone={timeZone} />
        </Layout.Section>
      </Layout>
      {/* Respiro in fondo: senza, il bordo della card tocca il fondo dell'iframe. */}
      <Box paddingBlockEnd="800" />
    </Page>
  );
}
