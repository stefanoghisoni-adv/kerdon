// app/components/Customers/IntegrationsModal.tsx
//
// Modal «Gestisci» per le integrazioni: catalogo + dettaglio.

import { useState, useEffect, useCallback } from 'react';
import {
  Modal,
  TextField,
  BlockStack,
  InlineGrid,
  Card,
  Text,
  Badge,
  Button,
  Thumbnail,
  OptionList,
  Box,
} from '@shopify/polaris';
import { ArrowLeftIcon } from '@shopify/polaris-icons';
import { useT } from '~/lib/i18n/context';
import {
  INTEGRATIONS,
  categoriesInUse,
  searchIntegrations,
  type IntegrationCategory,
  type IntegrationEntry,
} from '~/lib/integrations/registry';
import type { DateFormat } from '~/lib/integrations/values';
import { parseDate } from '~/lib/integrations/values';
import { KlaviyoDetail } from './KlaviyoDetail';

export interface IntegrationsModalProps {
  open: boolean;
  onClose: () => void;
  /** Provider preselected (for «Riconnetti» or «Gestisci» from a row). */
  preselected?: 'klaviyo' | null;
}

export interface Sample {
  raw: string;
  parsed: string | null;
}

export interface PreviewLine {
  raw: string;
  display: string;
}

export type OAuthMessageValidation =
  | {
      ok: true;
      data: { code: string; state: string };
    }
  | {
      ok: false;
      error?: string;
    };

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
 * Validates an OAuth callback message.
 *
 * Security rules (controller-mandated):
 * - popupWindow must not be null
 * - event.origin must match appOrigin
 * - event.source must match the popup window
 * - data must be a non-null object
 * - data.type must be 'klaviyo-oauth'
 * - For success: data.code and data.state must be present
 * - For error: data.ok === false and data.error present
 *
 * Returns { ok: true, data } for success or { ok: false, error } for known errors.
 * Returns { ok: false } (no error) when security checks fail (ignore silently).
 *
 * I5 FIX: Accepts error-shaped messages under the same origin+source checks.
 * I14 FIX: Rejects when popupRef is null, and when data is not a non-null object.
 */
export function isValidOAuthMessage(
  event: MessageEvent,
  popupWindow: Window | null,
  appOrigin: string,
): OAuthMessageValidation {
  // I14: Reject when popupRef is null
  if (popupWindow === null) return { ok: false };

  // Check origin
  if (event.origin !== appOrigin) return { ok: false };

  // Check source
  if (event.source !== popupWindow) return { ok: false };

  // I14: Harden data check (reject non-object or null)
  const data = event.data;
  if (typeof data !== 'object' || data === null) return { ok: false };

  // Check type
  if (data.type !== 'klaviyo-oauth') return { ok: false };

  // I5: Accept error messages
  if (data.ok === false && typeof data.error === 'string') {
    return { ok: false, error: data.error };
  }

  // Success message: must have code and state
  if (typeof data.code === 'string' && typeof data.state === 'string') {
    return { ok: true, data: { code: data.code, state: data.state } };
  }

  // Unknown shape
  return { ok: false };
}

export function IntegrationsModal({
  open,
  onClose,
  preselected,
}: IntegrationsModalProps) {
  const t = useT();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<IntegrationCategory | 'all'>('all');
  const [selectedIntegration, setSelectedIntegration] = useState<IntegrationEntry | null>(null);

  // Preselect integration if provided
  useEffect(() => {
    if (open && preselected) {
      const integration = INTEGRATIONS.find((i) => i.id === preselected);
      if (integration) {
        setSelectedIntegration(integration);
      }
    }
  }, [open, preselected]);

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setSearchQuery('');
      setSelectedCategory('all');
      setSelectedIntegration(null);
    }
  }, [open]);

  const categories = categoriesInUse();
  const filteredIntegrations = searchIntegrations(searchQuery, selectedCategory);

  const handleBack = useCallback(() => {
    setSelectedIntegration(null);
  }, []);

  const handleSelect = useCallback((integration: IntegrationEntry) => {
    if (integration.status === 'coming_soon') return;
    setSelectedIntegration(integration);
  }, []);

  // I9 FIX: OptionList for categories
  const categoryOptions = [
    { value: 'all', label: t.customers.integrationsModal.allCategory },
    ...categories.map((cat) => ({
      value: cat,
      label: t.customers.integrationsModal.categories[cat],
    })),
  ];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={selectedIntegration ? selectedIntegration.name : t.customers.integrations.title}
      size="large"
    >
      <Modal.Section>
        {selectedIntegration ? (
          <BlockStack gap="400">
            <Button
              variant="plain"
              icon={ArrowLeftIcon}
              onClick={handleBack}
            >
              {t.customers.integrationsModal.backToAll}
            </Button>
            {selectedIntegration.id === 'klaviyo' && (
              <KlaviyoDetail onClose={onClose} />
            )}
          </BlockStack>
        ) : (
          <BlockStack gap="400">
            <TextField
              label={t.customers.integrationsModal.searchLabel}
              labelHidden
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={t.customers.integrationsModal.searchPlaceholder}
              autoComplete="off"
            />

            {/* I9 FIX: OptionList instead of Buttons */}
            <OptionList
              title={t.customers.integrationsModal.categoryLabel}
              options={categoryOptions}
              selected={[selectedCategory]}
              onChange={(selected) => setSelectedCategory(selected[0] as IntegrationCategory | 'all')}
            />

            <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
              {filteredIntegrations.map((integration) => (
                /* I9 FIX: Card with Thumbnail + Button variant="plain" (controller ruling) */
                <Box key={integration.id}>
                  <Card>
                    <BlockStack gap="200" inlineAlign="center">
                      {integration.logo && (
                        <Thumbnail
                          source={integration.logo}
                          alt={integration.name}
                          size="large"
                        />
                      )}
                      {integration.status === 'coming_soon' ? (
                        <>
                          <Text as="p" variant="bodyMd" fontWeight="semibold" alignment="center">
                            {integration.name}
                          </Text>
                          <Badge tone="info">{t.customers.integrationsModal.comingSoon}</Badge>
                        </>
                      ) : (
                        <Button
                          variant="plain"
                          onClick={() => handleSelect(integration)}
                          textAlign="center"
                        >
                          {integration.name}
                        </Button>
                      )}
                    </BlockStack>
                  </Card>
                </Box>
              ))}
            </InlineGrid>

            {filteredIntegrations.length === 0 && (
              <Text as="p" tone="subdued" alignment="center">
                {t.customers.integrationsModal.noResults}
              </Text>
            )}
          </BlockStack>
        )}
      </Modal.Section>
    </Modal>
  );
}
