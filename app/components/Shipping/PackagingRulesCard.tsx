import { BlockStack, Box, Button, Card, IndexTable, InlineStack, Text } from '@shopify/polaris';
import type { IndexTableProps } from '@shopify/polaris';
import { useLocale, useT } from '~/lib/i18n/context';
import type { Dictionary } from '~/lib/i18n/context';
import type { Locale } from '~/lib/i18n/locales';
import type { FallbackRule } from '~/lib/shipping/types';

interface PackagingRulesCardProps {
  rules: FallbackRule[];
  /** Senza categorie una regola non ha a cosa puntare: il pulsante si spegne. */
  hasCategories: boolean;
  onAdd: () => void;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
}

/** "Fino a 2 kg" o "Tutto il resto", come lo legge il merchant. */
export function describeRuleWeight(rule: FallbackRule, t: Dictionary, locale: Locale): string {
  if (rule.weightMaxKg === null) return t.shipping.packaging.rules.unlimitedLabel;
  const kg = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(rule.weightMaxKg);
  return t.shipping.packaging.rules.upTo(kg);
}

/** Le regole per peso, in sola lettura e nell'ordine in cui si applicano. */
export function PackagingRulesCard({ rules, hasCategories, onAdd, onEdit, onDelete }: PackagingRulesCardProps) {
  const t = useT();
  const locale = useLocale();
  const r = t.shipping.packaging.rules;

  const headings: IndexTableProps['headings'] = [{ title: r.weight }, { title: r.category }, { title: r.actions }];

  return (
    <Card padding="0">
      <BlockStack gap="0">
        <Box padding="400">
          <InlineStack align="space-between" blockAlign="start" gap="400" wrap={false}>
            <BlockStack gap="100">
              <Text as="h2" variant="headingMd">
                {r.title}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {hasCategories ? r.help : r.needsCategory}
              </Text>
            </BlockStack>
            <Box>
              <Button onClick={onAdd} disabled={!hasCategories}>
                {r.add}
              </Button>
            </Box>
          </InlineStack>
        </Box>
        {rules.length === 0 ? (
          <Box paddingInline="400" paddingBlockEnd="400">
            <Text as="p" tone="subdued">
              {r.empty}
            </Text>
          </Box>
        ) : (
          <IndexTable itemCount={rules.length} selectable={false} headings={headings}>
            {rules.map((rule, index) => {
              const weight = describeRuleWeight(rule, t, locale);
              return (
                <IndexTable.Row id={`regola-${index}`} key={`${index}-${rule.weightMaxKg}-${rule.category}`} position={index}>
                  <IndexTable.Cell>{weight}</IndexTable.Cell>
                  <IndexTable.Cell>{rule.category}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="200" wrap={false}>
                      <Button size="slim" onClick={() => onEdit(index)} accessibilityLabel={r.editLabel(weight, rule.category)}>
                        {r.edit}
                      </Button>
                      <Button
                        size="slim"
                        tone="critical"
                        variant="plain"
                        onClick={() => onDelete(index)}
                        accessibilityLabel={r.deleteLabel(weight, rule.category)}
                      >
                        {r.delete}
                      </Button>
                    </InlineStack>
                  </IndexTable.Cell>
                </IndexTable.Row>
              );
            })}
          </IndexTable>
        )}
      </BlockStack>
    </Card>
  );
}
