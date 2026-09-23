import { useState, useCallback } from 'react';
import {
  Box,
  Card,
  BlockStack,
  TextField,
  Button,
  InlineStack,
  InlineGrid,
  Text,
  Select,
  Banner,
} from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import { validatePackaging } from './packaging';
import type { PackagingCategory, FallbackRule } from '~/lib/shipping/types';

interface PackagingCardProps {
  initialCategories: PackagingCategory[];
  initialRules: FallbackRule[];
  initialDefaultWeight: number | null;
  initialReturnCost: number | null;
  configKey: string;
  onSave: (data: {
    categories: PackagingCategory[];
    rules: FallbackRule[];
    defaultWeightPerItemKg: string | null;
    returnCost: string | null;
  }) => void;
  isSaving: boolean;
}

function getValidationErrorMessage(
  errorCode: string | null,
  t: ReturnType<typeof useT>
): string | null {
  if (!errorCode) return null;

  const errorMap: Record<string, string> = {
    'shipping.packaging.errors.categoryNameEmpty': t.shipping.packaging.errors.categoryNameEmpty,
    'shipping.packaging.errors.categoryNameDuplicate': t.shipping.packaging.errors.categoryNameDuplicate,
    'shipping.packaging.errors.categoryCostNegative': t.shipping.packaging.errors.categoryCostNegative,
    'shipping.packaging.errors.ruleInvalidCategory': t.shipping.packaging.errors.ruleInvalidCategory,
    'shipping.packaging.errors.ruleWeightNegative': t.shipping.packaging.errors.ruleWeightNegative,
    'shipping.packaging.errors.multipleUnlimitedRules': t.shipping.packaging.errors.multipleUnlimitedRules,
    'shipping.packaging.errors.unlimitedRuleMustBeLast': t.shipping.packaging.errors.unlimitedRuleMustBeLast,
    'shipping.packaging.errors.invalidData': t.shipping.packaging.errors.invalidData,
  };

  return errorMap[errorCode] ?? t.shipping.packaging.saveError;
}

