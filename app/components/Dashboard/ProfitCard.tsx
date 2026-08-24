import { BlockStack, Button, Card, InlineStack, Text } from '@shopify/polaris';
import { formatMoney } from '~/lib/billing/money';
import { useLocale, useT } from '~/lib/i18n/context';

export interface ProfitCardProps {
  profit: number | null;
  orders: number;
  change: number | null;
  coveredLines: number;
  totalLines: number;
  currency: string;
  unavailable: 'no_orders_access' | 'not_connected' | null;
  loading?: boolean;
  onFix?: () => void;
  fixLoading?: boolean;
}

/**
 * Il profitto del mese, in cima a tutto.
 *
 * E' la domanda per cui il merchant apre l'app — quanto ho guadagnato, e sta
 * salendo o scendendo — e finora l'app sapeva rispondere senza scriverlo da
 * nessuna parte: la dashboard apriva con dei conteggi, che dicono se la
 * macchina gira, non come va l'azienda.
 *
 * Sotto il numero c'e' quanto ci si puo' fidare: la percentuale di righe
 * d'ordine che hanno davvero un costo. Non e' una nota tecnica — un profitto
 * calcolato su meta' delle righe e' meta' profitto, e la strada per completarlo
 * parte proprio da li'.
 */
export function ProfitCard({
  profit,
  orders,
  change,
  coveredLines,
  totalLines,
  currency,
  unavailable,
  loading,
  onFix,
  fixLoading,
}: ProfitCardProps) {
  const t = useT();
  const locale = useLocale();

  const reliability =
    totalLines === 0 ? null : Math.round((coveredLines / totalLines) * 100);

  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="headingMd">
          {t.dashboard.profit.title}
        </Text>

        {unavailable ? (
          <Text as="p" tone="subdued">
            {t.dashboard.profit.unavailable}
          </Text>
        ) : (
          <BlockStack gap="200">
            <InlineStack gap="300" blockAlign="baseline" wrap={false}>
              <Text as="p" variant="heading3xl">
                {loading || profit == null ? '—' : formatMoney(profit, currency, locale)}
              </Text>
              {/* Verde o rosso, senza altre parole: la direzione e' l'unica cosa
                  che si guarda accanto a un numero grande. */}
              {!loading && change != null && (
                <Text as="span" tone={change >= 0 ? 'success' : 'critical'}>
                  {change >= 0 ? '+' : ''}
                  {change}%
                </Text>
              )}
            </InlineStack>

            <Text as="p" tone="subdued">
              {loading ? '—' : orders === 0 ? t.dashboard.profit.noOrders : t.dashboard.profit.orders(orders)}
            </Text>

            {/* Quanto di quel numero e' vero, e come renderlo piu' vero. */}
            {!loading && reliability != null && (
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <Text
                  as="span"
                  variant="bodySm"
                  tone={reliability === 100 ? 'subdued' : 'caution'}
                >
                  {reliability === 100
                    ? t.dashboard.profit.complete
                    : t.dashboard.profit.reliability(reliability)}
                </Text>
                {reliability < 100 && onFix && (
                  <Button
                    variant="plain"
                    url="/products/issues"
                    onClick={onFix}
                    loading={fixLoading}
                    disabled={fixLoading}
                  >
                    {t.dashboard.profit.fix}
                  </Button>
                )}
              </InlineStack>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
