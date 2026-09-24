import { Badge, BlockStack, Box, Button, Card, IndexTable, InlineStack, Text } from '@shopify/polaris';
import type { IndexTableProps } from '@shopify/polaris';
import { useLocale, useT } from '~/lib/i18n/context';
import { formatMoney } from '~/lib/billing/money';
import type { PackagingCategory } from '~/lib/shipping/types';

interface PackagingCategoriesCardProps {
  categories: PackagingCategory[];
  onAdd: () => void;
  onEdit: (category: PackagingCategory) => void;
  onDelete: (category: PackagingCategory) => void;
}

/**
 * Le categorie di imballo salvate, in sola lettura: ogni riga si cambia dalla
 * sua modale. Cosi' una categoria salvata non sembra mai un campo appena
 * aggiunto e non ancora salvato.
 */
export function PackagingCategoriesCard({ categories, onAdd, onEdit, onDelete }: PackagingCategoriesCardProps) {
  const t = useT();
  const locale = useLocale();
  const c = t.shipping.packaging.categories;

  const headings: IndexTableProps['headings'] = [
    { title: c.name },
    { title: c.cost },
    { title: c.origin },
    { title: c.actions },
  ];

  return (
    <Card padding="0">
      <BlockStack gap="0">
        <Box padding="400">
          <InlineStack align="space-between" blockAlign="start" gap="400" wrap={false}>
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                {c.title}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {c.help}
              </Text>
            </BlockStack>
            <Box>
              <Button onClick={onAdd}>{c.add}</Button>
            </Box>
          </InlineStack>
        </Box>
        {categories.length === 0 ? (
          <Box paddingInline="400" paddingBlockEnd="400">
            <Text as="p" tone="subdued">
              {c.empty}
            </Text>
          </Box>
        ) : (
          <IndexTable
            itemCount={categories.length}
            selectable={false}
            headings={headings}
            resourceName={{ singular: c.name, plural: c.title }}
          >
            {categories.map((category, index) => (
              <IndexTable.Row id={`categoria-${index}`} key={category.name} position={index}>
                <IndexTable.Cell>
                  <Text as="span" fontWeight="semibold">
                    {category.name}
                  </Text>
                </IndexTable.Cell>
                <IndexTable.Cell>{formatMoney(category.cost, 'EUR', locale)}</IndexTable.Cell>
                <IndexTable.Cell>
                  {category.origin === 'shopify' ? (
                    <Badge tone="info">{c.originShopify}</Badge>
                  ) : (
                    <Badge>{c.originManual}</Badge>
                  )}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <InlineStack gap="200" wrap={false}>
                    <Button size="slim" onClick={() => onEdit(category)} accessibilityLabel={c.editLabel(category.name)}>
                      {c.edit}
                    </Button>
                    <Button
                      size="slim"
                      tone="critical"
                      variant="plain"
                      onClick={() => onDelete(category)}
                      accessibilityLabel={c.deleteLabel(category.name)}
                    >
                      {c.delete}
                    </Button>
                  </InlineStack>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
      </BlockStack>
    </Card>
  );
}
