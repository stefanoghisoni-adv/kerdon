import { Fragment } from 'react';
import { Badge, BlockStack, Button, IndexTable, Text } from '@shopify/polaris';
import type { IndexTableProps } from '@shopify/polaris';
import { useT, useLocale } from '~/lib/i18n/context';
import { formatIndicativeZoneCost, isCarrierCalculated, optionCostCell } from './option-cost';
import type { OptionCostType, RateType } from '~/lib/shipping/types';

interface Option {
  id: string;
  name: string;
  costType: OptionCostType;
  shopifyKind: string | null;
  confirmed: boolean;
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
  rateType: RateType;
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

/**
 * Le zone con le loro opzioni, in una sola tabella.
 *
 * Ogni zona apre il suo gruppo con una riga d'intestazione (nome e paesi) e
 * sotto elenca le opzioni e la tariffa generica, che vale quando l'ordine usa
 * un'opzione non importata, non ancora compilata o con un nome diverso (le
 * tariffe calcolate al checkout riportano il nome del servizio). Le righe del gruppo puntano all'intestazione con
 * `headers`: chi usa uno screen reader sente a quale zona appartiene ogni
 * opzione, non solo chi vede il rientro.
 */
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

  // Le etichette brevi, non quelle della modale: nella tabella le celle non
  // vanno a capo, e "Fasce di valore dell'ordine" bastava da sola a far
  // scorrere di lato la tabella a meta' pagina.
  const costTypeLabels: Record<OptionCostType, string> = t.shipping.table.costTypes;

  const headings: IndexTableProps['headings'] = [
    { title: t.shipping.table.option },
    { title: t.shipping.table.rateType },
    { title: t.shipping.table.indicativeCost },
    { title: t.shipping.table.actions },
  ];

  // IndexTable vuole la posizione di ogni riga nell'elenco completo, gruppi
  // compresi: il contatore avanza su intestazioni, opzioni e tariffe generiche.
  let position = 0;
  const rows = zones.map((zone) => {
    const headerId = `zona-${zone.id}`;

    const header = (
      // La riga ha un id suo: quello dell'intestazione (`th`) e' il bersaglio
      // di `headers` delle righe figlie, e due elementi con lo stesso id nel
      // DOM renderebbero ambiguo a chi e' riferito.
      <IndexTable.Row rowType="subheader" id={`${headerId}-riga`} key={headerId} position={position++}>
        <IndexTable.Cell as="th" id={headerId} colSpan={headings.length} scope="colgroup">
          <BlockStack gap="050">
            <Text as="span" fontWeight="semibold">
              {zone.zoneName}
            </Text>
            <Text as="span" tone="subdued">
              {formatCountries(zone)}
            </Text>
          </BlockStack>
        </IndexTable.Cell>
      </IndexTable.Row>
    );

    const optionRows = zone.options.map((option) => {
      const cell = optionCostCell(option, 'EUR', locale);
      return (
        <IndexTable.Row rowType="child" id={option.id} key={option.id} position={position++}>
          <IndexTable.Cell headers={headerId}>
            <BlockStack gap="050">
              <Text as="span">{option.name}</Text>
              {/* Tariffa calcolata al checkout: sull'ordine compare il nome del
                  servizio, che puo' non coincidere con quello importato. */}
              {isCarrierCalculated(option.shopifyKind) && (
                <Text as="span" tone="subdued" variant="bodySm">
                  {t.shipping.table.carrierNameHelp}
                </Text>
              )}
            </BlockStack>
          </IndexTable.Cell>
          <IndexTable.Cell headers={headerId}>{costTypeLabels[option.costType]}</IndexTable.Cell>
          <IndexTable.Cell headers={headerId}>
            {cell.toFill ? <Badge>{t.shipping.table.toFill}</Badge> : cell.text}
          </IndexTable.Cell>
          <IndexTable.Cell headers={headerId}>
            <Button
              size="slim"
              onClick={() => onEditOption(option, zone)}
              accessibilityLabel={t.shipping.table.editOptionLabel(zone.zoneName, option.name)}
            >
              {t.shipping.table.edit}
            </Button>
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    });

    const genericId = `zona-${zone.id}-generica`;
    const genericRow = (
      <IndexTable.Row rowType="child" tone="subdued" id={genericId} key={genericId} position={position++}>
        {/* Solo l'etichetta, senza riga di spiegazione: le celle della
            tabella non vanno a capo, e una frase lunga qui allargava la
            colonna fino a far scorrere di lato la tabella a meta' pagina. */}
        <IndexTable.Cell headers={headerId}>
          <Text as="span">{t.shipping.table.genericRate}</Text>
        </IndexTable.Cell>
        <IndexTable.Cell headers={headerId}>{t.shipping.rateTypes[zone.rateType]}</IndexTable.Cell>
        <IndexTable.Cell headers={headerId}>{formatIndicativeZoneCost(zone, t, locale)}</IndexTable.Cell>
        <IndexTable.Cell headers={headerId}>
          <Button
            size="slim"
            onClick={() => onEdit(zone)}
            accessibilityLabel={t.shipping.table.editGenericRateLabel(zone.zoneName)}
          >
            {t.shipping.table.edit}
          </Button>
        </IndexTable.Cell>
      </IndexTable.Row>
    );

    return (
      <Fragment key={zone.id}>
        {header}
        {optionRows}
        {genericRow}
      </Fragment>
    );
  });

  return (
    <IndexTable
      itemCount={position}
      selectable={false}
      headings={headings}
    >
      {rows}
    </IndexTable>
  );
}
