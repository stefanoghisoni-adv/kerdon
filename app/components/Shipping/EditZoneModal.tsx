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
import { validateBrackets } from './brackets';
import type { RateBracket } from '~/lib/shipping/types';

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

interface EditZoneModalProps {
  zone: Zone;
  onClose: () => void;
  onSave: (data: {
    rateType: 'linear' | 'brackets';
    costPerKg?: string;
    brackets?: RateBracket[];
  }) => void;
}

export function EditZoneModal({ zone, onClose, onSave }: EditZoneModalProps) {
  const t = useT();

  const [rateType, setRateType] = useState<'linear' | 'brackets'>(zone.rateType);

  // Linear rate
  const initialLinearCost =
    zone.rateType === 'linear' && zone.rates.length > 0
      ? zone.rates[0].cost.toString()
      : '';
  const [linearCost, setLinearCost] = useState(initialLinearCost);

  // Brackets
  const initialBrackets: RateBracket[] =
    zone.rateType === 'brackets' && zone.rates.length > 0
      ? zone.rates
          .sort((a, b) => (a.weightFromKg ?? 0) - (b.weightFromKg ?? 0))
          .map((r) => ({
            weightFromKg: r.weightFromKg,
            weightToKg: r.weightToKg,
            cost: r.cost,
          }))
      : [];
  const [brackets, setBrackets] = useState<RateBracket[]>(initialBrackets);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleRateTypeChange = useCallback((selected: string[]) => {
    const newType = selected[0] as 'linear' | 'brackets';
    setRateType(newType);
    setValidationError(null);
  }, []);

  const handleBracketsChange = useCallback((newBrackets: RateBracket[]) => {
    setBrackets(newBrackets);
    const error = validateBrackets(newBrackets);
    setValidationError(error);
  }, []);

  const handleSave = () => {
    if (rateType === 'linear') {
      const cost = parseFloat(linearCost);
      if (isNaN(cost) || cost < 0) {
        setValidationError('shipping.errors.invalidLinearCost');
        return;
      }
      onSave({ rateType: 'linear', costPerKg: linearCost });
    } else {
      const error = validateBrackets(brackets);
      if (error) {
        setValidationError(error);
        return;
      }
      onSave({ rateType: 'brackets', brackets });
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t.shipping.modal.title(zone.zoneName)}
      primaryAction={{
        content: t.shipping.modal.save,
        onAction: handleSave,
        disabled: !!validationError,
      }}
      secondaryActions={[
        {
          content: t.shipping.modal.cancel,
          onAction: onClose,
        },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <ChoiceList
            title={t.shipping.modal.rateTypeLabel}
            choices={[
              {
                label: t.shipping.modal.linearLabel,
                value: 'linear',
                helpText: t.shipping.modal.rateTypeHelp,
              },
              {
                label: t.shipping.modal.bracketsLabel,
                value: 'brackets',
              },
            ]}
            selected={[rateType]}
            onChange={handleRateTypeChange}
          />

          {rateType === 'linear' ? (
            <TextField
              label={t.shipping.modal.linearCostLabel}
              type="number"
              value={linearCost}
              onChange={setLinearCost}
              placeholder={t.shipping.modal.linearCostPlaceholder}
              helpText={t.shipping.modal.linearCostHelp}
              autoComplete="off"
              min={0}
              step={0.01}
              error={
                validationError === 'shipping.errors.invalidLinearCost'
                  ? t.shipping.errors.invalidLinearCost
                  : undefined
              }
            />
          ) : (
            <BracketsEditor initialBrackets={brackets} onChange={handleBracketsChange} />
          )}

          {validationError && validationError !== 'shipping.errors.invalidLinearCost' && (
            <Text as="p" tone="critical">
              {(t.shipping.errors as any)[validationError.split('.').pop()!]}
            </Text>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
