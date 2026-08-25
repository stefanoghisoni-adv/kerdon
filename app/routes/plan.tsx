import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import type { LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import {
  useLoaderData,
  useFetcher,
  useSearchParams,
  useRevalidator,
} from '@remix-run/react';
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Box,
  Text,
  Button,
  ButtonGroup,
  Banner,
} from '@shopify/polaris';
import { SettingsIcon } from '@shopify/polaris-icons';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { buildPlanCards, type PlanCard } from '~/components/Billing/plan-catalog';
import { BASE_CURRENCY, formatMoney } from '~/lib/billing/money';
import { useLocale, useT } from '~/lib/i18n/context';
import { resolveShopPricing } from '~/lib/billing/shop-pricing.server';
import { wantedCurrency } from '~/lib/i18n/preferences';
import { type BillingInterval } from '~/lib/billing/partner-pricing';

import { shouldHighlightRecommended } from '~/components/Billing/plan-highlight';
import { PlanOptionGrid } from '~/components/Dashboard/PlanOptionGrid';
import { SETUP_CONTAINER } from '~/components/Dashboard/setup-container';
import { preselectedPlan } from '~/components/Dashboard/plan-step';
import { samePlanName } from '~/lib/billing/plan-name';
import { canAccessPlanTab } from '~/components/Billing/plan-access';
import {
  planButtonLabel,
  planButtonState,
  billingOutcome,
  billingBanner,
} from '~/components/Billing/plan-cta';
import { useEffect, useState } from 'react';
import { useNavLoading } from '~/components/Dashboard/nav-loading';

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  // Questa pagina esiste a configurazione conclusa: prima parlerebbe di dati
  // che non ci sono ancora. Chi ci arriva da un indirizzo salvato torna dove
  // il lavoro e' rimasto.
  await requireSetupComplete(session.shop);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  // Normalizzato in minuscolo per combaciare con gli id del catalogo. Se il piano
  // corrente non e' tra i 4 (es. 'lifetime'), nessuna card risultera' "attuale".
  const currentPlan = (shop?.currentPlan ?? '').toLowerCase();

  // Niente da comprare: le card si vedono lo stesso, spente. Nasconderle
  // lasciava una pagina vuota che sembrava rotta, e toglieva al merchant
  // l'unica cosa che poteva ancora volere da qui — sapere cosa contengono gli
  // altri piani.
  const blocked = !canAccessPlanTab(currentPlan);


  // Le card vengono dal listino registrato, non da una copia nel codice: nomi,
  // prezzi e limiti sono quelli che l'app applica davvero.
  const plans = await prisma.plan.findMany();
  // Listino riservato del partner a cui il negozio appartiene. Serve solo a
  // mostrare i prezzi giusti: quello che viene addebitato lo ricalcola comunque
  // /billing/subscribe leggendo il database, perche' il prezzo in fattura non
  // puo' dipendere da cosa il browser ha ricevuto.
  const partnerPrices = shop?.partnerName
    ? await prisma.partnerPlanPrice.findMany({ where: { partnerName: shop.partnerName } })
    : [];

  // Solo se ci sono davvero prezzi riservati: un partner senza listino non da'
  // diritto a niente, e annunciare una riduzione inesistente sarebbe peggio che
  // tacere.
  const partnerLabel =
    shop?.partnerName && partnerPrices.length > 0
      ? (await prisma.partner.findUnique({ where: { name: shop.partnerName } }))?.label ?? null
      : null;
  const reserved = Object.fromEntries(
    partnerPrices.map((p) => [
      p.planName,
      { priceMonthly: Number(p.priceMonthly), priceYearly: Number(p.priceYearly) },
    ]),
  );



  // Valuta del negozio e listino gia' scritto in quella valuta: i prezzi che si
  // leggono qui sono gli stessi che /billing/subscribe ricalcola per la fattura.
  const pricing = await resolveShopPricing(
    plans.map((plan) => ({
      planName: plan.planName,
      maxProducts: plan.maxProducts,
      maxCustomers: plan.maxCustomers,
      maxSyncFrequencyHours: plan.maxSyncFrequencyHours,
      customersSyncEnabled: plan.customersSyncEnabled,
      supportLevel: plan.supportLevel,
    })),
    { preferredCurrency: wantedCurrency(shop), hasReservedPrice: partnerPrices.length > 0 },
  );

  const cards = buildPlanCards(pricing.plans, reserved);

  return json({
    currentPlan,
    blocked,
    cards,
    // Per quanti cicli vale il prezzo riservato: serve a dirlo nella pagina,
    // altrimenti il merchant crede che quella cifra sia per sempre.
    discountIntervals: shop?.discountIntervals ?? null,
    // Nome per esteso del partner, da mostrare nel riquadro informativo. Si
    // legge da partners.label e non dal nome tecnico: "WeBeing", non "webeing".
    partnerLabel: partnerLabel,
    // La valuta viaggia con i prezzi: le card non devono indovinarla.
    currency: pricing.currency,
  });
}

