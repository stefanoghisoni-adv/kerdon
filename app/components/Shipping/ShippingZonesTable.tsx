import { Button, DataTable, Text } from '@shopify/polaris';
import { useT, useLocale } from '~/lib/i18n/context';
import { formatMoney } from '~/lib/billing/money';
import { formatIndicativeOptionCost } from './option-cost';
import type { OptionCostType } from '~/lib/shipping/types';

interface Option {
  id: string;
  name: string;
  costType: OptionCostType;
  rates: Array<{
    id: string;
    from: number | null;
    to: number | null;
    cost: number;
  }>;
}

interface Zone {
  id: string;
  zoneName: string;
  countries: string[];
  restOfWorld: boolean;
  rateType: 'linear' | 'brackets';
  rates: Array<{
    id: string;
    weightFromKg: number | null;
    weightToKg: number | null;
    cost: number;
  }>;
  options: Option[];
}

interface ShippingZonesTableProps {
  zones: Zone[];
  onEdit: (zone: Zone) => void;
  onEditOption: (option: Option, zone: Zone) => void;
}

export function ShippingZonesTable({ zones, onEdit, onEditOption }: ShippingZonesTableProps) {
  const t = useT();
  const locale = useLocale();

  const formatCountries = (zone: Zone): string => {
    if (zone.restOfWorld) {
      return t.shipping.restOfWorld;
    }

    const first = zone.countries.slice(0, 3);
    const others = zone.countries.length - 3;

    return t.shipping.countriesList(first, others);
  };

  const formatRateType = (rateType: 'linear' | 'brackets'): string => {
    return t.shipping.rateTypes[rateType];
  };

  const formatIndicativeCost = (zone: Zone): string => {
    if (zone.rates.length === 0) {
      return t.shipping.costDisplay.empty;
    }

    if (zone.rateType === 'linear') {
      const cost = zone.rates[0].cost;
      return t.shipping.costDisplay.linear(
        formatMoney(cost, 'EUR', locale)
      );
    }

    // Brackets: mostra il range dal costo minimo al massimo
    const costs = zone.rates.map(r => r.cost);
    const min = Math.min(...costs);
    const max = Math.max(...costs);

    if (min === max) {
      return formatMoney(min, 'EUR', locale);
    }

    return t.shipping.costDisplay.brackets(
      formatMoney(min, 'EUR', locale),
      formatMoney(max, 'EUR', locale)
    );
  };

  const getCostTypeLabel = (costType: OptionCostType): string => {
    const labels: Record<OptionCostType, string> = {
      flat: t.shipping.optionModal.flatLabel,
      linear: t.shipping.optionModal.linearLabel,
      weight_brackets: t.shipping.optionModal.weightBracketsLabel,
      value_brackets: t.shipping.optionModal.valueBracketsLabel,
    };
    return labels[costType];
  };

  // Build rows with options nested under each zone
  const rows: any[][] = [];

  zones.forEach((zone) => {
    // Main zone row
    rows.push([
      <Text as="span" fontWeight="semibold">{zone.zoneName}</Text>,
      formatCountries(zone),
      formatRateType(zone.rateType),
      formatIndicativeCost(zone),
      <Button onClick={() => onEdit(zone)} size="slim">
        {t.shipping.table.edit}
      </Button>,
    ]);

    // Option rows (indented)
    zone.options.forEach((option) => {
      rows.push([
        <Text as="span" tone="subdued">  • {option.name}</Text>,
        '', // No countries for options
        getCostTypeLabel(option.costType),
        formatIndicativeOptionCost(option.costType, option.rates, 'EUR', locale),
        <Button onClick={() => onEditOption(option, zone)} size="slim">
          {t.shipping.table.edit}
        </Button>,
      ]);
    });

    // Generic zone fallback row
    if (zone.options.length > 0) {
      rows.push([
        <Text as="span" tone="subdued">  • Tariffa generica della zona</Text>,
        '',
        formatRateType(zone.rateType),
        formatIndicativeCost(zone),
        '', // No edit for generic fallback
      ]);
    }
  });

  return (
    <DataTable
      columnContentTypes={['text', 'text', 'text', 'text', 'text']}
      headings={[
        t.shipping.table.zone,
        t.shipping.table.countries,
        t.shipping.table.rateType,
        t.shipping.table.indicativeCost,
        t.shipping.table.actions,
      ]}
      rows={rows}
    />
  );
}
