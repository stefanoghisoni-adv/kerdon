import { BlockStack, InlineStack, Icon, Text, Tooltip } from '@shopify/polaris';
import { CheckIcon, InfoIcon, XIcon } from '@shopify/polaris-icons';
import type { PlanFeature } from './plan-catalog';
import { sortFeatures } from './plan-features';
import { featureLabel } from './feature-label';
import { useT, useLocale } from '~/lib/i18n/context';

interface Props {
  features: PlanFeature[];
}

// Feature incluse in verde con la spunta, non incluse in grigio con la X; le
// verdi vengono ordinate in alto da sortFeatures (no-op sul catalogo attuale,
// che le elenca gia' in quest'ordine per tenere allineate le 4 card).
// wrap={false} tiene icona e testo sulla stessa riga: che la label non vada a
// capo dipende invece dalla sua lunghezza, verificata nei test del catalogo.
export function PlanFeatureList({ features }: Props) {
  const t = useT();
  const locale = useLocale();
  const sorted = sortFeatures(features);
  return (
    <BlockStack gap="300" inlineAlign="start">
      {sorted.map((feature) => (
        <InlineStack key={feature.key} align="start" gap="200" blockAlign="center" wrap={false}>
          <Icon
            source={feature.included ? CheckIcon : XIcon}
            tone={feature.included ? 'success' : 'subdued'}
          />
          <Text as="span" tone={feature.included ? 'success' : 'subdued'}>
            {featureLabel(feature, t, locale)}
          </Text>
          {/* "Multi-feed prodotto" e' l'unica riga che nomina una cosa invece
              di misurarla: chi sta scegliendo un piano non sa per forza cosa
              sia un feed, e senza spiegazione quella riga non lo aiuta a
              decidere. La spiegazione sta nel tooltip perche' scritta per
              esteso allungherebbe la card piu' delle altre tre. */}
          {feature.key === 'feeds' && (
            <Tooltip content={t.plan.features.feedsHelp}>
              <Icon source={InfoIcon} tone="subdued" />
            </Tooltip>
          )}
        </InlineStack>
      ))}
    </BlockStack>
  );
}
