import { useCallback, useEffect, useState } from 'react';
import { useFetcher } from '@remix-run/react';
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  InlineStack,
  Link,
  Modal,
  Text,
} from '@shopify/polaris';
import { planLabel } from './account-format';
import { BASE_CURRENCY } from '~/lib/billing/money';
import { useLocale, useT } from '~/lib/i18n/context';
import {
  planComparisonRows,
  suggestPlanForProducts,
  type PlanForSuggestion,
} from './plan-suggestion';

/** Larghezza delle due colonne dei valori: uguale, cosi' restano incolonnate. */
const VALUE_COLUMN = '120px';

type SubscribeResponse =
  | { confirmationUrl: string }
  | { ok: true }
  | { error: string };

export interface ProductOverflowBannerProps {
  disabled?: boolean;
  /**
   * Cosa manca, e quindi cosa si sta proponendo.
   *
   * `products` e' il caso originale: il catalogo non ci sta nel piano.
   * `feeds` lo riusa per i cataloghi pubblicitari — cambia il testo del banner,
   * non il modal: la domanda che si fa il merchant e' la stessa ("cosa ottengo
   * passando di piano?") e merita la stessa risposta, non due tabelle diverse.
   */
  reason?: 'products' | 'feeds';
}

interface LimitsResponse {
  /** false = nessun database collegato: non c'e' nessuna sincronizzazione di cui avvisare. */
  connected?: boolean;
  currentPlanName?: string | null;
  currentPlan?: PlanForSuggestion | null;
  plans?: PlanForSuggestion[];
  /** Valuta in cui sono scritti i prezzi qui sopra. */
  currency?: string;
}

interface ReadinessResponse {
  readyCount: number;
  problemCount: number;
}

/**
 * Avviso per chi ha piu' prodotti di quanti il suo piano ne sincronizzi.
 *
 * Distinto dall'avviso di quota in esaurimento: quello dice che lo spazio sta
 * finendo, questo che una parte del catalogo resta gia' fuori. E soprattutto
 * porta con se' la soluzione, invece di rimandare a un'altra pagina: il nome
 * del piano che basta e' gia' calcolato, e l'aggiornamento si conferma qui.
 */
