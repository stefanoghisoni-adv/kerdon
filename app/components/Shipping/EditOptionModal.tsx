import { useState, useCallback } from 'react';
import {
  Modal,
  BlockStack,
  ChoiceList,
  TextField,
  Text,
} from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import { BracketsEditor } from './BracketsEditor';
import { validateOptionBrackets } from './option-cost';
import type { OptionCostType, OptionBracket } from '~/lib/shipping/types';

// Mappa tipizzata degli errori di validazione alle chiavi i18n
function getValidationErrorMessage(
  errorCode: string | null,
  t: ReturnType<typeof useT>
): string | null {
  if (!errorCode) return null;

  const errorMap: Record<string, string> = {
    'shipping.errors.atLeastOneBracket': t.shipping.errors.atLeastOneBracket,
    'shipping.errors.firstBracketMustStartAtZero': t.shipping.errors.firstBracketMustStartAtZero,
    'shipping.errors.bracketsHaveGaps': t.shipping.errors.bracketsHaveGaps,
    'shipping.errors.bracketsOverlap': t.shipping.errors.bracketsOverlap,
    'shipping.errors.onlyLastBracketCanBeUnlimited': t.shipping.errors.onlyLastBracketCanBeUnlimited,
    'shipping.errors.costMustBeNonNegative': t.shipping.errors.costMustBeNonNegative,
    'shipping.errors.weightFromGreaterThanWeightTo': t.shipping.errors.weightFromGreaterThanWeightTo,
    'shipping.errors.invalidLinearCost': t.shipping.errors.invalidLinearCost,
    'shipping.errors.invalidBrackets': t.shipping.errors.invalidBrackets,
  };

  return errorMap[errorCode] ?? t.shipping.optionModal.saveError;
}

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
  zoneName: string;
}

interface EditOptionModalProps {
  option: Option;
  zone: Zone;
  onClose: () => void;
  onSave: (data: {
    costType: OptionCostType;
    flatCost?: string;
    linearCost?: string;
    brackets?: OptionBracket[];
  }) => void;
  /** Il salvataggio e' partito e il server non ha ancora risposto. */
  isSaving?: boolean;
  /**
   * Il motivo per cui il server ha rifiutato il salvataggio, gia' tradotto.
   * La modale resta aperta con i valori scritti dal merchant e lo mostra:
   * chiuderla farebbe sembrare riuscito un salvataggio rifiutato.
   */
  serverError?: string | null;
}

