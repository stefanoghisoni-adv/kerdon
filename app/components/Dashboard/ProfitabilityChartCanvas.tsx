// Unico modulo che importa polaris-viz per questo grafico, come per l'altro:
// sta a parte ed e' caricato solo nel browser, perche' polaris-viz-core fa
// require('d3-scale'), che e' ESM-only e in SSR farebbe fallire il render.
import { BarChart, PolarisVizProvider } from '@shopify/polaris-viz';
import { PROFIT_COLOR, VALUE_COLOR } from './ProfitabilityChart';

interface Group {
  name: string;
  value: number;
  profit: number;
}

export default function ProfitabilityChartCanvas({
  groups,
  valueLabel,
  profitLabel,
  formatValue,
}: {
  groups: Group[];
  valueLabel: string;
  profitLabel: string;
  formatValue: (amount: number) => string;
}) {
  return (
    <PolarisVizProvider>
      <div className="chart-card__canvas">
        <BarChart
          theme="Light"
          data={[
            {
              name: valueLabel,
              color: VALUE_COLOR,
              data: groups.map((g) => ({ key: g.name, value: g.value })),
            },
            {
              name: profitLabel,
              color: PROFIT_COLOR,
              data: groups.map((g) => ({ key: g.name, value: g.profit })),
            },
          ]}
          xAxisOptions={{ labelFormatter: (value) => String(value) }}
          yAxisOptions={{ labelFormatter: (value) => formatValue(Number(value)) }}
        />
      </div>
    </PolarisVizProvider>
  );
}
