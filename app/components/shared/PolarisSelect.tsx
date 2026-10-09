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
 * Stato della guardia sull'Escape. Vive in ref nel componente, non in state React,
 * così i listener registrati una sola volta leggono sempre il valore aggiornato.
 * - open: il menu è aperto (rispecchia popoverActive).
 * - swallowEscapeKeyup: abbiamo chiuso il menu su un keydown Escape e il keyup
 *   dello stesso tasto non deve arrivare alla Modal (Polaris Dialog chiude su keyup).
 */
export interface EscapeGuardState {
  open: boolean;
  swallowEscapeKeyup: boolean;
}

export type EscapeGuardEvent =
  | { type: 'keydown' | 'keyup'; key: string }
  | { type: 'blur' };

export interface EscapeGuardResult {
  /** Fermare l'evento (preventDefault + stopPropagation) prima che arrivi alla Modal. */
  block: boolean;
  /** Chiudere il menu e riportare il focus sul pulsante. */
  close: boolean;
  nextState: EscapeGuardState;
}

/**
 * Logica pura della guardia sull'Escape: dato lo stato e l'evento, decide se
 * bloccare, se chiudere il menu e quale sarà lo stato successivo.
 */
export function reduceEscapeGuard(
  state: EscapeGuardState,
  event: EscapeGuardEvent
): EscapeGuardResult {
  // Il keyup potrebbe non arrivare mai (finestra che perde il focus): azzera il flag.
  if (event.type === 'blur') {
    return { block: false, close: false, nextState: { ...state, swallowEscapeKeyup: false } };
  }

  // Gli altri tasti non toccano lo stato: un modificatore rilasciato prima
  // dell'Escape non deve consumare il flag.
  if (event.key !== 'Escape') {
    return { block: false, close: false, nextState: state };
  }

  if (event.type === 'keydown') {
    if (state.open) {
      return { block: true, close: true, nextState: { open: false, swallowEscapeKeyup: true } };
    }
    // Autorepeat dello stesso tasto tenuto premuto dopo la chiusura: resta nostro.
    if (state.swallowEscapeKeyup) {
      return { block: true, close: false, nextState: state };
    }
    return { block: false, close: false, nextState: state };
  }

  // keyup Escape
  if (state.swallowEscapeKeyup) {
    return { block: true, close: false, nextState: { ...state, swallowEscapeKeyup: false } };
  }
  return { block: false, close: false, nextState: state };
}

/**
 * PolarisSelect: menu a tendina costruito con Polaris, senza <select> nativo.
 *
 * Accessibilità:
 * - Apertura con Enter/Space o click
 * - Chiusura con Escape: keydown e keyup fermati in capture su window, così la Modal resta aperta
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

  // Stato della guardia Escape in ref: i listener sotto sono registrati una sola volta.
  const isOpenRef = useRef(false);
  const swallowEscapeKeyupRef = useRef(false);
  const closePopoverAndRefocusRef = useRef(closePopoverAndRefocus);
  closePopoverAndRefocusRef.current = closePopoverAndRefocus;

  useEffect(() => {
    isOpenRef.current = popoverActive;
  }, [popoverActive]);

  // Listener in capture su window, registrati al mount e rimossi solo all'unmount.
  // Così il keyup dell'Escape viene fermato anche dopo che il menu si è chiuso
  // sul keydown, prima che arrivi al listener keyup della Modal su document.
  useEffect(() => {
    const handle = (event: Event) => {
      const guardEvent: EscapeGuardEvent =
        event.type === 'blur'
          ? { type: 'blur' }
          : { type: event.type as 'keydown' | 'keyup', key: (event as KeyboardEvent).key };
      const result = reduceEscapeGuard(
        { open: isOpenRef.current, swallowEscapeKeyup: swallowEscapeKeyupRef.current },
        guardEvent
      );
      isOpenRef.current = result.nextState.open;
      swallowEscapeKeyupRef.current = result.nextState.swallowEscapeKeyup;
      if (result.block) {
        event.preventDefault();
        event.stopImmediatePropagation();
        event.stopPropagation();
      }
      if (result.close) {
        closePopoverAndRefocusRef.current();
      }
    };

    window.addEventListener('keydown', handle, true);
    window.addEventListener('keyup', handle, true);
    window.addEventListener('blur', handle);
    return () => {
      window.removeEventListener('keydown', handle, true);
      window.removeEventListener('keyup', handle, true);
      window.removeEventListener('blur', handle);
    };
  }, []);

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
