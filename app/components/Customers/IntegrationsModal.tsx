// app/components/Customers/IntegrationsModal.tsx
//
// Modal «Gestisci» per le integrazioni: catalogo + dettaglio.

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Modal,
  TextField,
  BlockStack,
  InlineGrid,
  Card,
  Text,
  Badge,
  Button,
  InlineStack,
  Thumbnail,
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

/**
 * Converts sample date values to human-readable preview lines.
 *
 * Takes up to 5 samples, skips those with null parsed dates, and formats
 * the parsed ISO dates as "15 Mar 1990".
 */
export function previewLines(samples: Sample[], format: DateFormat): PreviewLine[] {
  const MAX_PREVIEWS = 5;

  return samples
    .filter((s) => s.parsed !== null)
    .slice(0, MAX_PREVIEWS)
    .map((s) => ({
      raw: s.raw,
      display: formatDateForDisplay(s.parsed!),
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
 * - If ambiguous, dateFormat must be DMY or MDY (not auto or YMD)
 */
export function canSaveMapping({
  sourceKey,
  ambiguous,
  dateFormat,
}: {
  sourceKey: string;
  ambiguous: boolean;
  dateFormat: DateFormat;
}): boolean {
  if (!sourceKey || sourceKey.trim() === '') return false;
  if (ambiguous && (dateFormat === 'auto' || dateFormat === 'YMD')) return false;
  return true;
}

/**
 * Validates an OAuth callback message.
 *
 * Security rules (controller-mandated):
 * - event.origin must match appOrigin
 * - event.source must match the popup window
 * - data.type must be 'klaviyo-oauth'
 * - data.code and data.state must be present
 *
 * Returns true if all checks pass, false otherwise.
 */
export function isValidOAuthMessage(
  event: MessageEvent,
  popupWindow: Window | null,
  appOrigin: string,
): boolean {
  // Check origin
  if (event.origin !== appOrigin) return false;

  // Check source
  if (event.source !== popupWindow) return false;

  // Check data shape
  const data = event.data as { type?: string; code?: string; state?: string; ok?: boolean };
  if (data.type !== 'klaviyo-oauth') return false;

  // Must have code and state (success messages only)
  if (!data.code || !data.state) return false;

  return true;
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

            {/* Category navigation - simplified for now, can be enhanced with Navigation component */}
            <InlineStack gap="200">
              <Button
                variant={selectedCategory === 'all' ? 'primary' : 'secondary'}
                onClick={() => setSelectedCategory('all')}
                size="slim"
              >
                {t.customers.integrationsModal.allCategory}
              </Button>
              {categories.map((cat) => (
                <Button
                  key={cat}
                  variant={selectedCategory === cat ? 'primary' : 'secondary'}
                  onClick={() => setSelectedCategory(cat)}
                  size="slim"
                >
                  {t.customers.integrationsModal.categories[cat]}
                </Button>
              ))}
            </InlineStack>

            <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
              {filteredIntegrations.map((integration) => (
                <Card key={integration.id}>
                  <BlockStack gap="200">
                    <button
                      onClick={() => handleSelect(integration)}
                      disabled={integration.status === 'coming_soon'}
                      style={{
                        all: 'unset',
                        cursor: integration.status === 'coming_soon' ? 'default' : 'pointer',
                        width: '100%',
                      }}
                    >
                      <BlockStack gap="200" inlineAlign="center">
                        {integration.logo && (
                          <Thumbnail
                            source={integration.logo}
                            alt={integration.name}
                            size="large"
                          />
                        )}
                        <Text as="p" variant="bodyMd" fontWeight="semibold" alignment="center">
                          {integration.name}
                        </Text>
                        {integration.status === 'coming_soon' && (
                          <Badge tone="info">{t.customers.integrationsModal.comingSoon}</Badge>
                        )}
                      </BlockStack>
                    </button>
                  </BlockStack>
                </Card>
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