export function ProductOverflowBanner({
  disabled,
  reason = 'products',
}: ProductOverflowBannerProps) {
  const [confirming, setConfirming] = useState(false);
  const locale = useLocale();
  const t = useT();
  const fetcher = useFetcher<SubscribeResponse>();
  const submitting = fetcher.state !== 'idle';

  // I dati se li procura il componente, invece di riceverli: cosi' le pagine che
  // lo mostrano — dashboard, prodotti non idonei, logs — non devono ognuna
  // caricarseli nel proprio loader, e soprattutto non possono finire a mostrare
  // numeri diversi per la stessa cosa.
  //
  // La readiness ha gia' la sua cache, quindi sulle pagine diverse dalla
  // dashboard non costa una lettura del catalogo.
  const limits = useFetcher<LimitsResponse>();
  const readiness = useFetcher<ReadinessResponse>();
  // Quanti clienti hanno dato il consenso: serve solo dentro il modal, accanto
  // al tetto del piano. Si chiede insieme agli altri due perche' il modal si
  // apre da un clic e a quel punto e' tardi per andarlo a prendere.
  const customerStats = useFetcher<{ optIn?: number }>();
  useEffect(() => {
    if (limits.state === 'idle' && !limits.data) limits.load('/api/plan/limits');
    if (readiness.state === 'idle' && !readiness.data) readiness.load('/api/stats/products');
    if (customerStats.state === 'idle' && !customerStats.data) {
      customerStats.load('/api/stats/customers');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentPlan = limits.data?.currentPlan ?? null;
  const totalProducts =
    readiness.data != null ? readiness.data.readyCount + readiness.data.problemCount : null;
  const plans = limits.data?.plans ?? [];
  const suggestedPlan =
    reason === 'feeds'
      ? // Il piu' economico fra quelli che hanno i feed: qui non c'e' un tetto
        // da superare, c'e' una funzione da ottenere.
        plans
          .filter((p) => p.productFeedsEnabled)
          .sort((a, b) => a.priceMonthly - b.priceMonthly)[0] ?? null
      : currentPlan && totalProducts != null
        ? suggestPlanForProducts(plans, currentPlan.planName, totalProducts)
        : null;

  const confirm = useCallback(() => {
    if (!suggestedPlan) return;
    fetcher.submit(
      { plan: suggestedPlan.planName },
      { method: 'POST', action: '/billing/subscribe' },
    );
  }, [fetcher, suggestedPlan]);

  // Shopify vuole la conferma dell'addebito fuori dal riquadro dell'app: si
  // esce dall'iframe, non si naviga dentro.
  const confirmationUrl =
    fetcher.data && 'confirmationUrl' in fetcher.data ? fetcher.data.confirmationUrl : null;
  if (confirmationUrl && typeof window !== 'undefined') {
    window.top?.location.replace(confirmationUrl);
  }

  // Senza database collegato l'avviso non ha oggetto: nessun prodotto sta
  // restando fuori, perche' non ne sta entrando nessuno. Vale su tutte e tre le
  // pagine che lo mostrano.
  if (reason === 'products' && limits.data?.connected === false) return null;
  if (!suggestedPlan || !currentPlan) return null;
  if (reason === 'products' && totalProducts == null) return null;
  // Il piano li ha gia': non c'e' niente da proporre.
  if (reason === 'feeds' && currentPlan.productFeedsEnabled) return null;

  const nextLabel = planLabel(suggestedPlan.planName);
  const excluded =
    currentPlan.maxProducts == null || totalProducts == null
      ? 0
      : totalProducts - currentPlan.maxProducts;
  const rows = planComparisonRows(
    currentPlan,
    suggestedPlan,
    limits.data?.currency ?? BASE_CURRENCY,
    locale,
    t,
    { products: totalProducts, customers: customerStats.data?.optIn ?? null },
  );
  const error = fetcher.data && 'error' in fetcher.data ? fetcher.data.error : null;

  return (
    <>
      <Banner
        tone={reason === 'feeds' ? 'info' : 'warning'}
        title={reason === 'feeds' ? undefined : t.overflow.title}
      >
        <BlockStack gap="300">
          <Text as="p">
            {reason === 'feeds' ? (
              <>
                <Link onClick={() => setConfirming(true)} removeUnderline>
                  {t.account.upgradeTo(nextLabel)}
                </Link>
                {t.catalogs.planRequired}
              </>
            ) : (
              t.overflow.body(excluded, nextLabel)
            )}
          </Text>
          {error && <Text as="p" tone="critical">{error}</Text>}
          {/* Nel modo "feed" il comando e' gia' il link dentro la frase: un
              pulsante sotto direbbe la stessa cosa una seconda volta. */}
          {reason === 'products' && (
            <InlineStack>
              <Button
                variant="primary"
                onClick={() => setConfirming(true)}
                disabled={disabled || submitting}
              >
                {t.overflow.upgradeNow(nextLabel)}
              </Button>
            </InlineStack>
          )}
        </BlockStack>
      </Banner>

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t.overflow.modalTitle(nextLabel)}
        primaryAction={{
          content: t.overflow.confirm,
          onAction: confirm,
          loading: submitting,
          disabled: submitting,
        }}
        secondaryActions={[
          { content: t.overflow.cancel, onAction: () => setConfirming(false), disabled: submitting },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {/* Le due colonne dei valori hanno la STESSA larghezza fissa. Senza,
                ognuna si dimensionava sul proprio contenuto e i numeri finivano
                addosso all'intestazione della colonna accanto, riga per riga in
                posizioni diverse: la tabella smetteva di leggersi per colonne. */}
            <InlineStack gap="400" align="space-between" blockAlign="center">
              <Text as="span" variant="bodySm" tone="subdued">
                {t.overflow.whatChanges}
              </Text>
              <InlineStack gap="300" blockAlign="center">
                <Box minWidth={VALUE_COLUMN}>
                  <InlineStack align="end">
                    <Text as="span" variant="bodySm" tone="subdued">
                      {planLabel(currentPlan.planName)}
                    </Text>
                  </InlineStack>
                </Box>
                <Box minWidth={VALUE_COLUMN}>
                  <InlineStack align="end">
                    <Text as="span" variant="bodySm" tone="subdued">
                      {nextLabel}
                    </Text>
                  </InlineStack>
                </Box>
              </InlineStack>
            </InlineStack>

            {rows.map((row) => (
              <InlineStack key={row.label} gap="400" align="space-between" blockAlign="center">
                <Text as="span">
                  {row.label}
                  {/* Il numero di adesso, nello stesso grigio della riga in
                      fondo al modal: e' un termine di paragone, non un altro
                      dato da leggere. */}
                  {row.note && (
                    <>
                      {' '}
                      <Text as="span" tone="subdued">
                        {row.note}
                      </Text>
                    </>
                  )}
                </Text>
                <InlineStack gap="300" blockAlign="center">
                  {/* Il valore che si lascia resta in grigio: e' il termine di
                      paragone, non una cosa da leggere per prima. */}
                  <Box minWidth={VALUE_COLUMN}>
                    <InlineStack align="end">
                      <Text as="span" tone="subdued">
                        {row.current}
                      </Text>
                    </InlineStack>
                  </Box>
                  <Box minWidth={VALUE_COLUMN}>
                    <InlineStack align="end">
                      <Badge tone="success">{row.next}</Badge>
                    </InlineStack>
                  </Box>
                </InlineStack>
              </InlineStack>
            ))}

            <Text as="p" tone="subdued">
              L&apos;addebito viene confermato da te su Shopify: da qui non parte nessun pagamento.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </>
  );
}
