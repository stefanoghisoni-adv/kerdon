import { useState } from 'react';
import {
  BlockStack,
  InlineStack,
  Box,
  Button,
  TextField,
  Checkbox,
  Text,
} from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import type { RateBracket } from '~/lib/shipping/types';

interface BracketsEditorProps {
  initialBrackets?: RateBracket[];
  onChange: (brackets: RateBracket[]) => void;
}

export function BracketsEditor({ initialBrackets = [], onChange }: BracketsEditorProps) {
  const t = useT();
  const [brackets, setBrackets] = useState<RateBracket[]>(
    initialBrackets.length > 0
      ? initialBrackets
      : [{ weightFromKg: 0, weightToKg: null, cost: 0 }]
  );

  const handleBracketChange = (
    index: number,
    field: 'weightFromKg' | 'weightToKg' | 'cost',
    value: string
  ) => {
    const newBrackets = [...brackets];
    const numValue = parseFloat(value) || 0;

    newBrackets[index] = {
      ...newBrackets[index],
      [field]: value === '' && field !== 'cost' ? null : numValue,
    };

    setBrackets(newBrackets);
    onChange(newBrackets);
  };

  const handleUnlimitedToggle = (index: number, checked: boolean) => {
    const newBrackets = [...brackets];
    newBrackets[index] = {
      ...newBrackets[index],
      weightToKg: checked ? null : newBrackets[index].weightFromKg ?? 0,
    };
    setBrackets(newBrackets);
    onChange(newBrackets);
  };

  const handleAddBracket = () => {
    const lastBracket = brackets[brackets.length - 1];
    const newFrom = lastBracket.weightToKg ?? (lastBracket.weightFromKg ?? 0) + 1;

    const newBrackets = [...brackets, { weightFromKg: newFrom, weightToKg: null, cost: 0 }];
    setBrackets(newBrackets);
    onChange(newBrackets);
  };

  const handleRemoveBracket = (index: number) => {
    if (brackets.length === 1) return; // Mantieni almeno una fascia

    const newBrackets = brackets.filter((_, i) => i !== index);
    setBrackets(newBrackets);
    onChange(newBrackets);
  };

  return (
    <BlockStack gap="400">
      <Text as="p" tone="subdued">
        {t.shipping.modal.bracketsHelp}
      </Text>

      {brackets.map((bracket, index) => (
        <BlockStack key={index} gap="200">
          <InlineStack gap="200" align="start" blockAlign="start">
            <Box width="100%">
              <TextField
                label={t.shipping.modal.bracketWeightFrom}
                type="number"
                value={bracket.weightFromKg?.toString() ?? '0'}
                onChange={(value) => handleBracketChange(index, 'weightFromKg', value)}
                autoComplete="off"
                min={0}
                step={0.1}
              />
            </Box>

            <Box width="100%">
              <TextField
                label={t.shipping.modal.bracketWeightTo}
                type="number"
                value={bracket.weightToKg?.toString() ?? ''}
                onChange={(value) => handleBracketChange(index, 'weightToKg', value)}
                disabled={bracket.weightToKg === null}
                autoComplete="off"
                min={0}
                step={0.1}
              />
            </Box>

            <Box width="100%">
              <TextField
                label={t.shipping.modal.bracketCost}
                type="number"
                value={bracket.cost.toString()}
                onChange={(value) => handleBracketChange(index, 'cost', value)}
                autoComplete="off"
                min={0}
                step={0.01}
              />
            </Box>

            {brackets.length > 1 && (
              <Box paddingBlockStart="600">
                <Button onClick={() => handleRemoveBracket(index)} tone="critical">
                  {t.shipping.modal.removeBracket}
                </Button>
              </Box>
            )}
          </InlineStack>

          <Checkbox
            label={t.shipping.modal.bracketUnlimited}
            checked={bracket.weightToKg === null}
            onChange={(checked) => handleUnlimitedToggle(index, checked)}
          />
        </BlockStack>
      ))}

      <Button onClick={handleAddBracket}>{t.shipping.modal.addBracket}</Button>
    </BlockStack>
  );
}
