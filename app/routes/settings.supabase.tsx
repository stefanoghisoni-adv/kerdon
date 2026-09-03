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
import { hasOrdersAccess } from '~/lib/sync/orders-access';
import { getReadProxyTokenForDisplay } from '~/lib/read-proxy/token.server';
import { AccountCard } from '~/components/Dashboard/AccountCard';
import { DatabaseCard, TrackingCredentialsCard } from '~/components/Dashboard/DatabaseCard';
import { DataRequestsCard } from '~/components/Dashboard/DataRequestsCard';
import { firstPlanWithCustomersSync, firstPlanWithFeeds } from '~/components/Dashboard/account-format';
import { samePlanName } from '~/lib/billing/plan-name';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilitiesWithPlan } from '~/lib/authz/shop-capabilities.server';
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

  // Il listino come serve ai due suggerimenti di upgrade: nome, prezzo e cosa
  // include. Costruito una volta e usato due, perche' e' la stessa domanda
  // fatta su due funzioni diverse.
  const planOptions = plans.map((p) => ({
    planName: p.planName,
    priceMonthly: monthlyOf.get(p.planName) ?? 0,
    customersSyncEnabled: p.customersSyncEnabled,
    productFeedsEnabled: p.productFeedsEnabled,
  }));

  const connected = !!shop?.supabaseConfig?.connectionVerifiedAt;
  // La sincronizzazione e' automatica e sempre attiva: non c'e' niente da
  // accendere. Restano le condizioni che non dipendono dal merchant — il
  // progetto collegato e il negozio autorizzato (a trial scaduto e' tutto
  // sospeso).
  //
  // Questa riga le rimetteva insieme a mano, con un confronto secco su
  // `'ENABLED'`: la stessa frase di altri venti posti, scritta un'altra volta e
  // libera di divergere alla prima modifica. Ora la risposta e' quella che i
  // processor useranno davvero, quindi cio' che il merchant legge qui e cio' che
  // succede non possono piu' raccontare due storie diverse.
  const caps = shopCapabilitiesWithPlan(shop, plan);
  const syncRunning = can(caps, 'sync_products');
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
    // Gli ordini non dipendono dal piano ma dal permesso: un negozio installato
    // prima che l'app li leggesse non l'ha concesso, e finche' non riautorizza
    // quella sincronizzazione non puo' avvenire. Vale la pena mostrarlo, perche'
    // e' anche il motivo per cui il profitto resta senza numeri.
    ordersSyncActive: syncRunning && hasOrdersAccess(shop?.scopes),
    customersSyncActive: syncRunning && customersIncluded,
    // Il riconoscimento fra dispositivi poggia sui dati dei clienti: dove
    // quelli non si sincronizzano non c'e' niente da riconoscere.
    matchingActive: syncRunning && customersIncluded,
    productFeedsActive: productFeedsIncluded,
    // Il piano da proporre si calcola solo quando serve davvero.
    customersUpgradePlan: customersIncluded
      ? null
      : firstPlanWithCustomersSync(
          planOptions,
          shop?.currentPlan ?? null,
        ),
    // Stessa domanda per i feed: qual e' il piano piu' economico che li ha.
    feedsUpgradePlan: productFeedsIncluded
      ? null
      : firstPlanWithFeeds(planOptions, shop?.currentPlan ?? null),
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

  // Le copie dei dati pronte da consegnare.
  //
  // Quando una persona chiede al negozio una copia dei propri dati, Shopify ce
  // lo dice ma la risposta la deve dare il titolare, entro trenta giorni: noi
  // prepariamo il file, lui lo ritira e lo gira a chi l'ha chiesto. Senza
  // questo elenco il file veniva preparato, aspettava trenta giorni e si
  // cancellava senza che nessuno potesse prenderlo.
  //
  // Solo quelle davvero ritirabili: completate, con la copia ancora presente e
  // dentro la sua finestra. Una riga che promette un file scaduto e' peggio di
  // nessuna riga.
  const dataRequests = (
    await prisma.complianceRequest.findMany({
      where: {
        shopDomain: session.shop,
        topic: 'customers/data_request',
        status: 'completed',
        exportExpiresAt: { gt: new Date() },
      },
      orderBy: { receivedAt: 'desc' },
      take: 20,
      select: { id: true, receivedAt: true, exportExpiresAt: true, customerRef: true },
    })
  ).map((r) => ({
    id: r.id,
    receivedAt: r.receivedAt.toISOString(),
    expiresAt: r.exportExpiresAt!.toISOString(),
    // Il riferimento breve distingue due pratiche nella stessa lista. L'id
    // della persona non passa di qui.
    ref: r.customerRef ? r.customerRef.slice(-8) : null,
  }));

  const config = shop?.supabaseConfig;
  if (!config) {
    return json({ account, config: null, sync, authorization, dataRequests });
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
    dataRequests,
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
  const { account, config, sync, authorization, dataRequests } =
    useLoaderData<typeof loader>();
  const t = useT();
  // L'avviso sul limite dei database: lo accende il menu dentro la card, e lo
  // rende questa pagina, in cima.
  // Il modulo di creazione di un database e' aperto: lo dice il componente che
  // lo ospita, perche' lo stato e' suo ma la riga da nascondere e' qui.
  const [creatingDatabase, setCreatingDatabase] = useState(false);

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
            {/* Una copia dei dati da consegnare ha una scadenza, e passata
                quella la richiesta resta senza risposta: sta prima di tutto il
                resto, e c'e' solo quando c'e' davvero qualcosa da ritirare. */}
            <DataRequestsCard requests={dataRequests ?? []} />

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
              // Senza, le due colonne si allungano fino all'altezza della piu'
              // alta: la card Database, che ha quattro righe, si stirava fino
              // in fondo alla colonna di sinistra e restava mezza vuota.
              alignItems="start"
            >
              {/* A sinistra le due card corte, impilate: cosi' la colonna
                  stretta si riempie e quella larga puo' crescere in altezza
                  senza lasciare un vuoto accanto. */}
              <BlockStack gap="400">
                <AccountCard
                  planName={account.planName}
                  productsSyncActive={account.productsSyncActive}
                  ordersSyncActive={account.ordersSyncActive}
                  matchingActive={account.matchingActive}
                  customersSyncActive={account.customersSyncActive}
                  productFeedsActive={account.productFeedsActive}
                  feedsUpgradePlan={account.feedsUpgradePlan}
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

              {/* A destra le due card del database, impilate: erano una accanto
                  all'altra come celle separate della griglia, e la seconda
                  finiva a capo sotto la colonna di sinistra. */}
              <BlockStack gap="400">
              <DatabaseCard
                connected={account.connected}
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
                        onCreatingChange={setCreatingDatabase}
                      />
                      {/* Il ref e' una sigla: il nome e' quello che dice al
                          merchant quale database sia. Compare solo se lo
                          conosciamo — i collegamenti fatti prima che lo
                          registrassimo non ce l'hanno. */}
                      {/* Mentre si sta creando un database la riga sparisce:
                          risponde a una domanda che in quel momento nessuno sta
                          facendo, e affiancata al modulo di creazione si legge
                          come se fosse il nome di quello che si sta creando.
                          Torna appena il modulo si chiude, per creazione
                          riuscita o per ripensamento. */}
                      {config?.projectName && !creatingDatabase && (
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

              {/* Le credenziali con cui il tracciamento legge da fuori: card a
                  se', perche' chi cerca il proprio database non sta cercando
                  loro e viceversa. */}
              <TrackingCredentialsCard
                connected={account.connected}
                appUrl={config?.proxyBaseUrl || null}
                readKey={config?.readToken ?? null}
              />
              </BlockStack>
            </InlineGrid>


          </BlockStack>
        </Layout.Section>
      </Layout>
      {/* Respiro in fondo: senza, il bordo della card tocca il fondo dell'iframe. */}
      <Box paddingBlockEnd="800" />
    </Page>
  );
}
