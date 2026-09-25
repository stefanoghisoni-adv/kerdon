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
import { costFieldErrorWhileTyping, validateCostField } from './option-cost';
import type { RateBracket, RateType } from '~/lib/shipping/types';

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
    'shipping.errors.invalidPerPackageCost': t.shipping.errors.invalidPerPackageCost,
    'shipping.errors.invalidBrackets': t.shipping.errors.invalidBrackets,
  };

  return errorMap[errorCode] ?? t.shipping.modal.saveError;
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
}

interface EditZoneModalProps {
  zone: Zone;
  onClose: () => void;
  onSave: (data: {
    rateType: RateType;
    costPerKg?: string;
    costPerPackage?: string;
    brackets?: RateBracket[];
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

export function EditZoneModal({ zone, onClose, onSave, isSaving = false, serverError = null }: EditZoneModalProps) {
  const t = useT();

  const [rateType, setRateType] = useState<RateType>(zone.rateType);

  // Linear rate
  const initialLinearCost =
    zone.rateType === 'linear' && zone.rates.length > 0
      ? zone.rates[0].cost.toString()
      : '';
  const [linearCost, setLinearCost] = useState(initialLinearCost);

  // Il costo per pacco parte dal valore salvato solo se la zona e' gia' per
  // pacco: un costo al kg riletto come costo per pacco sarebbe un numero
  // giusto nel posto sbagliato.
  const [perPackageCost, setPerPackageCost] = useState(
    zone.rateType === 'per_package' && zone.rates.length > 0 ? zone.rates[0].cost.toString() : '',
  );

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
    const newType = selected[0] as RateType;
    setRateType(newType);
    setValidationError(null);
  }, []);

  const handleBracketsChange = useCallback((newBrackets: RateBracket[]) => {
    setBrackets(newBrackets);
    const error = validateBrackets(newBrackets);
    setValidationError(error);
  }, []);

  // Come nella modale delle opzioni: l'errore si ricalcola a ogni tasto e
  // sparisce appena il valore torna valido.
  const handlePerPackageCostChange = useCallback((value: string) => {
    setPerPackageCost(value);
    setValidationError(costFieldErrorWhileTyping('per_package', value));
  }, []);

  const handleSave = () => {
    if (rateType === 'per_package') {
      const error = validateCostField('per_package', perPackageCost);
      if (error) {
        setValidationError(error);
        return;
      }
      onSave({ rateType: 'per_package', costPerPackage: perPackageCost });
      return;
    }
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
        loading: isSaving,
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
              {
                label: t.shipping.modal.perPackageLabel,
                value: 'per_package',
              },
            ]}
            selected={[rateType]}
            onChange={handleRateTypeChange}
          />

          {rateType === 'per_package' ? (
            <TextField
              label={t.shipping.modal.perPackageCostLabel}
              type="number"
              value={perPackageCost}
              onChange={handlePerPackageCostChange}
              placeholder={t.shipping.modal.perPackageCostPlaceholder}
              helpText={t.shipping.modal.perPackageCostHelp}
              autoComplete="off"
              min={0}
              step={0.01}
              error={
                validationError === 'shipping.errors.invalidPerPackageCost'
                  ? t.shipping.errors.invalidPerPackageCost
                  : undefined
              }
            />
          ) : rateType === 'linear' ? (
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

          {validationError &&
            validationError !== 'shipping.errors.invalidLinearCost' &&
            validationError !== 'shipping.errors.invalidPerPackageCost' && (
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
