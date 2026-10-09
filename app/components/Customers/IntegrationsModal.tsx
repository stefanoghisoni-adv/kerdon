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
  status: 'connected' | 'not_connected' | 'needs_reconnect';
  canSave: boolean;
  hasMapping: boolean;
  running: boolean;
  saving: boolean;
  importing: boolean;
  onSave: () => void;
  onImport: () => void;
  onConnect: () => void;
  connectLabel: string;
  reconnectLabel: string;
  saveLabel: string;
  importLabel: string;
}

/**
 * Costruisce le azioni del footer della modal in base allo stato.
 * Funzione pura per testing.
 */
export function buildFooterActions(input: FooterActionsInput): {
  primary: FooterAction | undefined;
  secondary: FooterAction[];
} {
  const {
    status,
    canSave,
    hasMapping,
    running,
    saving,
    importing,
    onSave,
    onImport,
    onConnect,
    connectLabel,
    reconnectLabel,
    saveLabel,
    importLabel,
  } = input;

  if (status === 'not_connected') {
    return {
      primary: {
        content: connectLabel,
        loading: false,
        onAction: onConnect,
      },
      secondary: [],
    };
  }

  if (status === 'needs_reconnect') {
    return {
      primary: {
        content: reconnectLabel,
        loading: false,
        onAction: onConnect,
      },
      secondary: [],
    };
  }

  // connected
  return {
    primary: {
      content: saveLabel,
      loading: saving,
      disabled: !canSave,
      onAction: onSave,
    },
    secondary: [
      {
        content: importLabel,
        loading: importing || running,
        disabled: !hasMapping || running,
        onAction: onImport,
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
  const [primaryAction, setPrimaryAction] = useState<{ content: string; loading?: boolean; disabled?: boolean; onAction: () => void } | undefined>(undefined);
  const [secondaryActions, setSecondaryActions] = useState<Array<{ content: string; loading?: boolean; disabled?: boolean; onAction: () => void }>>([]);

  // Callback stabile per esporre azioni (evita loop infinito nelle dipendenze)
  const handleActionsChange = useCallback((
    primary: { content: string; loading?: boolean; disabled?: boolean; onAction: () => void } | undefined,
    secondary: Array<{ content: string; loading?: boolean; disabled?: boolean; onAction: () => void }>
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
      secondaryActions={secondaryActions}
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
