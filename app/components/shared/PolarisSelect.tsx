// app/components/shared/PolarisSelect.tsx
//
// Menu a tendina costruito con i componenti Polaris (Button + Popover + OptionList)
// al posto di <Select> nativo del browser.

import { useState, useCallback, useRef, useId, type ReactNode } from 'react';
import { Button, Popover, OptionList, Labelled } from '@shopify/polaris';

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
 * Restituisce l'etichetta dell'opzione selezionata, il placeholder, o la prima opzione.
 */
export function getSelectedLabel(
  options: PolarisSelectOption[],
  value: string,
  placeholder?: string
): string {
  const selected = options.find((opt) => opt.value === value);
  if (selected) return selected.label;
  if (placeholder) return placeholder;
  // Fallback alla prima opzione se value non corrisponde e nessun placeholder
  return options.length > 0 ? options[0].label : '';
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
 * - Apertura con Enter/Space o click
 * - Chiusura con Escape (fermato al popover per non chiudere Modal genitore)
 * - Focus torna al trigger dopo la selezione
 * - Label collegata al trigger tramite Labelled
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
  const triggerId = useId();
  const triggerRef = useRef<HTMLDivElement>(null);

  const togglePopover = useCallback(() => {
    if (!disabled) {
      setPopoverActive((active) => !active);
    }
  }, [disabled]);

  const closePopover = useCallback(() => {
    setPopoverActive(false);
    // Focus torna al trigger (il Button dentro il div wrapper)
    if (triggerRef.current) {
      const button = triggerRef.current.querySelector('button');
      if (button) {
        button.focus();
      }
    }
  }, []);

  const handleSelection = useCallback(
    (selected: string[]) => {
      // Skip se si riseleziona lo stesso valore
      if (selected.length > 0 && selected[0] !== value && onChange) {
        onChange(selected[0]);
      }
      closePopover();
    },
    [onChange, closePopover, value]
  );

  // Intercetta Escape nel popover per non chiudere la Modal genitore
  const handlePopoverKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePopover();
    }
  }, [closePopover]);

  const handlePopoverKeyUp = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
    }
  }, []);

  const selectedLabel = getSelectedLabel(options, value, placeholder);
  const listOptions = mapOptionsForList(options);

  const activator = (
    <div ref={triggerRef}>
      <Button
        id={triggerId}
        onClick={togglePopover}
        disclosure="down"
        fullWidth
        textAlign="start"
        disabled={disabled}
      >
        {selectedLabel}
      </Button>
    </div>
  );

  return (
    <Labelled
      id={triggerId}
      label={label}
      labelHidden={labelHidden}
      helpText={helpText}
      error={error}
    >
      <Popover
        active={popoverActive}
        activator={activator}
        onClose={closePopover}
        autofocusTarget="first-node"
        preferredAlignment="left"
        fullWidth
      >
        <div onKeyDown={handlePopoverKeyDown} onKeyUp={handlePopoverKeyUp}>
          <OptionList
            options={listOptions}
            selected={[value]}
            onChange={handleSelection}
          />
        </div>
      </Popover>
    </Labelled>
  );
}
