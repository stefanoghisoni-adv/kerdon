import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useFetcher, useLoaderData, useRevalidator, useRouteLoaderData } from '@remix-run/react';
import type { loader as rootLoader } from '~/root';
import {
  Page,
  Layout,
  Banner,
  BlockStack,
  InlineGrid,
  InlineStack,
  Box,
  Button,
  Text,
} from '@shopify/polaris';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { getReadProxyTokenForDisplay } from '~/lib/read-proxy/token.server';
import { AccountCard } from '~/components/Dashboard/AccountCard';
import { DatabaseCard } from '~/components/Dashboard/DatabaseCard';
import { firstPlanWithCustomersSync } from '~/components/Dashboard/account-format';
import { samePlanName } from '~/lib/billing/plan-name';
import { syncIsActive } from '~/lib/sync/sync-active';
import { loadSyncTiming } from '~/lib/sync/sync-timing.server';
import { projectDashboardUrl } from '~/lib/supabase-management.server';
import { SyncCard } from '~/components/Dashboard/SyncCard';
import { SupabaseAccountConnect } from '~/components/Dashboard/SupabaseAccountConnect';
import { SupabaseProjectConnect } from '~/components/Dashboard/SupabaseProjectConnect';
import { PlanLimitBanner } from '~/components/Dashboard/PlanLimitBanner';
import { normalizeAuthorization } from '~/utils/authorization.server';
import { BASE_CURRENCY } from '~/lib/billing/money';
import { useT } from '~/lib/i18n/context';
import type { Preferences } from '~/components/Dashboard/PreferencesSelect';
import { useCallback, useEffect, useState } from 'react';

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  // Questa pagina esiste a configurazione conclusa: prima parlerebbe di dati
  // che non ci sono ancora. Chi ci arriva da un indirizzo salvato torna dove
  // il lavoro e' rimasto.
  await requireSetupComplete(session.shop);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { supabaseConfig: true },
  });

  // Tutti i piani: da qui esce sia quello in uso (i clienti sono inclusi?) sia
  // quello da proporre a chi non li ha. Il prezzo serve solo a ordinarli — si
  // propone il piu' economico fra quelli che includono i clienti — e viene dal
  // listino in valuta base, l'unico posto dove i prezzi stanno.
  const [plans, basePrices] = await Promise.all([
    prisma.plan.findMany(),
    prisma.planPrice.findMany({ where: { currency: BASE_CURRENCY } }),
  ]);
  const plan = plans.find((p) => samePlanName(p.planName, shop?.currentPlan)) ?? null;

  const monthlyOf = new Map(
    basePrices.map((row) => [row.planName, Number(row.priceMonthly)]),
  );

  const connected = !!shop?.supabaseConfig?.connectionVerifiedAt;
  // La sincronizzazione e' automatica e sempre attiva: non c'e' niente da
  // accendere. Restano le due condizioni che non dipendono dal merchant — il
  // progetto collegato e il negozio autorizzato (a trial scaduto e' tutto
  // sospeso).
  const syncRunning = syncIsActive(shop?.supabaseConfig) && shop?.authorization === 'ENABLED';
  const customersIncluded = plan?.customersSyncEnabled ?? false;
  // I feed non dipendono dalla sincronizzazione in corso ma solo dal piano:
  // l'indirizzo risponde anche fra una corsa e l'altra, con i dati dell'ultima.
  const productFeedsIncluded = plan?.productFeedsEnabled ?? false;

  // Informazioni di account: sempre presenti, anche senza collegamento — proprio
  // in quel caso "Stato: Non collegato" e' l'informazione piu' utile.
  const account = {
    connected,
    planName: shop?.currentPlan ?? '',
    productsSyncActive: syncRunning,
    customersSyncActive: syncRunning && customersIncluded,
    productFeedsActive: productFeedsIncluded,
    // Il piano da proporre si calcola solo quando serve davvero.
    customersUpgradePlan: customersIncluded
      ? null
      : firstPlanWithCustomersSync(
          plans.map((p) => ({
            planName: p.planName,
            priceMonthly: monthlyOf.get(p.planName) ?? 0,
            customersSyncEnabled: p.customersSyncEnabled,
          })),
          shop?.currentPlan ?? null,
        ),
  };

  // Cadenza del piano e ultima corsa completata: la sincronizzazione e' una
  // delle cose che il merchant viene a controllare qui, e finora la pagina non
  // ne diceva niente. Le date le calcola loadSyncTiming, che le determina allo
  // stesso modo anche per la dashboard.
  const frequencyHours = plan?.maxSyncFrequencyHours ?? null;
  const timing = shop
    ? await loadSyncTiming(shop.id, frequencyHours)
    : { lastSync: null, nextSync: null };

  const sync = {
    frequencyHours,
    ...timing,
    timeZone: shop?.ianaTimezone ?? null,
  };

  // Stato di autorizzazione e riferimento del progetto: li usa il riquadro
  // della connessione, che da qui in poi vive su questa pagina.
  const authorization = normalizeAuthorization(shop?.authorization);

  const config = shop?.supabaseConfig;
  if (!config) {
    return json({ account, config: null, sync, authorization });
  }

  // Le letture di tracciamento non passano più dalla anon key del merchant ma
  // dal proxy dell'owner, che applica il gate sullo stato del negozio. Quindi
  // qui mostriamo URL del proxy + token, non la anon key. La service_role NON
  // viene mai restituita al client (troppo sensibile).
  const readToken = getReadProxyTokenForDisplay({
    readProxyTokenEnc: shop?.readProxyTokenEnc ?? null,
  });
  const proxyBaseUrl = process.env.SHOPIFY_APP_URL ?? '';

  return json({
    account,
    sync,
    authorization,
    config: {
      readToken,
      proxyBaseUrl,
      // Indirizzo del progetto del merchant: e' suo, e da qui ci arriva con un
      // clic invece di ricordarselo. Due indirizzi diversi per due mestieri: la
      // pagina da guardare (la dashboard di Supabase) e l'indirizzo a cui il
      // progetto risponde, che aperto in un browser da' una risposta dell'API.
      databaseUrl: config.supabaseUrl,
      projectRef: config.supabaseProjectRef,
      projectName: config.supabaseProjectName,
      dashboardUrl: config.supabaseProjectRef
        ? projectDashboardUrl(config.supabaseProjectRef)
        : null,
      syncIntervalHours: config.syncIntervalHours,
    },
  });
}

