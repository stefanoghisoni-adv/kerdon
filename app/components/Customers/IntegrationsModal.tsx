// app/components/Customers/IntegrationsModal.tsx
//
// Modal di configurazione per la singola integrazione.

import { useEffect, useState, useCallback } from 'react';
import { Modal } from '@shopify/polaris';
import {
  INTEGRATIONS,
  type IntegrationId,
} from '~/lib/integrations/registry';
import type { DateFormat } from '~/lib/integrations/values';
import { parseDate } from '~/lib/integrations/values';
import { KlaviyoDetail } from './KlaviyoDetail';
import {
  isValidOAuthMessage as isValidPopupMessage,
  type OAuthMessageValidation,
} from '~/lib/oauth-popup-message';

export interface IntegrationsModalProps {
  open: boolean;
  onClose: () => void;
  /** Provider dell'integrazione da configurare. */
  preselected?: IntegrationId | null;
}

export interface Sample {
  raw: string;
  parsed: string | null;
}

export interface PreviewLine {
  raw: string;
  display: string;
}

export type { OAuthMessageValidation } from '~/lib/oauth-popup-message';

/**
 * Converts sample date values to human-readable preview lines using the given format.
 *
 * I2 FIX: Re-parses each raw value with parseDate(raw, format) to respect
 * the merchant's format choice. Takes up to 5 successfully parsed samples.
 */
export function previewLines(samples: Sample[], format: DateFormat): PreviewLine[] {
  const MAX_PREVIEWS = 5;

  return samples
    .map((s) => {
      const parsed = parseDate(s.raw, format);
      return parsed.ok ? { raw: s.raw, parsed: parsed.date } : null;
    })
    .filter((item): item is { raw: string; parsed: string } => item !== null)
    .slice(0, MAX_PREVIEWS)
    .map((item) => ({
      raw: item.raw,
      display: formatDateForDisplay(item.parsed),
    }));
}

/**
 * Formats an ISO date (YYYY-MM-DD) as "15 Mar 1990".
 */
function formatDateForDisplay(iso: string): string {
  try {
    const date = new Date(iso + 'T00:00:00Z');
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  } catch {
    return iso;
  }
}

/**
 * Checks if the mapping can be saved.
 *
 * Rules:
 * - sourceKey must not be empty
 * - If ambiguous, dateFormat must be DMY or MDY (not auto, YMD, or empty string)
 *
 * I3 FIX: Handles empty string for dateFormat (when ambiguous property requires explicit choice).
 */
export function canSaveMapping({
  sourceKey,
  ambiguous,
  dateFormat,
}: {
  sourceKey: string;
  ambiguous: boolean;
  dateFormat: DateFormat | '';
}): boolean {
  if (!sourceKey || sourceKey.trim() === '') return false;
  if (ambiguous && (dateFormat === '' || dateFormat === 'auto' || dateFormat === 'YMD')) return false;
  return true;
}

/**
 * Determina se la selezione corrente differisce da quella salvata.
 *
 * Regole:
 * - Se non c'è mapping salvato, la selezione è sempre dirty (a meno che non sia vuota)
 * - Se c'è un mapping salvato, confronta sourceKey e dateFormat
 */
export function isMappingDirty(
  saved: { sourceKey: string; dateFormat: string } | null,
  current: { sourceKey: string; dateFormat: DateFormat | '' }
): boolean {
  if (!saved) {
    // Nessun mapping salvato: dirty se c'è qualcosa selezionato
    return current.sourceKey !== '';
  }

  // Confronta con il mapping salvato
  return saved.sourceKey !== current.sourceKey || saved.dateFormat !== current.dateFormat;
}

/**
 * Il messaggio di ritorno dalla finestra di Klaviyo: le regole stanno nella
 * funzione condivisa con Supabase (`~/lib/oauth-popup-message`), qui si fissa
 * solo il tipo atteso.
 */
export function isValidOAuthMessage(
  event: MessageEvent,
  popupWindow: Window | null,
  appOrigin: string,
): OAuthMessageValidation {
  return isValidPopupMessage(event, popupWindow, appOrigin, 'klaviyo-oauth');
}

