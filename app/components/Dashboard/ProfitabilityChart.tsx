import { lazy, Suspense, useEffect, useState } from 'react';
import { BlockStack, Box, Card, Text } from '@shopify/polaris';
import { formatMoney } from '~/lib/billing/money';
import { useLocale, useT } from '~/lib/i18n/context';

/** Stessi colori del grafico accanto: il blu e' il valore, il verde il profitto. */
export const VALUE_COLOR = '#13ACF0';
export const PROFIT_COLOR = '#1F8A5F';

const Canvas = lazy(() => import('./ProfitabilityChartCanvas'));

export interface ProfitabilityChartProps {
  aov: number | null;
  aop: number | null;
  ltv: number | null;
  ltp: number | null;
  currency: string;
  loading?: boolean;
}

/**
 * Quanto di cio' che incassi resta.
 *
 * Due confronti nello stesso riquadro, e sono la stessa domanda a due distanze:
 * su un ordine (valore contro profitto) e su un cliente nel tempo (LTV contro
 * LTP). Messi accanto si legge in un colpo d'occhio la cosa che le due colonne
 * gemelle nascondono quando sono su schermate diverse — che un valore alto non
 * significa un margine alto.
 *
 * Su tutti gli ordini e non sul mese: "nel tempo" e' meta' della domanda, e un
 * mese solo su un negozio stagionale direbbe quasi il contrario del vero.
 */
export function ProfitabilityChart({
  aov,
  aop,
  ltv,
  ltp,
  currency,
  loading,
}: ProfitabilityChartProps) {
  const t = useT();
  const locale = useLocale();
  // Il grafico esiste solo nel browser: in SSR si rende lo scheletro.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const empty = aov == null && ltv == null;

  return (
    <div className="chart-card">
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            {t.dashboard.profitability.title}
          </Text>
          <Text as="p" tone="subdued">
            {t.dashboard.profitability.subtitle}
          </Text>
        </BlockStack>

        <div className="chart-card__body">
          {loading || !mounted ? (
            <Box background="bg-surface-secondary" borderRadius="200" minHeight="260px" />
          ) : empty ? (
            <Text as="p" tone="subdued">
              {t.dashboard.profitability.empty}
            </Text>
          ) : (
            <Suspense
              fallback={
                <Box background="bg-surface-secondary" borderRadius="200" minHeight="260px" />
              }
            >
              <Canvas
                groups={[
                  {
                    name: t.dashboard.profitability.perOrder,
                    value: aov ?? 0,
                    profit: aop ?? 0,
                  },
                  {
                    name: t.dashboard.profitability.perCustomer,
                    value: ltv ?? 0,
                    profit: ltp ?? 0,
                  },
                ]}
                valueLabel={t.dashboard.profitability.value}
                profitLabel={t.dashboard.profitability.profit}
                formatValue={(amount: number) => formatMoney(amount, currency, locale)}
              />
            </Suspense>
          )}
        </div>
      </Card>
    </div>
  );
}
