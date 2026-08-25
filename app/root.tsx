import type { LinksFunction, LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useEffect } from 'react';
import {
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useRouteLoaderData,
  useRouteError,
  isRouteErrorResponse,
} from '@remix-run/react';
import { AppProvider } from '@shopify/shopify-app-remix/react';
import { NavMenu } from '@shopify/app-bridge-react';
import polarisStyles from '@shopify/polaris/build/esm/styles.css?url';
import vizStyles from '@shopify/polaris-viz/build/esm/styles.css?url';
// Caricato DOPO Polaris: neutralizza il tema scuro (vedi force-light.css).
import forceLightStyles from './force-light.css?url';
// Impaginazioni che Polaris non esprime con una prop (vedi dashboard.css).
import dashboardStyles from './dashboard.css?url';
import { Page, Banner, Text, BlockStack } from '@shopify/polaris';
import { authenticate } from './shopify.server';
import { prisma } from './db.server';
import { canAccessPlanTab } from './components/Billing/plan-access';
import { adminAppUrl, reloadWholePage } from './utils/admin-page';
import { FALLBACK_LOCALE } from './lib/i18n/locales';
import {
  currencyOptions,
  localeFromTag,
  localeOptions,
  wantedCurrency,
  wantedLocale,
} from './lib/i18n/preferences';
import { I18nProvider, dictionaryFor } from './lib/i18n/context';
import { isSetupComplete } from './lib/setup/setup-state.server';
import { completeCurrenciesCached } from './lib/billing/shop-pricing.server';
import { resolveShopCurrency } from './lib/billing/currency';
import { BASE_CURRENCY } from './lib/billing/money';

// Rete di sicurezza del tema chiaro, in linea nel documento e DOPO i fogli di
// stile: force-light.css fa il lavoro completo, ma e' un file esterno, e se per
// qualsiasi motivo non arriva (ordine diverso in una pagina d'errore, richiesta
// caduta) la pagina resterebbe scura. Qui ci sono i soli token che decidono se
// una schermata si legge: sfondo, superfici, testo, bordi.
const FORCE_LIGHT_CRITICAL = `
:root,html,body{color-scheme:light !important}
html,body{background:#f1f1f1 !important}
:root:not(.p-theme-light-high-contrast-experimental),
[class*="p-theme-dark"]{
  color-scheme:light !important;
  --p-color-bg:#f1f1f1 !important;
  --p-color-bg-surface:#fff !important;
  --p-color-bg-surface-secondary:#f7f7f7 !important;
  --p-color-bg-surface-tertiary:#f3f3f3 !important;
  --p-color-bg-fill:#fff !important;
  --p-color-text:#303030 !important;
  --p-color-text-secondary:#616161 !important;
  --p-color-border:#e3e3e3 !important;
  --p-color-border-secondary:#ebebeb !important;
  --p-color-icon:#4a4a4a !important;
}`;

export const links: LinksFunction = () => [
  { rel: 'stylesheet', href: polarisStyles },
  { rel: 'stylesheet', href: vizStyles },
  { rel: 'stylesheet', href: forceLightStyles },
  { rel: 'stylesheet', href: dashboardStyles },
];

