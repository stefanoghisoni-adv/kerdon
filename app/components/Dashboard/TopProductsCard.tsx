import {
  Badge,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  InlineStack,
  Link,
  Text,
  Tooltip,
} from '@shopify/polaris';
import type { Metric } from '~/lib/customers/top-products';
import type { TopProduct } from '~/lib/customers/top-products.server';
import { formatMoney } from '~/lib/billing/money';
import { useLocale, useT } from '~/lib/i18n/context';

export interface TopProductsCardProps {
  rows: TopProduct[];
  currency: string;
  metric: Metric;
  onMetric: (metric: Metric) => void;
  loading: boolean;
  /** Base dell'admin del negozio, per aprire la scheda del prodotto. */
  adminBase?: string;
}

const ORDER: Metric[] = ['cm', 'aop', 'acp', 'ltp'];

/**
 * I cinque prodotti che hanno reso di piu' nel mese.
 *
 * La stessa forma delle corse recenti — nome a sinistra, numero a destra,
 * righe divise da una linea — perche' risponde allo stesso tipo di domanda:
 * una sola, e in fretta. Cambia solo quale domanda, e la sceglie il merchant.
 *
 * Il valore mostrato e' sempre quello su cui si sta ordinando: mostrarne
 * quattro per riga avrebbe reso la colonna illeggibile, e non si sarebbe capito
 * perche' il primo e' primo.
 */
export function TopProductsCard({
  rows,
  currency,
  metric,
  onMetric,
  loading,
  adminBase,
}: TopProductsCardProps) {
  const t = useT();
  const locale = useLocale();

  const value = (row: TopProduct) => row[metric];

  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            {t.dashboard.topProducts.title}
          </Text>

          <InlineStack gap="100" wrap>
            <ButtonGroup variant="segmented">
              {ORDER.map((key) => (
                <Tooltip key={key} content={t.dashboard.topProducts.help[key]}>
                  <Button
                    size="slim"
                    pressed={metric === key}
                    onClick={() => onMetric(key)}
                    disabled={loading}
                  >
                    {t.dashboard.topProducts.metric[key]}
                  </Button>
                </Tooltip>
              ))}
            </ButtonGroup>
          </InlineStack>
        </BlockStack>

        {loading ? (
          <Box background="bg-surface-secondary" borderRadius="200" minHeight="140px" />
        ) : rows.length === 0 ? (
          <Text as="p" tone="subdued">
            {t.dashboard.topProducts.empty}
          </Text>
        ) : (
          <BlockStack gap="200">
            {rows.map((row, index) => (
              <BlockStack gap="200" key={row.variantId}>
                {index > 0 && <Divider />}
                <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
                  <BlockStack gap="050">
                    {adminBase && row.productId ? (
                      // _top e non una scheda nuova: l'admin di Shopify rifiuta
                      // di essere incorniciato, e un collegamento normale da qui
                      // dentro finirebbe in "Connessione negata".
                      <Link url={`${adminBase}/products/${row.productId}`} target="_top">
                        {row.title}
                      </Link>
                    ) : (
                      <Text as="span" fontWeight="medium">
                        {row.title}
                      </Text>
                    )}
                    <Text as="span" variant="bodySm" tone="subdued">
                      {row.variantTitle ?? t.dashboard.topProducts.singleVariant}
                    </Text>
                  </BlockStack>

                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <Text as="span" fontWeight="semibold" numeric>
                      {formatMoney(value(row), currency, locale)}
                    </Text>
                    <Badge>{t.dashboard.topProducts.orders(row.orders)}</Badge>
                  </InlineStack>
                </InlineStack>
              </BlockStack>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
