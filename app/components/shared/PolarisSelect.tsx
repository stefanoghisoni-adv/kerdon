// app/components/shared/PolarisSelect.tsx
//
// Menu a tendina costruito con i componenti Polaris (Button + Popover + OptionList)
// al posto di <Select> nativo del browser.

import { useState, useCallback, useRef, useId, useEffect, type ReactNode } from 'react';
import { Button, Popover, OptionList, Labelled, Text } from '@shopify/polaris';

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
 * Decide se l'evento deve essere bloccato per non chiudere la Modal genitore.
 * Restituisce true se è un Escape da bloccare.
 */
export function shouldBlockEscapeEvent(event: KeyboardEvent | React.KeyboardEvent): boolean {
  return event.key === 'Escape';
}

/**
 * Gestisce keydown/keyup Escape su window per bloccare la chiusura della Modal.
 * Logica estratta per test senza React.
 */
export function setupEscapeHandling(
  window: Window | EventTarget,
  onEscape: () => void
): () => void {
  let keyupHandlerRef: ((e: Event) => void) | null = null;
  let cleanupTimeoutId: ReturnType<typeof setTimeout> | null = null;

  const cleanupKeyupHandler = () => {
    if (keyupHandlerRef) {
      window.removeEventListener('keyup', keyupHandlerRef, true);
      keyupHandlerRef = null;
    }
    if (cleanupTimeoutId !== null) {
      clearTimeout(cleanupTimeoutId);
      cleanupTimeoutId = null;
    }
  };

  const handleKeyDown = (event: Event) => {
    const kbEvent = event as KeyboardEvent;
    if (shouldBlockEscapeEvent(kbEvent)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      // Cleanup any previous one-shot handler
      cleanupKeyupHandler();

      // Aggiungi one-shot listener per keyup che sopravvive alla chiusura del popover
      keyupHandlerRef = (e: Event) => {
        if (shouldBlockEscapeEvent(e as KeyboardEvent)) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
        }
        cleanupKeyupHandler();
      };

      window.addEventListener('keyup', keyupHandlerRef, { capture: true, once: true });

      // Fallback: rimuovi dopo 500ms se keyup non arriva (es. focus perso)
      cleanupTimeoutId = setTimeout(cleanupKeyupHandler, 500);

      onEscape();
    }
  };

  window.addEventListener('keydown', handleKeyDown, true);

  // Cleanup: rimuovi listener keydown e qualsiasi keyup pending
  return () => {
    window.removeEventListener('keydown', handleKeyDown, true);
    cleanupKeyupHandler();
  };
}

/**
 * PolarisSelect: menu a tendina costruito con Polaris, senza <select> nativo.
 *
 * Accessibilità:
 * - Apertura con Enter/Space o click
 * - Chiusura con Escape (bloccato via native listener capture-phase per non chiudere Modal)
 * - Focus torna al trigger dopo la selezione o Escape
 * - Label e valore collegati al trigger tramite Labelled + ariaDescribedBy
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
  const valueId = useId();
  const triggerRef = useRef<HTMLDivElement>(null);

  const togglePopover = useCallback(() => {
    if (!disabled) {
      setPopoverActive((active) => !active);
    }
  }, [disabled]);

  const refocusTrigger = useCallback(() => {
    if (triggerRef.current) {
      const button = triggerRef.current.querySelector('button');
      if (button) {
        button.focus();
      }
    }
  }, []);

  const closePopover = useCallback(() => {
    setPopoverActive(false);
  }, []);

  const closePopoverAndRefocus = useCallback(() => {
    closePopover();
    refocusTrigger();
  }, [closePopover, refocusTrigger]);

  const handleSelection = useCallback(
    (selected: string[]) => {
      // Skip se si riseleziona lo stesso valore
      if (selected.length > 0 && selected[0] !== value && onChange) {
        onChange(selected[0]);
      }
      closePopoverAndRefocus();
    },
    [onChange, closePopoverAndRefocus, value]
  );

  // Setup Escape handling: one-shot keyup listener sopravvive alla chiusura del popover
  useEffect(() => {
    if (!popoverActive) return;
    return setupEscapeHandling(window, closePopoverAndRefocus);
  }, [popoverActive, closePopoverAndRefocus]);

  const selectedLabel = getSelectedLabel(options, value, placeholder);
  const listOptions = mapOptionsForList(options);

  // ariaDescribedBy: collega valore + helpText/error (ids da Labelled)
  const describedByIds = [valueId];
  if (error) {
    describedByIds.push(`${triggerId}Error`);
  } else if (helpText) {
    describedByIds.push(`${triggerId}HelpText`);
  }
  const ariaDescribedBy = describedByIds.join(' ');

  const activator = (
    <div ref={triggerRef}>
      <Button
        id={triggerId}
        onClick={togglePopover}
        disclosure="down"
        fullWidth
        textAlign="start"
        disabled={disabled}
        ariaDescribedBy={ariaDescribedBy}
      >
        {selectedLabel}
      </Button>
      {/* Valore visualmente nascosto ma annunciato via ariaDescribedBy */}
      <Text as="span" id={valueId} visuallyHidden>
        {selectedLabel}
      </Text>
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
        <OptionList
          options={listOptions}
          selected={[value]}
          onChange={handleSelection}
        />
      </Popover>
    </Labelled>
  );
}