export async function loader({ request }: LoaderFunctionArgs) {
  // apiKey is the public Client ID; safe to expose to the embedded frontend.
  const apiKey = process.env.SHOPIFY_API_KEY || '';

  // La NavMenu vive qui, quindi il piano corrente serve gia' in root per decidere
  // se mostrare la voce "Piano". Ogni rotta UI autentica comunque, quindi non
  // stiamo introducendo un controllo nuovo: qui aggiungiamo solo la lettura.
  try {
    const { session } = await authenticate.admin(request);
    const shop = await prisma.shop.findUnique({
      where: { shopDomain: session.shop },
      select: {
        id: true,
        currentPlan: true,
        locale: true,
        preferredCurrency: true,
        detectedLocale: true,
        partnerName: true,
      },
    });

    // Shopify dichiara la lingua dell'admin in coda alla URL, ma solo quando e'
    // lui ad aprire l'app: alle navigazioni interne quel parametro non c'e'.
    // Quando arriva lo si ricorda, cosi' la lingua non cambia a meta' sessione.
    const declared = new URL(request.url).searchParams.get('locale');
    if (shop && declared && localeFromTag(declared) !== shop.detectedLocale) {
      // Best effort: e' una preferenza, non un dato su cui si regge una pagina.
      prisma.shop
        .update({ where: { id: shop.id }, data: { detectedLocale: localeFromTag(declared) } })
        .catch(() => {});
    }

    // Lingua e valuta: due scelte, prese nello stesso comando.
    const locale = wantedLocale(shop, declared);
    const wanted = wantedCurrency(shop, declared);

    // Un prezzo riservato tiene il negozio nella valuta in cui l'accordo e'
    // stato fatto: le etichette devono dirlo, non promettere altro.
    const hasReservedPrice = shop?.partnerName
      ? (await prisma.partnerPlanPrice.count({ where: { partnerName: shop.partnerName } })) > 0
      : false;
    const complete = await completeCurrenciesCached();
    // Si offrono solo le valute che il listino ha davvero: una valuta senza
    // prezzi, scelta, finirebbe per addebitarne un'altra.
    const currencies = currencyOptions(hasReservedPrice ? [] : complete);
    // E la valuta in uso e' quella che il negozio otterrebbe davvero.
    const currency = resolveShopCurrency({
      shopCurrency: wanted,
      complete,
      hasReservedPrice,
    });

    return json({
      apiKey,
      canSeePlanTab: canAccessPlanTab(shop?.currentPlan),
      // Finche' la configurazione e' aperta il menu ha una voce sola: le altre
      // pagine parlano di dati che ancora non esistono, e offrirle significa
      // invitare a uscire da meta' di un lavoro. Si legge qui perche' e' qui
      // che vive il menu.
      setupComplete: await isSetupComplete(session.shop),
      // La lingua sta in root perche' la usa tutta l'app, menu compreso. La
      // scelta del merchant vince su tutto; senza una scelta si segue l'admin.
      locale,
      currency,
      locales: localeOptions(),
      currencies,
      // Serve alla pagina d'errore per ricaricare la pagina dell'admin. Si
      // ricava dalla sessione e non dai parametri della URL, che una
      // navigazione interna si porta via.
      adminAppUrl: adminAppUrl(session.shop, apiKey),
    });
  } catch (error) {
    // I redirect di OAuth/App Bridge sono Response lanciate: devono passare
    // intatte. Un guasto diverso (es. DB irraggiungibile) non deve far fallire
    // l'intera app per una voce di menu: la rotta /plan si difende comunque da se'.
    if (error instanceof Response) throw error;
    return json({
      apiKey,
      canSeePlanTab: true,
      adminAppUrl: null,
      locale: FALLBACK_LOCALE,
      currency: BASE_CURRENCY,
      locales: localeOptions(),
      currencies: currencyOptions([]),
      // Non sapendo a che punto sia, si mostra il menu intero: nascondere
      // pagine per un guasto nostro sarebbe peggio del guasto.
      setupComplete: true,
    });
  }
}

/**
 * Guscio del documento, condiviso fra l'app e la pagina d'errore.
 *
 * Esportato come `Layout`: Remix lo applica a entrambe. Prima le due parti lo
 * ripetevano identico, ma un errore avvenuto durante una navigazione nel
 * browser faceva rendere a React un secondo <html> dentro quello gia'
 * esistente. Il browser scartava il duplicato e con lui la classe del tema e lo
 * stile qui sotto: il riquadro dell'app tornava scuro, ogni volta, dopo ogni
 * errore. Con un guscio solo quel caso non si pone.
 */
