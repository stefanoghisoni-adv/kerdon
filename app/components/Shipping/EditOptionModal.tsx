import { useState, useCallback } from 'react';
import { Modal, BlockStack, ChoiceList, TextField, Text } from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import { BracketsEditor } from './BracketsEditor';
import {
  validateOptionBrackets,
  validateCostField,
  costFieldErrorWhileTyping,
  initialOptionBrackets,
  bracketEditorLabels,
  toRateBrackets,
  fromRateBrackets,
} from './option-cost';
import type { OptionCostType, OptionBracket } from '~/lib/shipping/types';

// Gli errori che hanno un testo dedicato. Una chiave sconosciuta ricade sul
// messaggio generico: meglio un testo vago che una chiave i18n a video.
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
    'shipping.errors.invalidFlatCost': t.shipping.errors.invalidFlatCost,
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

const isBracketType = (c: OptionCostType): c is 'weight_brackets' | 'value_brackets' =>
  c === 'weight_brackets' || c === 'value_brackets';

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

  // Il costo fisso e quello al kg partono dal valore salvato solo se l'opzione
  // e' gia' di quel tipo: il costo fisso letto come costo al kg (o viceversa)
  // sarebbe un numero giusto nel posto sbagliato.
  const [flatCost, setFlatCost] = useState(
    option.costType === 'flat' && option.rates.length > 0 ? option.rates[0].cost.toString() : ''
  );
  const [linearCost, setLinearCost] = useState(
    option.costType === 'linear' && option.rates.length > 0 ? option.rates[0].cost.toString() : ''
  );

  // Le fasce partono sempre da cio' che l'editor mostra (mai da una lista
  // vuota), cosi' passare a fasce e salvare subito salva la fascia visibile.
  const [brackets, setBrackets] = useState<OptionBracket[]>(() => initialOptionBrackets(option));
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleCostTypeChange = useCallback((selected: string[]) => {
    const newType = selected[0] as OptionCostType;
    setCostType(newType);
    setValidationError(null);
  }, []);

  const handleBracketsChange = useCallback((newBrackets: OptionBracket[]) => {
    setBrackets(newBrackets);
    setValidationError(validateOptionBrackets(costType, newBrackets));
  }, [costType]);

  // L'errore si ricalcola a ogni tasto: appena il valore torna valido sparisce
  // e Salva si riabilita, senza dover cambiare tipo di costo per sbloccarlo.
  const handleFlatCostChange = useCallback((value: string) => {
    setFlatCost(value);
    setValidationError(costFieldErrorWhileTyping('flat', value));
  }, []);

  const handleLinearCostChange = useCallback((value: string) => {
    setLinearCost(value);
    setValidationError(costFieldErrorWhileTyping('linear', value));
  }, []);

  const handleSave = () => {
    if (costType === 'flat' || costType === 'linear') {
      const valore = costType === 'flat' ? flatCost : linearCost;
      const error = validateCostField(costType, valore);
      if (error) {
        setValidationError(error);
        return;
      }
      onSave(costType === 'flat' ? { costType, flatCost } : { costType, linearCost });
      return;
    }
    const error = validateOptionBrackets(costType, brackets);
    if (error) {
      setValidationError(error);
      return;
    }
    onSave({ costType, brackets });
  };

  // Gli errori dei campi di costo compaiono sotto il campo; quelli delle
  // fasce, che riguardano l'insieme, sotto l'editor.
  const costFieldError =
    validationError === 'shipping.errors.invalidFlatCost' ||
    validationError === 'shipping.errors.invalidLinearCost'
      ? getValidationErrorMessage(validationError, t) ?? undefined
      : undefined;

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
          {/* Il perche' della modale vale per ogni tipo di costo; la parte
              sulle fasce importate solo quando l'opzione ha fasce. */}
          <BlockStack gap="100">
            <Text as="p">{t.shipping.optionModal.costTypeHelp}</Text>
            {isBracketType(costType) && (
              <Text as="p" tone="subdued">
                {t.shipping.optionModal.bracketsFromShopifyHelp}
              </Text>
            )}
          </BlockStack>

          <ChoiceList
            title={t.shipping.optionModal.costTypeLabel}
            choices={[
              { label: t.shipping.optionModal.flatLabel, value: 'flat' },
              { label: t.shipping.optionModal.linearLabel, value: 'linear' },
              { label: t.shipping.optionModal.weightBracketsLabel, value: 'weight_brackets' },
              { label: t.shipping.optionModal.valueBracketsLabel, value: 'value_brackets' },
            ]}
            selected={[costType]}
            onChange={handleCostTypeChange}
          />

          {costType === 'flat' && (
            <TextField
              label={t.shipping.optionModal.flatCostLabel}
              type="number"
              value={flatCost}
              onChange={handleFlatCostChange}
              placeholder={t.shipping.optionModal.flatCostPlaceholder}
              helpText={t.shipping.optionModal.flatCostHelp}
              autoComplete="off"
              min={0}
              step={0.01}
              error={costFieldError}
            />
          )}

          {costType === 'linear' && (
            <TextField
              label={t.shipping.optionModal.linearCostLabel}
              type="number"
              value={linearCost}
              onChange={handleLinearCostChange}
              placeholder={t.shipping.optionModal.linearCostPlaceholder}
              helpText={t.shipping.optionModal.linearCostHelp}
              autoComplete="off"
              min={0}
              step={0.01}
              error={costFieldError}
            />
          )}

          {/* La key rimonta l'editor quando si passa da peso a valore: le
              etichette e l'aiuto cambiano unita' insieme alle soglie. */}
          {isBracketType(costType) && (
            <BracketsEditor
              key={costType}
              labels={bracketEditorLabels(costType, t)}
              initialBrackets={toRateBrackets(brackets)}
              onChange={(newBrackets) => handleBracketsChange(fromRateBrackets(newBrackets))}
            />
          )}

          {validationError && !costFieldError && (
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