// Contratto della risposta di /billing/subscribe (endpoint di un altro task).
type SubscribeResponse =
  | { confirmationUrl: string }   // serve uscire dall'iframe verso questo URL
  | { ok: true }                  // piano applicato subito (piano gratuito): ricarica
  | { error: string };            // messaggio già in italiano, da mostrare in un Banner

export default function Plan() {
  const { currentPlan, blocked, cards, discountIntervals, partnerLabel, currency } =
    useLoaderData<typeof loader>();
  const locale = useLocale();
  const t = useT();

  // Quanto si risparmia al massimo scegliendo l'annuale, sul listino che il
  // merchant vede davvero (riservato se ce l'ha). Serve alla riga accanto al
  // selettore: senza, l'annuale sembra solo un impegno piu' lungo.
  // Mensile di partenza: e' l'impegno piu' leggero, e chi arriva qui sta ancora
  // decidendo se il servizio gli serve.
  const [interval, setInterval] = useState<BillingInterval>('monthly');

  const yearlySaving = cards.reduce<number | null>((best, plan) => {
    const monthly = plan.partnerMonthly ?? plan.priceMonthly;
    const yearly = plan.partnerYearly ?? plan.priceYearly;
    if (!(monthly > 0) || !(yearly > 0)) return best;
    const saving = monthly * 12 - yearly;
    return saving > (best ?? 0) ? saving : best;
  }, null);

  // Il "Consigliato" si risalta solo se è un upgrade rispetto al piano attuale.
  const highlightRecommended = shouldHighlightRecommended(cards, currentPlan);

  // Spinner e disabilitazione solo se e' stato questo pulsante a far partire
  // la navigazione: dal menu laterale dell'admin deve restare fermo.
  const settings = useNavLoading('/settings/supabase');

  // Fetcher per inviare il POST a /billing/subscribe. Un fetcher per pagina, non
  // uno per card: lo stato locale (submittingPlan) traccia quale piano è in corso.
  const fetcher = useFetcher<SubscribeResponse>();
  const [submittingPlan, setSubmittingPlan] = useState<string | null>(null);

  // Il piano su cui si posa l'anello. Si parte da quello attivo: e' quello su
  // cui l'app sta lavorando, e presentarne un altro gia' scelto vorrebbe dire
  // far confermare una spesa a chi era passato solo a guardare.
  const [selectedPlan, setSelectedPlan] = useState(() => preselectedPlan(cards, currentPlan));
  const selectedIsCurrent = samePlanName(selectedPlan, currentPlan);

  // Legge il parametro querystring ?billing=ok|ko dopo il ritorno dal flusso.
  const [searchParams, setSearchParams] = useSearchParams();
  const outcome = billingOutcome(searchParams.get('billing'));

  // Gestione dell'errore generico: se il fetcher fallisce del tutto (es. network),
  // mostra un banner critico con messaggio generico.
  const [fetcherError, setFetcherError] = useState<string | null>(null);

  // Rilegge i dati della pagina senza ricaricare il documento. Ricaricarlo
  // significherebbe ripetere la richiesta della URL corrente del riquadro, che
  // non e' detto sia una pagina: e' cosi' che dopo un passaggio al piano
  // gratuito compariva una risposta grezza al posto della tab.
  const revalidator = useRevalidator();

  // Quando arriva confirmationUrl, naviga la finestra contenitore (uscita dall'iframe).
  // App Bridge intercetta open(..., '_top') e naviga il parent.
  useEffect(() => {
    if (fetcher.data && 'confirmationUrl' in fetcher.data) {
      window.open(fetcher.data.confirmationUrl, '_top');
    }
  }, [fetcher.data]);

  // Quando il fetcher completa, azzera lo stato di sottomissione.
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      setSubmittingPlan(null);
      // Se la risposta è { ok: true }, rilegge i dati della pagina: il piano
      // attuale è cambiato e le card devono rifletterlo.
      if ('ok' in fetcher.data && fetcher.data.ok) {
        revalidator.revalidate();
      }
      // Se c'è un errore nella risposta, lo mostra (il banner è renderizzato sotto).
      if ('error' in fetcher.data) {
        setFetcherError(fetcher.data.error);
      }
    }
    // revalidator fuori dalle dipendenze di proposito: revalidate() ne cambia lo
    // stato, e averlo qui rifarebbe partire l'effetto all'infinito.
  }, [fetcher.state, fetcher.data]);

  return (
    <Page
      fullWidth
      title={t.plan.title}
      backAction={{ url: '/', content: t.common.dashboard }}
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
      {/* Stessa larghezza dei passi della configurazione: sono le stesse card,
          e a larghezze diverse gli stessi quattro piani sembrano due cose
          diverse. */}
      <div style={SETUP_CONTAINER}>
      <BlockStack gap="500">
        {/* Piano assegnato da noi: le card restano visibili ma spente, e questo
            dice perche'. Sopra tutto il resto, o si legge dopo aver gia'
            provato a cliccare. */}
        {blocked && (
          <Banner tone="info" title={t.plan.blocked.title}>
            <Text as="p">{t.plan.blocked.body}</Text>
          </Banner>
        )}

        {/* Banner di esito dopo il ritorno dal flusso di addebito. */}
        {outcome === 'success' && (
          <Banner
            tone="success"
            title={t.plan.successBanner.title}
            onDismiss={() => {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete('billing');
                return next;
              });
            }}
          >
            <Text as="p">{t.plan.successBanner.message}</Text>
          </Banner>
        )}
        {outcome === 'error' && (
          <Banner
            tone="warning"
            title={t.plan.errorBanner.title}
            onDismiss={() => {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete('billing');
                return next;
              });
            }}
          >
            <Text as="p">{t.plan.errorBanner.message}</Text>
          </Banner>
        )}

        {/* Errore dalla risposta di /billing/subscribe. */}
        {fetcherError && (
          <Banner
            tone="critical"
            title={t.plan.errorTitle}
            onDismiss={() => setFetcherError(null)}
          >
            <Text as="p">{fetcherError}</Text>
          </Banner>
        )}

        {/* Intestazione informativa: riempie lo spazio sopra la griglia e dice
            cosa NON cambia al cambio di piano (dubbio tipico prima di pagare).
            Copy solo in termini di beneficio per il merchant: nessun riferimento a
            come l'app funziona dietro le quinte. */}
        {/* Condizione riservata, in cima a tutto: e' la prima cosa da sapere
            prima di guardare i prezzi, non una nota a margine da scoprire dopo
            averli gia' letti. Permanente e non chiudibile — resta vera finche'
            la collaborazione dura, e riguarda una cifra che il merchant paga. */}
        {partnerLabel && (
          <Banner tone="info" title={t.plan.reserved.title}>
            <Text as="p">
              {t.plan.reserved.before}
              <Text as="span" fontWeight="semibold">
                {partnerLabel}
              </Text>
              {t.plan.reserved.after}
              {discountIntervals != null
                ? t.plan.reserved.forRenewals(discountIntervals)
                : t.plan.reserved.end}
            </Text>
          </Banner>
        )}

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              {t.plan.intro.title}
            </Text>
            <Text as="p" tone="subdued">
              {t.plan.intro.body}
            </Text>
            <Text as="p" tone="subdued">
              {t.plan.intro.keepData}
            </Text>
          </BlockStack>
        </Card>

        {/* Scelta del ciclo di fatturazione. Sta sopra le card perche' cambia
            tutti i prezzi insieme: metterla dentro ciascuna card avrebbe fatto
            credere che si potesse pagare un piano al mese e un altro all'anno. */}
        <InlineStack gap="300" blockAlign="center">
          <ButtonGroup variant="segmented">
            <Button
              pressed={interval === 'monthly'}
              onClick={() => setInterval('monthly')}
            >
              {t.plan.monthly}
            </Button>
            <Button
              pressed={interval === 'yearly'}
              onClick={() => setInterval('yearly')}
            >
              {t.plan.yearly}
            </Button>
          </ButtonGroup>
          {/* Il risparmio dell'annuale va detto, non lasciato da calcolare: e'
              l'unica ragione per sceglierlo, e nessuno moltiplica per dodici. */}
          {interval === 'monthly' && yearlySaving != null && (
            <Text as="span" tone="subdued">
              {t.plan.yearlyHint(formatMoney(yearlySaving, currency, locale))}
            </Text>
          )}
          {interval === 'yearly' && discountIntervals != null && (
            <Text as="span" tone="subdued">
              {t.plan.reservedFor(discountIntervals)}
            </Text>
          )}
        </InlineStack>

        {/* Le stesse card del passo della configurazione: e' la stessa
            decisione, e mostrarla in due forme diverse costringerebbe a
            rileggerle entrambe per convincersi che dicono la stessa cosa. */}
        <PlanOptionGrid
          cards={cards}
          selected={selectedPlan}
          onSelect={setSelectedPlan}
          currentPlanName={currentPlan}
          recommendedPlanName={
            highlightRecommended ? (cards.find((plan) => plan.recommended)?.name ?? null) : null
          }
          discountIntervals={discountIntervals}
          interval={interval}
          currency={currency}
          disabled={blocked}
          loading={submittingPlan !== null}
        />

        {/* Un pulsante solo sotto la griglia, non uno per card: la scelta la
            fanno le card, qui si conferma. */}
        <InlineStack>
          <Button
            variant="primary"
            {...planButtonState(selectedPlan, selectedIsCurrent, submittingPlan)}
            // Niente da confermare: il piano lo assegniamo noi, e un pulsante
            // vivo sotto card spente prometterebbe una scelta che non c'e'.
            disabled={blocked || planButtonState(selectedPlan, selectedIsCurrent, submittingPlan).disabled}
            onClick={() => {
              setSubmittingPlan(selectedPlan);
              setFetcherError(null);
              fetcher.submit(
                { plan: selectedPlan, interval },
                { method: 'POST', action: '/billing/subscribe' },
              );
            }}
          >
            {planButtonLabel(selectedPlan, selectedIsCurrent, t)}
          </Button>
        </InlineStack>

        <Text as="p" tone="subdued" variant="bodySm" alignment="center">
          {t.plan.billedByShopify}
        </Text>
      </BlockStack>
      </div>

      {/* Respiro in fondo, come le altre tab. */}
      <Box paddingBlockEnd="800" />
    </Page>
  );
}
