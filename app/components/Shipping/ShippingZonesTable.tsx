import { Button, DataTable } from '@shopify/polaris';
import { useT, useLocale } from '~/lib/i18n/context';
import type { RateBracket } from '~/lib/shipping/types';
import { formatMoney } from '~/lib/billing/money';

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
}

interface ShippingZonesTableProps {
  zones: Zone[];
  onEdit: (zone: Zone) => void;
}

export function ShippingZonesTable({ zones, onEdit }: ShippingZonesTableProps) {
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

  const rows = zones.map((zone) => [
    zone.zoneName,
    formatCountries(zone),
    formatRateType(zone.rateType),
    formatIndicativeCost(zone),
    <Button onClick={() => onEdit(zone)} size="slim">
      {t.shipping.table.edit}
    </Button>,
  ]);

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
