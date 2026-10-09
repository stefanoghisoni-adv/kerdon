// app/components/shared/PolarisSelect.tsx
//
// Menu a tendina costruito con i componenti Polaris (Button + Popover + OptionList)
// al posto di <Select> nativo del browser.

import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { Button, Popover, OptionList, Box, Text, InlineError } from '@shopify/polaris';
import { SelectIcon } from '@shopify/polaris-icons';

export interface PolarisSelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface PolarisSelectProps {
  /** Etichetta del campo (può contenere elementi React, ad es. un tooltip). */
  label: ReactNode;
  /** Nasconde visivamente l'etichetta (ma la mantiene per screen reader). */
  labelHidden?: boolean;
  /** Opzioni del menu. */
  options: PolarisSelectOption[];
  /** Valore selezionato. */
  value: string;
  /** Callback alla selezione di una nuova opzione. */
  onChange?: (value: string) => void;
  /** Disabilita il controllo. */
  disabled?: boolean;
  /** Testo placeholder quando nessuna opzione è selezionata. */
  placeholder?: string;
  /** Testo di aiuto sotto il campo. */
  helpText?: string;
  /** Messaggio di errore (sostituisce helpText). */
  error?: string;
}

/**
 * Restituisce l'etichetta dell'opzione selezionata, oppure il placeholder.
 */
export function getSelectedLabel(
  options: PolarisSelectOption[],
  value: string,
  placeholder?: string
): string {
  const selected = options.find((opt) => opt.value === value);
  return selected ? selected.label : placeholder ?? '';
}

/**
 * Converte le opzioni in formato OptionList.
 */
export function mapOptionsForList(options: PolarisSelectOption[]) {
  return options.map((opt) => ({
    value: opt.value,
    label: opt.label,
    disabled: opt.disabled,
  }));
}

/**
 * PolarisSelect: menu a tendina costruito con Polaris, senza <select> nativo.
 *
 * Accessibilità:
 * - Apertura con Enter/Space/ArrowDown
 * - Chiusura con Escape
 * - Focus torna al trigger dopo la selezione
 * - Label collegata al trigger tramite id/aria
 */
export function PolarisSelect({
  label,
  labelHidden,
  options,
  value,
  onChange,
  disabled,
  placeholder,
  helpText,
  error,
}: PolarisSelectProps) {
  const [popoverActive, setPopoverActive] = useState(false);
  const triggerId = useRef(`polaris-select-${Math.random().toString(36).slice(2, 11)}`).current;
  const labelId = useRef(`polaris-select-label-${Math.random().toString(36).slice(2, 11)}`).current;

  const togglePopover = useCallback(() => {
    if (!disabled) {
      setPopoverActive((active) => !active);
    }
  }, [disabled]);

  const closePopover = useCallback(() => {
    setPopoverActive(false);
  }, []);

  const handleSelection = useCallback(
    (selected: string[]) => {
      if (selected.length > 0 && onChange) {
        onChange(selected[0]);
      }
      closePopover();
    },
    [onChange, closePopover]
  );

  // Chiusura con Escape
  useEffect(() => {
    if (!popoverActive) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePopover();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [popoverActive, closePopover]);

  const selectedLabel = getSelectedLabel(options, value, placeholder);
  const listOptions = mapOptionsForList(options);

  const activator = (
    <div>
      {!labelHidden && (
        <Box paddingBlockEnd="100">
          <label htmlFor={triggerId} id={labelId}>
            <Text as="span" variant="bodyMd" fontWeight="medium">
              {label}
            </Text>
          </label>
        </Box>
      )}
      {labelHidden && (
        <label htmlFor={triggerId} id={labelId} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>
          {label}
        </label>
      )}
      <Button
        id={triggerId}
        onClick={togglePopover}
        disclosure="down"
        icon={SelectIcon}
        fullWidth
        textAlign="start"
        disabled={disabled}
        accessibilityLabel={typeof label === 'string' ? label : undefined}
      >
        {selectedLabel}
      </Button>
    </div>
  );

  return (
    <Box>
      <Popover
        active={popoverActive}
        activator={activator}
        onClose={closePopover}
        autofocusTarget="first-node"
        preferredAlignment="left"
        fullWidth
      >
        <OptionList
          options={listOptions}
          selected={[value]}
          onChange={handleSelection}
        />
      </Popover>
      {error && (
        <Box paddingBlockStart="100">
          <InlineError message={error} fieldID={triggerId} />
        </Box>
      )}
      {!error && helpText && (
        <Box paddingBlockStart="100">
          <Text as="p" variant="bodyMd" tone="subdued">
            {helpText}
          </Text>
        </Box>
      )}
    </Box>
  );
}
