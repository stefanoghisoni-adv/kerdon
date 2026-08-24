import { Text } from '@shopify/polaris';
import { StatCard } from './StatCard';
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
 * puo' gonfiare con uno sconto o con un prodotto venduto in perdita. La
 * percentuale dice l'altra meta': di quanto incassi, quanto resta.
 */
export function MarginCard({ aov, aop, currency, loading }: MarginCardProps) {
  const t = useT();
  const locale = useLocale();

  const margin =
    aov == null || aop == null || aov === 0 ? null : Math.round((aop / aov) * 100);

  return (
    <StatCard
      label={t.dashboard.margin.title}
      hint={t.dashboard.margin.hint}
      value={loading || margin == null ? '—' : `${margin}%`}
      detail={
        <Text as="span" variant="bodySm" tone="subdued">
          {loading || aov == null
            ? t.dashboard.margin.noOrders
            : t.dashboard.margin.detail(
                formatMoney(aop ?? 0, currency, locale),
                formatMoney(aov, currency, locale),
              )}
        </Text>
      }
    />
  );
}
