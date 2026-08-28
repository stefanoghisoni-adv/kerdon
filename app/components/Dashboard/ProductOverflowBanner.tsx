import { useEffect, useState } from 'react';
import { useFetcher } from '@remix-run/react';
import { Banner, BlockStack, InlineStack, Text } from '@shopify/polaris';
import { planLabel } from './account-format';
import { PlanUpgradeAction } from './PlanUpgradeAction';
import type { PlanUpgradeData } from './plan-upgrade-action';
import { BASE_CURRENCY } from '~/lib/billing/money';
import { useT } from '~/lib/i18n/context';
import { suggestPlanForProducts, type PlanForSuggestion } from './plan-suggestion';

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
  // Chiuso per questa visita, non per sempre: il tetto resta superato finche'
  // non si cambia piano, quindi alla prossima apertura la notizia e' ancora
  // vera. Ma va potuta togliere di mezzo per guardare il resto della pagina.
  const [dismissed, setDismissed] = useState(false);
  const t = useT();

  // I dati se li procura il componente, invece di riceverli: cosi' le pagine che
  // lo mostrano — dashboard, prodotti non idonei, logs — non devono ognuna
  // caricarseli nel proprio loader, e soprattutto non possono finire a mostrare
  // numeri diversi per la stessa cosa.
  //
  // La readiness ha gia' la sua cache, quindi sulle pagine diverse dalla
  // dashboard non costa una lettura del catalogo.
  const limits = useFetcher<LimitsResponse>();
  const readiness = useFetcher<ReadinessResponse>();
  // Quanti clienti hanno dato il consenso: serve solo dentro il confronto fra i
  // piani, accanto al tetto. Si chiede insieme agli altri due perche' il
  // confronto si apre da un clic e a quel punto e' tardi per andarlo a prendere.
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

  // Senza database collegato l'avviso non ha oggetto: nessun prodotto sta
  // restando fuori, perche' non ne sta entrando nessuno. Vale su tutte e tre le
  // pagine che lo mostrano.
  if (dismissed) return null;
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

  // Qui il listino e i conteggi ci sono gia' — senza, l'avviso non saprebbe
  // nemmeno se comparire — quindi il comando li riceve invece di richiederli:
  // il confronto si apre subito, senza un'attesa che non serve a niente.
  const upgradeData: PlanUpgradeData = {
    currentPlan,
    plans,
    currency: limits.data?.currency ?? BASE_CURRENCY,
    totalProducts,
    optIn: customerStats.data?.optIn ?? null,
  };

  return (
    <Banner
      tone={reason === 'feeds' ? 'info' : 'warning'}
      title={reason === 'feeds' ? undefined : t.overflow.title}
      onDismiss={() => setDismissed(true)}
    >
      <BlockStack gap="300">
        <Text as="p">
          {reason === 'feeds' ? (
            // Prima il motivo, poi l'invito: al contrario si leggeva "Aggiorna
            // a Business" senza sapere ancora perche', e i due pezzi — figli
            // JSX adiacenti — finivano pure attaccati, "BusinessI feed di
            // catalogo". Lo spazio va scritto: JSX non ne mette fra due nodi.
            <>
              {t.catalogs.planRequired}{' '}
              <PlanUpgradeAction plan={suggestedPlan.planName} data={upgradeData} />
            </>
          ) : (
            t.overflow.body(excluded, nextLabel)
          )}
        </Text>
        {/* Nel modo "feed" il comando e' gia' il collegamento dentro la frase:
            un pulsante sotto direbbe la stessa cosa una seconda volta. */}
        {reason === 'products' && (
          <InlineStack>
            <PlanUpgradeAction
              plan={suggestedPlan.planName}
              data={upgradeData}
              variant="primary"
              label={t.overflow.upgradeNow(nextLabel)}
              disabled={disabled}
            />
          </InlineStack>
        )}
      </BlockStack>
    </Banner>
  );
}