export function PackagingCard({
  initialCategories,
  initialRules,
  initialDefaultWeight,
  initialReturnCost,
  configKey,
  onSave,
  isSaving,
}: PackagingCardProps) {
  const t = useT();

  const [categories, setCategories] = useState<PackagingCategory[]>(
    initialCategories.length > 0 ? initialCategories : []
  );
  const [rules, setRules] = useState<FallbackRule[]>(
    initialRules.length > 0 ? initialRules : []
  );
  const [defaultWeight, setDefaultWeight] = useState(
    initialDefaultWeight !== null ? initialDefaultWeight.toString() : ''
  );
  const [returnCost, setReturnCost] = useState(
    initialReturnCost !== null ? initialReturnCost.toString() : ''
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deleteBlockedIndex, setDeleteBlockedIndex] = useState<number | null>(null);

  const handleAddCategory = useCallback(() => {
    setCategories([...categories, { name: '', cost: 0 }]);
  }, [categories]);

  const handleRemoveCategory = useCallback(
    (index: number) => {
      const categoryToRemove = categories[index].name;

      // Check if any rule references this category
      const referencingRules = rules.filter((rule) => rule.category === categoryToRemove);

      if (referencingRules.length > 0 && categoryToRemove !== '') {
        setDeleteBlockedIndex(index);
        return;
      }

      const newCategories = categories.filter((_, i) => i !== index);
      setCategories(newCategories);
      setDeleteBlockedIndex(null);

      // Remove rules that reference the deleted category (for empty names)
      const newRules = rules.filter((rule) => rule.category !== categoryToRemove);
      setRules(newRules);

      // Re-validate after removing
      const error = validatePackaging({ categories: newCategories, rules: newRules });
      setValidationError(error);
    },
    [categories, rules]
  );

  const handleCategoryNameChange = useCallback(
    (index: number, value: string) => {
      const oldName = categories[index].name;
      const newCategories = [...categories];
      newCategories[index] = { ...newCategories[index], name: value };
      setCategories(newCategories);
      setDeleteBlockedIndex(null);

      // Update rules that reference the old name
      if (oldName !== value) {
        const newRules = rules.map((rule) =>
          rule.category === oldName ? { ...rule, category: value } : rule
        );
        setRules(newRules);
        // Re-validate with updated rules
        const error = validatePackaging({ categories: newCategories, rules: newRules });
        setValidationError(error);
      } else {
        // Re-validate
        const error = validatePackaging({ categories: newCategories, rules });
        setValidationError(error);
      }
    },
    [categories, rules]
  );

  const handleCategoryCostChange = useCallback(
    (index: number, value: string) => {
      const newCategories = [...categories];
      const cost = parseFloat(value);
      newCategories[index] = { ...newCategories[index], cost: isNaN(cost) ? 0 : cost };
      setCategories(newCategories);
      // Re-validate
      const error = validatePackaging({ categories: newCategories, rules });
      setValidationError(error);
    },
    [categories, rules]
  );

  const hasNonEmptyCategory = categories.some((cat) => cat.name.trim() !== '');

  const handleAddRule = useCallback(() => {
    const firstNonEmptyCategory = categories.find((cat) => cat.name.trim() !== '');
    setRules([...rules, { weightMaxKg: 0, category: firstNonEmptyCategory?.name ?? '' }]);
  }, [rules, categories]);

  const handleRemoveRule = useCallback(
    (index: number) => {
      const newRules = rules.filter((_, i) => i !== index);
      setRules(newRules);
      setDeleteBlockedIndex(null);
      // Re-validate
      const error = validatePackaging({ categories, rules: newRules });
      setValidationError(error);
    },
    [rules, categories]
  );

  const handleRuleWeightChange = useCallback(
    (index: number, value: string) => {
      const newRules = [...rules];
      if (value === '') {
        // "Tutto il resto"
        newRules[index] = { ...newRules[index], weightMaxKg: null };
      } else {
        const weight = parseFloat(value);
        newRules[index] = { ...newRules[index], weightMaxKg: isNaN(weight) ? 0 : weight };
      }
      setRules(newRules);
      // Re-validate
      const error = validatePackaging({ categories, rules: newRules });
      setValidationError(error);
    },
    [rules, categories]
  );

  const handleRuleCategoryChange = useCallback(
    (index: number, value: string) => {
      const newRules = [...rules];
      newRules[index] = { ...newRules[index], category: value };
      setRules(newRules);
      // Re-validate
      const error = validatePackaging({ categories, rules: newRules });
      setValidationError(error);
    },
    [rules, categories]
  );

  const handleSave = () => {
    const error = validatePackaging({ categories, rules });
    if (error) {
      setValidationError(error);
      return;
    }

    onSave({
      categories,
      rules,
      defaultWeightPerItemKg: defaultWeight !== '' ? defaultWeight : null,
      returnCost: returnCost !== '' ? returnCost : null,
    });
  };

  const categoryOptions = categories
    .filter((cat) => cat.name.trim() !== '')
    .map((cat) => ({
      label: cat.name,
      value: cat.name,
    }));

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          {t.shipping.packaging.title}
        </Text>

        {/* Categories */}
        <BlockStack gap="300">
          <Text as="p" variant="bodyMd" fontWeight="semibold">
            {t.shipping.packaging.categoriesLabel}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {t.shipping.packaging.categoriesHelp}
          </Text>

          {categories.map((category, index) => (
            <BlockStack key={index} gap="200">
              <InlineGrid columns={['twoThirds', 'oneThird']} gap="200">
                <TextField
                  label=""
                  value={category.name}
                  onChange={(value) => handleCategoryNameChange(index, value)}
                  placeholder={t.shipping.packaging.categoryNamePlaceholder}
                  autoComplete="off"
                  labelHidden
                />
                <InlineStack gap="200" blockAlign="start">
                  <TextField
                    label=""
                    type="number"
                    value={category.cost.toString()}
                    onChange={(value) => handleCategoryCostChange(index, value)}
                    placeholder={t.shipping.packaging.categoryCostPlaceholder}
                    autoComplete="off"
                    min={0}
                    step={0.01}
                    labelHidden
                  />
                  <Button onClick={() => handleRemoveCategory(index)}>
                    {t.shipping.packaging.removeCategory}
                  </Button>
                </InlineStack>
              </InlineGrid>
              {deleteBlockedIndex === index && (
                <Banner tone="warning" onDismiss={() => setDeleteBlockedIndex(null)}>
                  {t.shipping.packaging.errors.categoryStillReferenced}
                </Banner>
              )}
            </BlockStack>
          ))}

          {/* Il Box tiene il pulsante alla sua larghezza: dentro un BlockStack
              un figlio diretto si allungherebbe su tutta la card. */}
          <Box>
            <Button onClick={handleAddCategory}>
              {t.shipping.packaging.addCategory}
            </Button>
          </Box>
        </BlockStack>

        {/* Rules */}
        {categories.length > 0 && (
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              {t.shipping.packaging.rulesLabel}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {t.shipping.packaging.rulesHelp}
            </Text>

            {rules.map((rule, index) => (
              <InlineStack key={index} gap="200" blockAlign="start">
                <TextField
                  label=""
                  type="number"
                  value={rule.weightMaxKg !== null ? rule.weightMaxKg.toString() : ''}
                  onChange={(value) => handleRuleWeightChange(index, value)}
                  placeholder={t.shipping.packaging.ruleUnlimited}
                  autoComplete="off"
                  min={0}
                  step={0.001}
                  labelHidden
                />
                <Select
                  label=""
                  options={categoryOptions}
                  value={rule.category}
                  onChange={(value) => handleRuleCategoryChange(index, value)}
                  labelHidden
                  disabled={categoryOptions.length === 0}
                />
                <Button onClick={() => handleRemoveRule(index)}>
                  {t.shipping.packaging.removeRule}
                </Button>
              </InlineStack>
            ))}

            <Box>
              <Button onClick={handleAddRule} disabled={!hasNonEmptyCategory}>
                {t.shipping.packaging.addRule}
              </Button>
            </Box>
          </BlockStack>
        )}

        {/* Default weight */}
        <TextField
          label={t.shipping.packaging.defaultWeightLabel}
          type="number"
          value={defaultWeight}
          onChange={setDefaultWeight}
          placeholder={t.shipping.packaging.defaultWeightPlaceholder}
          helpText={t.shipping.packaging.defaultWeightHelp}
          autoComplete="off"
          min={0}
          step={0.001}
        />

        {/* Return cost */}
        <TextField
          label={t.shipping.packaging.returnCostLabel}
          type="number"
          value={returnCost}
          onChange={setReturnCost}
          placeholder={t.shipping.packaging.returnCostPlaceholder}
          helpText={t.shipping.packaging.returnCostHelp}
          autoComplete="off"
          min={0}
          step={0.01}
        />

        {/* Validation error */}
        {validationError && (
          <Text as="p" tone="critical">
            {getValidationErrorMessage(validationError, t)}
          </Text>
        )}

        {/* Save button */}
        <Box>
          <Button variant="primary" onClick={handleSave} loading={isSaving} disabled={!!validationError}>
            {t.shipping.packaging.save}
          </Button>
        </Box>
      </BlockStack>
    </Card>
  );
}