export type FooterAction = {
  content: string;
  loading?: boolean;
  disabled?: boolean;
  onAction: () => void;
};

export interface FooterActionsInput {
  statusLoading: boolean;
  status: 'connected' | 'not_connected' | 'needs_reconnect';
  hasSavedMapping: boolean;
  isDirty: boolean;
  canSave: boolean;
  running: boolean;
  saving: boolean;
  importing: boolean;
  onSave: () => void;
  onImport: () => void;
  cancelLabel: string;
  updateSelectionLabel: string;
  importLabel: string;
}

/**
 * Costruisce le azioni del footer della modal in base allo stato.
 * Funzione pura per testing.
 *
 * Footer sempre a 3 pulsanti:
 * - «Annulla» (secondaryActions[0]): chiude la modal
 * - «Aggiorna selezione» (secondaryActions[1]): salva e resta aperta
 * - «Importa dati» (primaryAction): avvia l'import
 */
export function buildFooterActions(input: FooterActionsInput): {
  primary: FooterAction | undefined;
  secondary: FooterAction[];
} {
  const {
    statusLoading,
    status,
    hasSavedMapping,
    isDirty,
    canSave,
    running,
    saving,
    importing,
    onSave,
    onImport,
    cancelLabel,
    updateSelectionLabel,
    importLabel,
  } = input;

  // Mentre lo status carica: solo «Annulla» abilitato
  if (statusLoading) {
    return {
      primary: {
        content: importLabel,
        disabled: true,
        onAction: onImport,
      },
      secondary: [
        {
          content: cancelLabel,
          onAction: () => {}, // Placeholder: sarà gestito dal genitore (onClose)
        },
        {
          content: updateSelectionLabel,
          disabled: true,
          onAction: onSave,
        },
      ],
    };
  }

  // not_connected o needs_reconnect: «Aggiorna selezione» e «Importa dati» disabilitati
  if (status === 'not_connected' || status === 'needs_reconnect') {
    return {
      primary: {
        content: importLabel,
        disabled: true,
        onAction: onImport,
      },
      secondary: [
        {
          content: cancelLabel,
          onAction: () => {}, // Placeholder: sarà gestito dal genitore (onClose)
        },
        {
          content: updateSelectionLabel,
          disabled: true,
          onAction: onSave,
        },
      ],
    };
  }

  // connected: logica completa
  return {
    primary: {
      content: importLabel,
      loading: importing || running,
      disabled: !hasSavedMapping || isDirty || running,
      onAction: onImport,
    },
    secondary: [
      {
        content: cancelLabel,
        onAction: () => {}, // Placeholder: sarà gestito dal genitore (onClose)
      },
      {
        content: updateSelectionLabel,
        loading: saving,
        disabled: !isDirty || !canSave,
        onAction: onSave,
      },
    ],
  };
}

export function IntegrationsModal({
  open,
  onClose,
  preselected,
}: IntegrationsModalProps) {
  // Trova l'integrazione dal provider preselezionato
  const integration = preselected ? INTEGRATIONS.find((i) => i.id === preselected) : null;
  const title = integration?.name ?? '';

  // Azioni per il footer della modal (esposte da KlaviyoDetail)
  const [primaryAction, setPrimaryAction] = useState<FooterAction | undefined>(undefined);
  const [secondaryActions, setSecondaryActions] = useState<FooterAction[]>([]);

  // Callback stabile per esporre azioni (evita loop infinito nelle dipendenze)
  const handleActionsChange = useCallback((
    primary: FooterAction | undefined,
    secondary: FooterAction[]
  ) => {
    setPrimaryAction(primary);
    setSecondaryActions(secondary);
  }, []);

  // Reset actions when modal closes
  useEffect(() => {
    if (!open) {
      setPrimaryAction(undefined);
      setSecondaryActions([]);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      primaryAction={primaryAction}
      secondaryActions={secondaryActions.length ? secondaryActions : undefined}
    >
      {integration?.id === 'klaviyo' && (
        <KlaviyoDetail
          onClose={onClose}
          onActionsChange={handleActionsChange}
        />
      )}
    </Modal>
  );
}