// Nessuna action: questa pagina non scrive niente. La sincronizzazione e'
// automatica e non ha impostazioni, la chiave di lettura viene emessa una volta
// al collegamento del progetto e le chiavi del progetto non si toccano da qui.
export default function SupabaseSettings() {
  const { account, config, sync, authorization } = useLoaderData<typeof loader>();
  const t = useT();
  // L'avviso sul limite dei database: lo accende il menu dentro la card, e lo
  // rende questa pagina, in cima.
  const [planLimit, setPlanLimit] = useState<{
    planLabel: string | null;
    billingUrl: string | null;
  } | null>(null);
  // Lingua e valuta vivono in root: sono una scelta sola e valgono per tutta
  // l'app, non per questa pagina.
  const root = useRouteLoaderData<typeof rootLoader>('root');

  // La lingua si applica a tutta l'app, non alla sola pagina: salvata la
  // scelta si rilegge il dato di root, che e' dove la lingua vive.
  const localeFetcher = useFetcher<{ ok?: boolean }>();
  const revalidator = useRevalidator();
  const changeLocale = useCallback(
    (next: Preferences) => {
      localeFetcher.submit(
        { locale: next.locale, currency: next.currency },
        { method: 'POST', action: '/api/locale' },
      );
    },
    [localeFetcher],
  );
  useEffect(() => {
    if (localeFetcher.state === 'idle' && localeFetcher.data?.ok) revalidator.revalidate();
    // revalidator fuori dalle dipendenze: revalidate() ne cambia lo stato, e
    // averlo qui rifarebbe partire l'effetto all'infinito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localeFetcher.state, localeFetcher.data]);

  return (
    <Page fullWidth title={t.settings.title} backAction={{ url: '/' }}>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/* Il limite di database del piano Supabase. Lo fa comparire il menu
                "Gestisci", che pero' vive dentro la card Database: l'avviso deve
                stare qui sopra, dove stanno tutti gli altri. */}
            {planLimit && (
              <PlanLimitBanner
                planLabel={planLimit.planLabel}
                billingUrl={planLimit.billingUrl}
                onDismiss={() => setPlanLimit(null)}
              />
            )}
            {/* Gli avvisi stanno in cima, prima delle card: dicono se quello
                che si sta per leggere ha senso — senza un progetto collegato,
                meta' dei valori sotto sono vuoti per forza. In fondo li si
                trovava dopo averli gia' cercati. */}
            {!config ? (
              <Banner tone="info">
                {/* "Dashboard" e' il posto dove si collega: tanto vale
                    portarcelo, invece di dirgli di cercarlo.

                    Button e non Link: Polaris rende monocromatici i Link dentro
                    un Banner (Link legge BannerContext e si spegne, senza una
                    prop per chiedere il contrario). Il Button variant="plain" e'
                    lo stesso comando di "Aggiorna a Pro", quindi il blu e' lo
                    stesso per costruzione e non per una regola copiata. */}
                {t.settings.noProject.before}{' '}
                <Button variant="plain" url="/">
                  {t.settings.noProject.link}
                </Button>{' '}
                {t.settings.noProject.after}
              </Banner>
            ) : (
              <>
                {!config.readToken && (
                  <Banner tone="warning">
                    {t.settings.missingReadKey}
                  </Banner>
                )}
                {!config.proxyBaseUrl && (
                  <Banner tone="critical">
                    {t.settings.missingProxyUrl}
                  </Banner>
                )}
              </>
            )}

            {/* Account e Database affiancati: sono due letture dello stesso
                colpo d'occhio (cosa prevede il piano, cosa risponde il progetto).
                A Database va la parte larga: indirizzo e chiave sono lunghi e
                nella colonna stretta finirebbero accorciati. */}
            {/* 35/65. minmax(0, …) e non i soli fr: senza, un valore lungo
                allargherebbe la colonna oltre la sua quota invece di stare
                dentro. */}
            <InlineGrid
              columns={{ xs: 1, md: 'minmax(0, 35fr) minmax(0, 65fr)' }}
              gap="400"
            >
              {/* A sinistra le due card corte, impilate: cosi' la colonna
                  stretta si riempie e quella larga puo' crescere in altezza
                  senza lasciare un vuoto accanto. */}
              <BlockStack gap="400">
                <AccountCard
                  planName={account.planName}
                  productsSyncActive={account.productsSyncActive}
                  customersSyncActive={account.customersSyncActive}
                  productFeedsActive={account.productFeedsActive}
                  customersUpgradePlan={account.customersUpgradePlan}
                  preferences={{
                    locale: root?.locale ?? 'en',
                    currency: root?.currency ?? 'USD',
                  }}
                  locales={root?.locales ?? []}
                  currencies={root?.currencies ?? []}
                  onPreferencesChange={changeLocale}
                  localeSaving={localeFetcher.state !== 'idle'}
                />
                <SyncCard
                  frequencyHours={sync.frequencyHours}
                  lastSync={sync.lastSync}
                  nextSync={sync.nextSync}
                  timeZone={sync.timeZone}
                />
              </BlockStack>

              <DatabaseCard
                connected={account.connected}
                appUrl={config?.proxyBaseUrl || null}
                readKey={config?.readToken ?? null}
                databaseUrl={config?.databaseUrl ?? null}
                dashboardUrl={config?.dashboardUrl ?? null}
                header={
                  account.connected ? (
                    <BlockStack gap="300">
                      <SupabaseAccountConnect
                        connected
                        variant="row"
                        projectName={config?.projectRef ?? undefined}
                        projectUrl={config?.databaseUrl ?? undefined}
                      />
                      <SupabaseProjectConnect
                        connected
                        variant="menu"
                        projectName={config?.projectRef ?? undefined}
                        projectUrl={config?.databaseUrl ?? undefined}
                        authorization={authorization}
                        onPlanLimit={setPlanLimit}
                      />
                      {/* Il ref e' una sigla: il nome e' quello che dice al
                          merchant quale database sia. Compare solo se lo
                          conosciamo — i collegamenti fatti prima che lo
                          registrassimo non ce l'hanno. */}
                      {config?.projectName && (
                        <InlineStack
                          align="space-between"
                          blockAlign="center"
                          gap="300"
                          wrap={false}
                        >
                          <Text as="span" variant="bodyMd">
                            {t.database.name}
                          </Text>
                          <Text as="span" tone="subdued" truncate>
                            {config.projectName}
                          </Text>
                        </InlineStack>
                      )}
                    </BlockStack>
                  ) : undefined
                }
              />
            </InlineGrid>


          </BlockStack>
        </Layout.Section>
      </Layout>
      {/* Respiro in fondo: senza, il bordo della card tocca il fondo dell'iframe. */}
      <Box paddingBlockEnd="800" />
    </Page>
  );
}