export function EditOptionModal({
  option,
  zone,
  onClose,
  onSave,
  isSaving = false,
  serverError = null,
}: EditOptionModalProps) {
  const t = useT();

  const [costType, setCostType] = useState<OptionCostType>(option.costType);

  // Flat cost
  const initialFlatCost =
    option.costType === 'flat' && option.rates.length > 0
      ? option.rates[0].cost.toString()
      : '';
  const [flatCost, setFlatCost] = useState(initialFlatCost);

  // Linear cost
  const initialLinearCost =
    option.costType === 'linear' && option.rates.length > 0
      ? option.rates[0].cost.toString()
      : '';
  const [linearCost, setLinearCost] = useState(initialLinearCost);

  // Brackets (for both weight and value)
  const initialBrackets: OptionBracket[] =
    (option.costType === 'weight_brackets' || option.costType === 'value_brackets') && option.rates.length > 0
      ? option.rates
          .sort((a, b) => (a.from ?? 0) - (b.from ?? 0))
          .map((r) => ({
            from: r.from,
            to: r.to,
            cost: r.cost,
          }))
      : [];
  const [brackets, setBrackets] = useState<OptionBracket[]>(initialBrackets);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleCostTypeChange = useCallback((selected: string[]) => {
    const newType = selected[0] as OptionCostType;
    setCostType(newType);
    setValidationError(null);
  }, []);

  const handleBracketsChange = useCallback((newBrackets: OptionBracket[]) => {
    setBrackets(newBrackets);
    const error = validateOptionBrackets(costType, newBrackets);
    setValidationError(error);
  }, [costType]);

  const handleSave = () => {
    if (costType === 'flat') {
      const cost = parseFloat(flatCost);
      if (isNaN(cost) || cost < 0) {
        setValidationError('shipping.errors.invalidLinearCost');
        return;
      }
      onSave({ costType: 'flat', flatCost });
    } else if (costType === 'linear') {
      const cost = parseFloat(linearCost);
      if (isNaN(cost) || cost < 0) {
        setValidationError('shipping.errors.invalidLinearCost');
        return;
      }
      onSave({ costType: 'linear', linearCost });
    } else {
      const error = validateOptionBrackets(costType, brackets);
      if (error) {
        setValidationError(error);
        return;
      }
      onSave({ costType, brackets });
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t.shipping.optionModal.title(zone.zoneName, option.name)}
      primaryAction={{
        content: t.shipping.optionModal.save,
        onAction: handleSave,
        disabled: !!validationError,
        loading: isSaving,
      }}
      secondaryActions={[
        {
          content: t.shipping.optionModal.cancel,
          onAction: onClose,
        },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <ChoiceList
            title={t.shipping.optionModal.costTypeLabel}
            choices={[
              {
                label: t.shipping.optionModal.flatLabel,
                value: 'flat',
                helpText: costType === 'flat' ? t.shipping.optionModal.costTypeHelp : undefined,
              },
              {
                label: t.shipping.optionModal.linearLabel,
                value: 'linear',
              },
              {
                label: t.shipping.optionModal.weightBracketsLabel,
                value: 'weight_brackets',
              },
              {
                label: t.shipping.optionModal.valueBracketsLabel,
                value: 'value_brackets',
              },
            ]}
            selected={[costType]}
            onChange={handleCostTypeChange}
          />

          {costType === 'flat' && (
            <TextField
              label={t.shipping.optionModal.flatCostLabel}
              type="number"
              value={flatCost}
              onChange={setFlatCost}
              placeholder={t.shipping.optionModal.flatCostPlaceholder}
              helpText={t.shipping.optionModal.flatCostHelp}
              autoComplete="off"
              min={0}
              step={0.01}
              error={
                validationError === 'shipping.errors.invalidLinearCost'
                  ? t.shipping.errors.invalidLinearCost
                  : undefined
              }
            />
          )}

          {costType === 'linear' && (
            <TextField
              label={t.shipping.optionModal.linearCostLabel}
              type="number"
              value={linearCost}
              onChange={setLinearCost}
              placeholder={t.shipping.optionModal.linearCostPlaceholder}
              helpText={t.shipping.optionModal.linearCostHelp}
              autoComplete="off"
              min={0}
              step={0.01}
              error={
                validationError === 'shipping.errors.invalidLinearCost'
                  ? t.shipping.errors.invalidLinearCost
                  : undefined
              }
            />
          )}

          {costType === 'weight_brackets' && (
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                {t.shipping.optionModal.weightBracketsHelp}
              </Text>
              <BracketsEditor
                initialBrackets={brackets.map((b) => ({
                  weightFromKg: b.from,
                  weightToKg: b.to,
                  cost: b.cost,
                }))}
                onChange={(newBrackets) =>
                  handleBracketsChange(
                    newBrackets.map((b) => ({
                      from: b.weightFromKg,
                      to: b.weightToKg,
                      cost: b.cost,
                    }))
                  )
                }
              />
            </BlockStack>
          )}

          {costType === 'value_brackets' && (
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                {t.shipping.optionModal.valueBracketsHelp}
              </Text>
              <BracketsEditor
                initialBrackets={brackets.map((b) => ({
                  weightFromKg: b.from,
                  weightToKg: b.to,
                  cost: b.cost,
                }))}
                onChange={(newBrackets) =>
                  handleBracketsChange(
                    newBrackets.map((b) => ({
                      from: b.weightFromKg,
                      to: b.weightToKg,
                      cost: b.cost,
                    }))
                  )
                }
                // Per le fasce di valore, le etichette restano kg ma il significato e' EUR
                // Il BracketsEditor non ha bisogno di sapere l'unita': accetta numeri
              />
            </BlockStack>
          )}

          {validationError && validationError !== 'shipping.errors.invalidLinearCost' && (
            <Text as="p" tone="critical">
              {getValidationErrorMessage(validationError, t)}
            </Text>
          )}

          {/* Il rifiuto del server, solo se il controllo locale non ha gia'
              detto qualcosa: due messaggi sullo stesso problema confondono. */}
          {serverError && !validationError && (
            <Text as="p" tone="critical">
              {serverError}
            </Text>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
