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
  /**
   * Righe d'ordine di cui si conosce il costo, sul totale.
   *
   * Serve a spiegare una cosa che altrimenti sembra un errore: le barre del
   * profitto si muovono anche quando non e' cambiato nessun ordine. Il profitto
   * si calcola sulle sole righe con un costo noto, e quali prodotti siano
   * sincronizzati dipende dal piano — alzandolo ne entrano di piu' e il
   * profitto sale. Non perche' il negozio abbia guadagnato di piu': perche' se
   * ne sa di piu'.
   */
  coveredLines?: number;
  totalLines?: number;
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
  coveredLines,
  totalLines,
  loading,
}: ProfitabilityChartProps) {
  const t = useT();
  const locale = useLocale();
  // Il grafico esiste solo nel browser: in SSR si rende lo scheletro.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const empty = aov == null && ltv == null;

  // Solo quando manca davvero qualcosa: a copertura piena la riga direbbe
  // "calcolato su 120 righe su 120", che e' rumore.
  const partial =
    !empty &&
    totalLines != null &&
    coveredLines != null &&
    totalLines > 0 &&
    coveredLines < totalLines;

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
          {partial && (
            <Text as="p" tone="caution" variant="bodySm">
              {t.dashboard.profitability.partial(coveredLines!, totalLines!)}
            </Text>
          )}
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
