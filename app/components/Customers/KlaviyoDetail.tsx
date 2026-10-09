// app/components/Customers/KlaviyoDetail.tsx
//
// Dettaglio Klaviyo: OAuth, mapping, preview, import.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useFetcher, useRevalidator, useSearchParams, useNavigate } from '@remix-run/react';
import {
  BlockStack,
  Text,
  Button,
  Banner,
  Select,
  List,
  InlineStack,
  Spinner,
  Modal,
  Thumbnail,
  FormLayout,
  Divider,
  Link,
} from '@shopify/polaris';
import { useT, useLocale } from '~/lib/i18n/context';
import type { DateFormat } from '~/lib/integrations/values';
import { previewLines, canSaveMapping, isValidOAuthMessage } from './IntegrationsModal';
import type { Sample } from './IntegrationsModal';
import { useIntegrationImport } from './useIntegrationImport';
import { buildConflictsUrl, tileState, type IntegrationStatus } from './IntegrationsCard';
import { INTEGRATIONS } from '~/lib/integrations/registry';

export interface KlaviyoDetailProps {
  onClose: () => void;
  /** Callback per esporre le azioni al footer della modal. */
  onActionsChange: (
    primary: { content: string; loading?: boolean; disabled?: boolean; onAction: () => void } | undefined,
    secondary: Array<{ content: string; loading?: boolean; disabled?: boolean; onAction: () => void }>
  ) => void;
}

interface Property {
  key: string;
  samples: Sample[];
  format: DateFormat;
  ambiguous: boolean;
}

interface StatusData {
  status: 'connected' | 'not_connected' | 'needs_reconnect';
  accountName?: string | null;
  mapping: { sourceKey: string; dateFormat: string } | null;
  /** Un import e' in corso adesso. */
  running?: boolean;
  openConflicts?: number;
  lastRun?: {
    status: 'completed' | 'interrupted';
    finishedAt: string | null;
    counters: { filled?: number; conflicts?: number; [key: string]: unknown };
  } | null;
}

/**
 * Decides whether to show the account name in the account row.
 * Returns true if accountName is not empty/null/whitespace.
 */
export function shouldShowAccountName(accountName?: string | null): boolean {
  return !!(accountName && accountName.trim().length > 0);
}

interface PropertiesData {
  properties: Property[];
  error?: string;
}

/**
 * Decides what dateFormat to use when a property is selected.
 *
 * I3 FIX Round 3: Added sourceKeyChanged parameter.
 *
 * Rules:
 * - Source key unchanged: keep current format (user's choice persists)
 * - Non-ambiguous: use property's detected format
 * - Ambiguous with saved mapping for this property: use saved format
 * - Ambiguous without saved mapping: return '' (require explicit choice)
 */
export function decideDateFormat({
  property,
  savedMapping,
  currentFormat,
  sourceKeyChanged,
}: {
  property: Property | undefined;
  savedMapping: { sourceKey: string; dateFormat: string } | null;
  currentFormat: DateFormat | '';
  sourceKeyChanged: boolean;
}): DateFormat | '' {
  if (!property) return currentFormat;

  // Source key unchanged: keep current format (user has made a choice)
  if (!sourceKeyChanged) {
    return currentFormat;
  }

  // Non-ambiguous: use detected format
  if (!property.ambiguous) {
    return property.format;
  }

  // Ambiguous with saved mapping for this exact property: use saved format
  if (savedMapping && savedMapping.sourceKey === property.key) {
    return (savedMapping.dateFormat as DateFormat) ?? 'auto';
  }

  // Ambiguous without saved mapping: require explicit choice
  return '';
}

