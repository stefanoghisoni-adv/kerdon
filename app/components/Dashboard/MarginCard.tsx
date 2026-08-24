import { BlockStack, Card, InlineStack, Text } from '@shopify/polaris';
import { formatMoney } from '~/lib/billing/money';
import { useLocale, useT } from '~/lib/i18n/context';

export interface MarginCardProps {
  aov: number | null;
  aop: number | null;
  currency: string;
  loading?: boolean;
}

/**
 * Quanto resta di un ordine medio.
 *
 * Il valore medio di un ordine e' il numero che tutti guardano, e da solo si
 * puo' gonfiare con uno sconto o un prodotto in perdita. Accanto al profitto
 * medio dice l'altra meta': di quanto incasso, quanto resta davvero.
 *
 * La percentuale e' la sintesi — e' quella che si confronta con il mese scorso
 * o con un altro negozio — ma i due importi restano sotto, perche' una
 * percentuale senza le cifre non si sa su cosa sia calcolata.
 */
export function MarginCard({ aov, aop, currency, loading }: MarginCardProps) {
  const t = useT();
  const locale = useLocale();

  const margin =
    aov == null || aop == null || aov === 0 ? null : Math.round((aop / aov) * 100);

  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="headingMd">
          {t.dashboard.margin.title}
        </Text>

        <Text as="p" variant="heading2xl">
          {loading || margin == null ? '—' : `${margin}%`}
        </Text>

        {loading || aov == null ? (
          <Text as="p" tone="subdued">
            {t.dashboard.margin.noOrders}
          </Text>
        ) : (
          <BlockStack gap="050">
            <InlineStack gap="200" wrap={false}>
              <Text as="span" tone="subdued">
                {t.dashboard.margin.aov(formatMoney(aov, currency, locale))}
              </Text>
            </InlineStack>
            <Text as="span" tone="subdued">
              {t.dashboard.margin.aop(formatMoney(aop ?? 0, currency, locale))}
            </Text>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
