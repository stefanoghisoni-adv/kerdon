import { Button, InlineStack, Text } from '@shopify/polaris';
import { StatCard } from './StatCard';
import { formatMoney } from '~/lib/billing/money';
import { useLocale, useT } from '~/lib/i18n/context';

export interface ProfitCardProps {
  profit: number | null;
  orders: number;
  change: number | null;
  coveredLines: number;
  totalLines: number;
  currency: string;
  unavailable: 'no_orders_access' | 'not_connected' | 'reconnect' | null;
  loading?: boolean;
  onFix?: () => void;
  fixLoading?: boolean;
}

/**
 * Il profitto del mese.
 *
 * E' la domanda per cui il merchant apre l'app — quanto ho guadagnato, e sta
 * salendo o scendendo. Nella riga sotto c'e' quanto ci si puo' fidare: la
 * percentuale di righe d'ordine che hanno davvero un costo, e il collegamento
 * per completarle. Non e' una nota tecnica — un profitto calcolato su meta'
 * delle righe e' meta' profitto.
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
    <StatCard
      label={t.dashboard.profit.title}
      hint={t.dashboard.profit.hint}
      value={
        loading || unavailable || profit == null
          ? '—'
          : formatMoney(profit, currency, locale)
      }
      // Verde o rosso senza altre parole: accanto a un numero grande la
      // direzione e' l'unica cosa che si guarda.
      trailing={
        !loading && !unavailable && change != null ? (
          <Text as="span" variant="bodySm" tone={change >= 0 ? 'success' : 'critical'}>
            {change >= 0 ? '+' : ''}
            {change}%
          </Text>
        ) : undefined
      }
      detail={
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Text as="span" variant="bodySm" tone={reliability != null && reliability < 100 ? 'caution' : 'subdued'}>
            {loading
              ? '—'
              : unavailable === 'reconnect'
                ? // Non e' "non ancora": e' "non piu'", e non si aggiusta da se'.
                  // Dire "dopo la prima sincronizzazione" qui sarebbe falso — quella
                  // sincronizzazione non avverra' finche' il merchant non ricollega.
                  t.dashboard.profit.reconnect
                : unavailable
                  ? t.dashboard.profit.unavailable
                : orders === 0
                  ? t.dashboard.profit.noOrders
                  : reliability != null && reliability < 100
                    ? t.dashboard.profit.reliability(reliability)
                    : t.dashboard.profit.orders(orders)}
          </Text>
          {!loading && !unavailable && reliability != null && reliability < 100 && onFix && (
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
      }
    />
  );
}