export function KlaviyoDetail({ onClose, onActionsChange }: KlaviyoDetailProps) {
  const t = useT();
  const locale = useLocale();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Fetchers
  const statusFetcher = useFetcher<StatusData>();
  const oauthFetcher = useFetcher<{ url: string }>();
  const connectFetcher = useFetcher<{ ok: boolean; error?: string }>();
  const propertiesFetcher = useFetcher<PropertiesData>();
  const saveMappingFetcher = useFetcher<{ ok: boolean; error?: string }>();
  const disconnectFetcher = useFetcher<{ ok: boolean; error?: string }>();

  // Shared import hook
  const { importFetcher, handleImport, importReason } = useIntegrationImport('klaviyo');

  // Local state
  const [selectedProperty, setSelectedProperty] = useState('');
  const [dateFormat, setDateFormat] = useState<DateFormat | ''>('');
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [propertiesError, setPropertiesError] = useState<string | null>(null);
  const [saveMappingError, setSaveMappingError] = useState<string | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);

  // Load status on mount
  useEffect(() => {
    if (statusFetcher.state === 'idle' && !statusFetcher.data) {
      statusFetcher.load('/api/integrations/klaviyo');
    }
  }, [statusFetcher]);

  const status = statusFetcher.data?.status ?? 'not_connected';
  const accountName = statusFetcher.data?.accountName;
  const mapping = statusFetcher.data?.mapping;
  const properties = propertiesFetcher.data?.properties ?? [];

  // Load properties when connected
  useEffect(() => {
    if (status === 'connected' && propertiesFetcher.state === 'idle' && !propertiesFetcher.data) {
      propertiesFetcher.load('/api/integrations/klaviyo?view=properties');
    }
  }, [status, propertiesFetcher]);

  // Handle properties load errors
  useEffect(() => {
    if (propertiesFetcher.data?.error) {
      const error = propertiesFetcher.data.error;
      if (error === 'reconnect') {
        setPropertiesError('reconnect');
      } else if (error === 'unavailable') {
        setPropertiesError('unavailable');
      }
    }
  }, [propertiesFetcher.data]);

  // Initialize selected property and format from mapping (once per mapping identity)
  const mappingIdentity = mapping ? `${mapping.sourceKey}:${mapping.dateFormat}` : null;
  const lastMappingIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    if (mappingIdentity && mappingIdentity !== lastMappingIdentityRef.current) {
      lastMappingIdentityRef.current = mappingIdentity;
      setSelectedProperty(mapping!.sourceKey);
      setDateFormat((mapping!.dateFormat as DateFormat) ?? 'auto');
    }
  }, [mappingIdentity, mapping]);

  // I3 FIX Round 3: Simplified - decideDateFormat now handles the sourceKeyChanged logic
  const prevSourceKeyRef = useRef<string>('');

  useEffect(() => {
    const sourceKeyChanged = selectedProperty !== prevSourceKeyRef.current;
    if (sourceKeyChanged) {
      prevSourceKeyRef.current = selectedProperty;
    }

    const property = properties.find((p) => p.key === selectedProperty);
    const newFormat = decideDateFormat({
      property,
      savedMapping: mapping ?? null,
      currentFormat: dateFormat,
      sourceKeyChanged,
    });

    setDateFormat(newFormat);
  }, [selectedProperty, properties, mapping, dateFormat]);

  // I6 FIX Round 3: Track OAuth attempt to prevent stale URL navigation
  const oauthAttemptRef = useRef(0);

  // OAuth flow: open blank popup synchronously, then navigate after fetch
  const handleConnect = useCallback(() => {
    // Open blank popup immediately (synchronously in click handler)
    const popup = window.open('', 'klaviyo-oauth', 'width=600,height=700');

    if (!popup) {
      setPopupBlocked(true);
      return;
    }

    popupRef.current = popup;
    setPopupBlocked(false);
    setOauthError(null);

    // Increment attempt counter and fetch fresh URL
    oauthAttemptRef.current += 1;
    oauthFetcher.load('/api/integrations/klaviyo/oauth-url');
  }, [oauthFetcher]);

  // I6 FIX Round 3: Navigate popup only for current attempt's response
  const lastNavigatedAttemptRef = useRef(0);

  useEffect(() => {
    // Only navigate if we have a URL, a popup, and this response belongs to current attempt
    if (
      oauthFetcher.data?.url &&
      popupRef.current &&
      !popupRef.current.closed &&
      lastNavigatedAttemptRef.current < oauthAttemptRef.current
    ) {
      lastNavigatedAttemptRef.current = oauthAttemptRef.current;

      try {
        popupRef.current.location.href = oauthFetcher.data.url;
      } catch (e) {
        // Navigation failed
        popupRef.current.close();
        popupRef.current = null;
        setOauthError('failed');
      }
    }
  }, [oauthFetcher.data]);

  // Minor FIX: Detect oauth-url load finishing without usable response
  const prevOauthStateRef = useRef<'idle' | 'loading' | 'submitting'>('idle');

  useEffect(() => {
    const currentState = oauthFetcher.state;
    const wasLoading = prevOauthStateRef.current === 'loading';
    const nowIdle = currentState === 'idle';

    // Attempt finished (loading → idle)
    if (wasLoading && nowIdle) {
      // Check if we got a usable URL
      const hasUsableUrl = oauthFetcher.data?.url;

      if (!hasUsableUrl && popupRef.current) {
        // Load failed or returned no URL - close popup and warn
        popupRef.current.close();
        popupRef.current = null;
        setOauthError('failed');
      }
    }

    prevOauthStateRef.current = currentState;
  }, [oauthFetcher.state, oauthFetcher.data]);

  // Listen for OAuth callback
  useEffect(() => {
    const appOrigin = window.location.origin;

    const handleMessage = (event: MessageEvent) => {
      const validationResult = isValidOAuthMessage(event, popupRef.current, appOrigin);

      if (validationResult.ok) {
        // Success: send code + state to backend
        connectFetcher.submit(
          { code: validationResult.data.code, state: validationResult.data.state },
          { method: 'POST', action: '/api/integrations/klaviyo/connect', encType: 'application/json' }
        );
        popupRef.current = null;
      } else if (!validationResult.ok && 'error' in validationResult && validationResult.error) {
        // Error from OAuth flow
        setOauthError(validationResult.error);
        popupRef.current = null;
      }
      // Otherwise ignore (origin/source mismatch, etc.)
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [connectFetcher]);

  // Track handled connect responses to avoid infinite reloads (C1 fix)
  const handledConnectRef = useRef<typeof connectFetcher.data>(null);

  // Reload data after successful connection
  useEffect(() => {
    if (connectFetcher.data && connectFetcher.data !== handledConnectRef.current) {
      handledConnectRef.current = connectFetcher.data;

      if (connectFetcher.data.ok) {
        revalidator.revalidate();
        statusFetcher.load('/api/integrations/klaviyo');
        setOauthError(null);
        // Clear properties error and reload properties after reconnect
        setPropertiesError(null);
        if (propertiesFetcher.state === 'idle') {
          propertiesFetcher.load('/api/integrations/klaviyo?view=properties');
        }
      } else {
        setOauthError(connectFetcher.data.error ?? 'unknown');
      }
    }
  }, [connectFetcher.data, revalidator, statusFetcher, propertiesFetcher]);

  const handleSaveMapping = useCallback(() => {
    const property = properties.find((p) => p.key === selectedProperty);
    if (!property) return;

    setSaveMappingError(null);
    saveMappingFetcher.submit(
      {
        intent: 'save-mapping',
        sourceKey: selectedProperty,
        targetField: 'birthdate',
        dateFormat,
        ambiguous: property.ambiguous,
      },
      { method: 'POST', action: '/api/integrations/klaviyo', encType: 'application/json' }
    );
  }, [selectedProperty, dateFormat, properties, saveMappingFetcher]);

  // Track handled save-mapping responses
  const handledSaveMappingRef = useRef<typeof saveMappingFetcher.data>(null);

  // Reload after saving mapping
  useEffect(() => {
    if (saveMappingFetcher.data && saveMappingFetcher.data !== handledSaveMappingRef.current) {
      handledSaveMappingRef.current = saveMappingFetcher.data;

      if (saveMappingFetcher.data.ok) {
        statusFetcher.load('/api/integrations/klaviyo');
        onClose();
      } else {
        setSaveMappingError(saveMappingFetcher.data.error ?? 'unknown');
      }
    }
  }, [saveMappingFetcher.data, statusFetcher, onClose]);

  const handleDisconnectClick = useCallback(() => {
    setShowDisconnectConfirm(true);
  }, []);

  const handleDisconnectConfirm = useCallback(() => {
    setShowDisconnectConfirm(false);
    setDisconnectError(null);
    disconnectFetcher.submit(
      { intent: 'disconnect' },
      { method: 'POST', action: '/api/integrations/klaviyo', encType: 'application/json' }
    );
  }, [disconnectFetcher]);

  const handleDisconnectCancel = useCallback(() => {
    setShowDisconnectConfirm(false);
  }, []);

  // Track handled disconnect responses to avoid infinite reloads (C1 fix)
  const handledDisconnectRef = useRef<typeof disconnectFetcher.data>(null);

  // Reload after disconnect
  useEffect(() => {
    if (disconnectFetcher.data && disconnectFetcher.data !== handledDisconnectRef.current) {
      handledDisconnectRef.current = disconnectFetcher.data;

      if (disconnectFetcher.data.ok) {
        // La card della pagina si aggiorna da sola: il POST del fetcher fa
        // gia' rivalidare a Remix i loader della pagina.
        statusFetcher.load('/api/integrations/klaviyo');
        setSelectedProperty('');
        setDateFormat('');
        // Minor FIX: Reset mapping identity ref so reconnect re-applies saved mapping
        lastMappingIdentityRef.current = null;
      } else {
        setDisconnectError(disconnectFetcher.data.error ?? 'unknown');
      }
    }
  }, [disconnectFetcher.data, statusFetcher]);

  // I6 FIX Round 3: Retry always fetches fresh URL
  const handleRetryPopup = useCallback(() => {
    // Synchronously open blank popup
    const popup = window.open('', 'klaviyo-oauth', 'width=600,height=700');

    if (!popup) {
      // Still blocked
      return;
    }

    popupRef.current = popup;
    setPopupBlocked(false);

    // Always trigger fresh load (never reuse old URL)
    oauthAttemptRef.current += 1;
    oauthFetcher.load('/api/integrations/klaviyo/oauth-url');
  }, [oauthFetcher]);

  // Handler per il link ai conflitti: chiude la modal e naviga
  const handleConflictsClick = useCallback(() => {
    onClose();
    navigate(buildConflictsUrl(searchParams.toString()));
  }, [onClose, navigate, searchParams]);

  // Computed values needed for footer actions (before early return)
  const selectedProp = properties.find((p) => p.key === selectedProperty);
  const canSave = canSaveMapping({
    sourceKey: selectedProperty,
    ambiguous: selectedProp?.ambiguous ?? false,
    dateFormat: dateFormat as DateFormat,
  });

  // Esponi le azioni del footer (PRIMA di ogni early return per evitare hook violation)
  useEffect(() => {
    if (status === 'not_connected' || status === 'needs_reconnect') {
      // Not connected: pulsante collegamento come primaryAction
      onActionsChange(
        {
          content: status === 'needs_reconnect'
            ? t.customers.integrations.reconnect
            : t.customers.klaviyoDetail.connect,
          loading: oauthFetcher.state === 'loading' || connectFetcher.state === 'submitting',
          onAction: handleConnect,
        },
        []
      );
    } else if (status === 'connected') {
      // Connected: Salva + Importa dati
      onActionsChange(
        {
          content: t.customers.klaviyoDetail.save,
          loading: saveMappingFetcher.state === 'submitting',
          disabled: !canSave,
          onAction: handleSaveMapping,
        },
        [
          {
            content: t.customers.integrations.importData,
            loading: importFetcher.state !== 'idle' || statusFetcher.data?.running === true,
            disabled: !mapping || statusFetcher.data?.running === true,
            onAction: () => handleImport(),
          },
        ]
      );
    }
  }, [
    status,
    oauthFetcher.state,
    connectFetcher.state,
    canSave,
    saveMappingFetcher.state,
    importFetcher.state,
    mapping,
    statusFetcher.data?.running,
    handleConnect,
    handleSaveMapping,
    handleImport,
    t,
    onActionsChange,
  ]);

  // I13 FIX: Show spinner whenever !statusFetcher.data (covers first frame)
  const isLoadingStatus = !statusFetcher.data;

  // Entrata Klaviyo dal registro per logo e nome
  const klaviyoEntry = INTEGRATIONS.find((i) => i.id === 'klaviyo');

  if (isLoadingStatus) {
    return (
      <Modal.Section>
        <BlockStack gap="400" inlineAlign="center">
          <Spinner size="small" />
        </BlockStack>
      </Modal.Section>
    );
  }

  // Not connected / needs_reconnect
  if (status === 'not_connected' || status === 'needs_reconnect') {

    return (
      <Modal.Section>
        <BlockStack gap="400">
          <Text as="p">{t.customers.klaviyoDetail.benefitText}</Text>

          {oauthError && (
            <Banner tone="warning" onDismiss={() => setOauthError(null)}>
              {t.customers.klaviyoDetail.oauthErrors[oauthError as keyof typeof t.customers.klaviyoDetail.oauthErrors] ?? t.customers.klaviyoDetail.oauthErrors.unknown}
            </Banner>
          )}

          {popupBlocked && (
            <Banner
              tone="warning"
              action={{
                content: t.customers.klaviyoDetail.retryPopup,
                onAction: handleRetryPopup,
              }}
            >
              {t.customers.klaviyoDetail.popupBlocked}
            </Banner>
          )}
        </BlockStack>
      </Modal.Section>
    );
  }

  // Connected: struttura a 3 sezioni
  const previews = selectedProp ? previewLines(selectedProp.samples, dateFormat as DateFormat) : [];

  // Determina lo stato del tile (per il colore e il testo dello stato)
  const integrationStatus: IntegrationStatus | undefined = statusFetcher.data
    ? {
        provider: 'klaviyo' as const,
        status: statusFetcher.data.status,
        accountName: statusFetcher.data.accountName,
        mapping: statusFetcher.data.mapping,
        lastRun: statusFetcher.data.lastRun ?? null,
        running: statusFetcher.data.running ?? false,
        openConflicts: statusFetcher.data.openConflicts ?? 0,
      }
    : undefined;

  const state = klaviyoEntry && integrationStatus
    ? tileState(klaviyoEntry, integrationStatus)
    : { label: 'tileInstalled' as const, tone: 'success' as const, clickable: true };

  // Formatta la data dell'ultimo import con il locale del merchant
  const lastRunDate = statusFetcher.data?.lastRun?.finishedAt
    ? new Date(statusFetcher.data.lastRun.finishedAt).toLocaleString(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  const lastRunCounters = statusFetcher.data?.lastRun?.counters;
  const filledCount = lastRunCounters?.filled ?? 0;

  return (
    <>
      {/* Sezione 1: Account */}
      <Modal.Section>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center" wrap={false}>
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              {klaviyoEntry?.logo && (
                <Thumbnail
                  source={klaviyoEntry.logo}
                  alt={klaviyoEntry.name}
                  size="small"
                  transparent
                />
              )}
              <BlockStack gap="100">
                {shouldShowAccountName(accountName) && (
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {accountName}
                  </Text>
                )}
                <Text as="p" tone={state.tone}>
                  {t.customers.integrations[state.label]}
                </Text>
              </BlockStack>
            </InlineStack>
            {!showDisconnectConfirm && (
              <Button
                variant="plain"
                tone="critical"
                onClick={handleDisconnectClick}
                loading={disconnectFetcher.state === 'submitting'}
              >
                {t.customers.klaviyoDetail.disconnect}
              </Button>
            )}
          </InlineStack>

          {showDisconnectConfirm && (
            <Banner
              tone="warning"
              action={{
                content: t.common.confirm,
                onAction: handleDisconnectConfirm,
              }}
              secondaryAction={{
                content: t.common.cancel,
                onAction: handleDisconnectCancel,
              }}
            >
              {t.customers.klaviyoDetail.disconnectConfirm}
            </Banner>
          )}

          {propertiesError && (
            <Banner tone="warning">
              {propertiesError === 'reconnect'
                ? t.customers.klaviyoDetail.errors.propertiesReconnect
                : t.customers.klaviyoDetail.errors.propertiesUnavailable}
            </Banner>
          )}

          {saveMappingError && (
            <Banner tone="warning" onDismiss={() => setSaveMappingError(null)}>
              {t.customers.klaviyoDetail.errors.saveFailed}
            </Banner>
          )}

          {disconnectError && (
            <Banner tone="warning" onDismiss={() => setDisconnectError(null)}>
              {t.customers.klaviyoDetail.errors.disconnectFailed}
            </Banner>
          )}
        </BlockStack>
      </Modal.Section>

      <Divider />

      {/* Sezione 2: Associazione campi */}
      <Modal.Section>
        <BlockStack gap="400">
          <Text as="h3" variant="headingSm">
            {t.customers.klaviyoDetail.fieldMappingTitle}
          </Text>

          <FormLayout>
            <FormLayout.Group>
              <Select
                label={t.customers.klaviyoDetail.klaviyoPropertyLabel}
                options={[
                  { label: t.customers.klaviyoDetail.selectProperty, value: '' },
                  ...properties.map((p) => ({ label: p.key, value: p.key })),
                ]}
                value={selectedProperty}
                onChange={setSelectedProperty}
                disabled={propertiesFetcher.state === 'loading'}
              />

              <Select
                label={t.customers.klaviyoDetail.kerdonFieldLabel}
                options={[{ label: t.customers.klaviyoDetail.birthdate, value: 'birthdate' }]}
                value="birthdate"
                disabled
              />
            </FormLayout.Group>

            {selectedProp && selectedProp.ambiguous && (
              <Select
                label={t.customers.klaviyoDetail.dateFormatLabel}
                options={[
                  { label: t.customers.klaviyoDetail.selectFormat, value: '' },
                  { label: 'DD/MM/YYYY', value: 'DMY' },
                  { label: 'MM/DD/YYYY', value: 'MDY' },
                ]}
                value={dateFormat}
                onChange={(value) => setDateFormat(value as DateFormat)}
              />
            )}
          </FormLayout>

          {previews.length > 0 && (
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {t.customers.klaviyoDetail.previewTitle}
              </Text>
              <List type="bullet">
                {previews.map((preview, i) => (
                  <List.Item key={i}>
                    {preview.raw} → {preview.display}
                  </List.Item>
                ))}
              </List>
            </BlockStack>
          )}
        </BlockStack>
      </Modal.Section>

      <Divider />

      {/* Sezione 3: Import */}
      <Modal.Section>
        <BlockStack gap="400">
          {lastRunDate && (
            <Text as="p" tone="subdued">
              {t.customers.integrations.lastImport(lastRunDate, filledCount)}
            </Text>
          )}

          {statusFetcher.data && (statusFetcher.data.openConflicts ?? 0) > 0 && (
            <Text as="p" tone="subdued">
              <Link onClick={handleConflictsClick}>
                {t.customers.integrations.conflicts(statusFetcher.data.openConflicts ?? 0)}
              </Link>
            </Text>
          )}

          {statusFetcher.data?.running && (
            <Text as="p" tone="subdued">
              {t.customers.integrations.importRunning}
            </Text>
          )}

          {importReason && (
            <Banner tone="warning">
              {t.customers.integrations.importReasons[
                importReason as keyof typeof t.customers.integrations.importReasons
              ] ?? importReason}
            </Banner>
          )}
        </BlockStack>
      </Modal.Section>
    </>
  );
}