export function Layout({ children }: { children: React.ReactNode }) {
  return (
    // className p-theme-light nel JSX, non solo via App Bridge a runtime: così
    // React tiene ferma la classe del tema chiaro anche durante un render
    // d'errore, senza dipendere dal momento in cui App Bridge la applica.
    <html lang="it" className="p-theme-light">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Forza sempre il tema chiaro: Polaris è light-only e non vogliamo che
            il canvas del browser in dark mode traspaia dietro le superfici. */}
        <meta name="color-scheme" content="light" />
        <Meta />
        <Links />
        {/* Dopo <Links />: in coda al documento vince sull'ordine, oltre che
            per !important. */}
        <style dangerouslySetInnerHTML={{ __html: FORCE_LIGHT_CRITICAL }} />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Quanto si aspetta prima di ricaricare una seconda volta per lo stesso motivo.
 * Se il file mancasse davvero — non per un rilascio appena andato online — un
 * ricaricamento immediato girerebbe all'infinito.
 */
const ASSET_RELOAD_KEY = 'coreward:asset-reload';
const ASSET_RELOAD_GRACE_MS = 15_000;

/**
 * L'app si ricarica da sola quando il suo codice non c'e' piu'.
 *
 * Ogni rilascio produce file con nomi nuovi, e la scheda rimasta aperta continua
 * a chiedere quelli di prima. Cambiando sezione, il pezzo di codice di quella
 * pagina rispondeva 404: la navigazione interna falliva, il browser ripiegava su
 * una richiesta normale senza i parametri di Shopify e il merchant finiva sulla
 * pagina di accesso — o davanti a una risposta grezza — invece che nella tab che
 * aveva chiesto.
 *
 * Vite avvisa quando un pezzo non si carica: qui si ricarica la pagina, che
 * torna con i nomi giusti. Una volta sola per volta, per non entrare in un giro
 * senza fine se il file manca per davvero.
 */
function useReloadOnStaleAssets(): void {
  useEffect(() => {
    function onPreloadError(event: Event) {
      event.preventDefault();
      const last = Number(window.sessionStorage.getItem(ASSET_RELOAD_KEY) ?? 0);
      if (Date.now() - last < ASSET_RELOAD_GRACE_MS) return;
      window.sessionStorage.setItem(ASSET_RELOAD_KEY, String(Date.now()));
      window.location.reload();
    }
    window.addEventListener('vite:preloadError', onPreloadError);
    return () => window.removeEventListener('vite:preloadError', onPreloadError);
  }, []);
}

export default function App() {
  const { apiKey, locale, setupComplete } = useLoaderData<typeof loader>();
  useReloadOnStaleAssets();

  // Le voci del menu vivono fuori dal provider della lingua — la NavMenu e' un
  // fratello, non un figlio — quindi il dizionario si prende qui, dalla lingua
  // gia' risolta dal loader.
  const strings = dictionaryFor(locale);
  const menu = {
    home: setupComplete ? strings.common.dashboard : strings.nav.configuration,
    productIssues: strings.common.productIssues,
    customers: strings.customers.title,
    catalogs: strings.catalogs.title,
    logs: strings.common.logs,
    plan: strings.common.plan,
    settings: strings.common.settings,
  };

  return (
      <I18nProvider locale={locale}>
        <AppProvider isEmbeddedApp apiKey={apiKey} theme="light">
          {/* `key`: il menu dell'admin non e' React, e' l'elemento
              <ui-nav-menu> che App Bridge legge quando compare. Cambiando i
              link dentro un elemento gia' in pagina l'admin non se ne accorge —
              a configurazione conclusa il menu restava a una voce sola finche'
              non si ricaricava. Con una chiave diversa React sostituisce
              l'elemento, e il menu viene riletto da capo. */}
          <NavMenu key={setupComplete ? 'menu-full' : 'menu-setup'}>
            {/* rel="home" e' la radice dell'app: l'admin la usa per il nome
                dell'app in cima al menu e non la elenca come voce. Serve quindi
                un secondo link alla stessa pagina, che e' quello visibile —
                senza, per tornare alla dashboard bisogna cliccare il nome. */}
            <Link to="/" rel="home">
              {menu.home}
            </Link>
            <Link to="/">{menu.home}</Link>
            {/* Durante la configurazione il menu si ferma qui: le altre pagine
                mostrerebbero numeri che ancora non esistono, e offrirle mentre
                c'e' un passo aperto e' un invito a uscire da meta' lavoro. Non
                e' solo una scelta di menu — le rotte stesse rimandano qui. */}
            {setupComplete && (
              <>
                <Link to="/products/issues">{menu.productIssues}</Link>
                {/* Fra i prodotti e i log: e' l'altra faccia dello stesso dato
                    — cosa e' stato venduto, e a chi. */}
                <Link to="/customers">{menu.customers}</Link>
                {/* Dopo i clienti: il catalogo pubblicato verso le piattaforme
                    e' l'ultimo anello — prima si sistemano i dati, poi si
                    mandano fuori. */}
                <Link to="/catalogs">{menu.catalogs}</Link>
                <Link to="/logs">{menu.logs}</Link>
                {/* C'e' sempre, anche sui piani senza nulla da acquistare: il
                    menu dell'admin non sa disabilitare una voce — sono <a>, e
                    un <a> spento non esiste — quindi o si toglie o si lascia.
                    Toglierla faceva sembrare persa una sezione che invece esiste
                    e ha una risposta da dare; ora la risposta e' dentro /plan. */}
                <Link to="/plan">{menu.plan}</Link>
                <Link to="/settings/supabase">{menu.settings}</Link>
              </>
            )}
          </NavMenu>
          <Outlet />
        </AppProvider>
      </I18nProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  // Il loader di root normalmente riesce anche quando una rotta figlia lancia:
  // recuperiamo apiKey per mantenere il frame embedded (App Bridge + NavMenu).
  const rootData = useRouteLoaderData<typeof loader>('root');
  const apiKey = rootData?.apiKey || '';
  // Se anche il loader di root e' saltato non sappiamo il piano: meglio mostrare
  // la voce (chi non deve entrarci trova comunque la rotta bloccata) che toglierla
  // a chi invece vuole fare upgrade.
  const canSeePlanTab = rootData?.canSeePlanTab ?? true;
  const adminUrl = rootData?.adminAppUrl ?? null;
  // Anche la pagina d'errore parla la lingua del merchant. Qui non c'e' il
  // provider — Remix rende questa al posto dell'app — quindi il dizionario si
  // prende dalla lingua che il loader di root aveva gia' risolto, e se e'
  // saltato anche quello resta la lingua di riserva.
  const strings = dictionaryFor(rootData?.locale ?? FALLBACK_LOCALE);

  let title = strings.errorPage.title;
  let detail = strings.errorPage.unknown;
  // Un errore di rete lato client ("Failed to fetch") non è un guasto dell'app:
  // è la connessione dell'utente caduta durante una richiesta. Va trattato come
  // transitorio e recuperabile, non con un allarme rosso da errore fatale.
  let transient = false;

  if (isRouteErrorResponse(error)) {
    title = strings.errorPage.status(error.status, error.statusText);
    detail =
      typeof error.data === 'string'
        ? error.data
        : JSON.stringify(error.data);
  } else if (error instanceof Error) {
    detail = error.message;
    if (/failed to fetch|networkerror|load failed/i.test(error.message)) {
      transient = true;
      title = strings.errorPage.offlineTitle;
      detail = strings.errorPage.offlineBody;
    }
  }

  return (
        <AppProvider isEmbeddedApp apiKey={apiKey} theme="light">
          <NavMenu>
            {/* rel="home" e' la radice dell'app: l'admin la usa per il nome
                dell'app in cima al menu e non la elenca come voce. Serve quindi
                un secondo link alla stessa pagina, che e' quello visibile —
                senza, per tornare alla dashboard bisogna cliccare il nome. */}
            <Link to="/" rel="home">
              {strings.common.dashboard}
            </Link>
            <Link to="/">{strings.common.dashboard}</Link>
            <Link to="/products/issues">{strings.common.productIssues}</Link>
            <Link to="/logs">{strings.common.logs}</Link>
            {canSeePlanTab && <Link to="/plan">{strings.common.plan}</Link>}
            <Link to="/settings/supabase">{strings.common.settings}</Link>
          </NavMenu>
          <Page title="CoreWard">
            <BlockStack gap="400">
              {/* Warning (non critical) per i blip di rete. Il pulsante ricarica
                  la pagina dell'admin, non il solo iframe dell'app: ricaricare
                  l'iframe ripete la richiesta della sua URL corrente, che dopo
                  una navigazione interna puo' non essere una pagina dell'app. */}
              <Banner
                tone={transient ? 'warning' : 'critical'}
                title={title}
                action={
                  transient
                    ? {
                        content: strings.errorPage.refresh,
                        onAction: () => reloadWholePage(adminUrl, window),
                      }
                    : undefined
                }
              >
                <Text as="p">{detail}</Text>
              </Banner>
            </BlockStack>
          </Page>
        </AppProvider>
  );
}
