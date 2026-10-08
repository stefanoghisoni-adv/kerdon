// app/components/Customers/KlaviyoDetail.tsx
//
// Dettaglio Klaviyo: OAuth, mapping, preview, import.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useFetcher, useRevalidator } from '@remix-run/react';
import {
  BlockStack,
  Text,
  Button,
  Banner,
  Select,
  List,
  InlineStack,
} from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import type { DateFormat } from '~/lib/integrations/values';
import { previewLines, canSaveMapping, isValidOAuthMessage } from './IntegrationsModal';
import type { Sample } from './IntegrationsModal';

export interface KlaviyoDetailProps {
  onClose: () => void;
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
}

interface PropertiesData {
  properties: Property[];
}

export function KlaviyoDetail({ onClose }: KlaviyoDetailProps) {
  const t = useT();
  const revalidator = useRevalidator();

  // Fetchers
  const statusFetcher = useFetcher<StatusData>();
  const oauthFetcher = useFetcher<{ url: string }>();
  const connectFetcher = useFetcher<{ ok: boolean; error?: string }>();
  const propertiesFetcher = useFetcher<PropertiesData>();
  const saveMappingFetcher = useFetcher<{ ok: boolean }>();
  const disconnectFetcher = useFetcher<{ ok: boolean }>();
  const importFetcher = useFetcher<{ queued?: boolean; reason?: string }>();

  // Local state
  const [selectedProperty, setSelectedProperty] = useState('');
  const [dateFormat, setDateFormat] = useState<DateFormat>('auto');
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
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

  // Initialize selected property and format from mapping
  useEffect(() => {
    if (mapping) {
      setSelectedProperty(mapping.sourceKey);
      setDateFormat((mapping.dateFormat as DateFormat) ?? 'auto');
    }
  }, [mapping]);

  // Update format when property changes
  useEffect(() => {
    const property = properties.find((p) => p.key === selectedProperty);
    if (property && !property.ambiguous) {
      setDateFormat(property.format);
    } else if (property && property.ambiguous) {
      // Keep current format or set to DMY if auto
      if (dateFormat === 'auto' || dateFormat === 'YMD') {
        setDateFormat('DMY');
      }
    }
  }, [selectedProperty, properties]);

  // OAuth flow
  const handleConnect = useCallback(() => {
    if (oauthFetcher.state === 'idle') {
      oauthFetcher.load('/api/integrations/klaviyo/oauth-url');
    }
  }, [oauthFetcher]);

  useEffect(() => {
    if (oauthFetcher.data?.url) {
      const url = oauthFetcher.data.url;
      const popup = window.open(url, 'klaviyo-oauth', 'width=600,height=700');

      if (!popup) {
        setPopupBlocked(true);
        return;
      }

      popupRef.current = popup;
      setPopupBlocked(false);
      setOauthError(null);
    }
  }, [oauthFetcher.data]);

  // Listen for OAuth callback
  useEffect(() => {
    const appOrigin = window.location.origin;

    const handleMessage = (event: MessageEvent) => {
      if (!isValidOAuthMessage(event, popupRef.current, appOrigin)) {
        return;
      }

      const data = event.data as { code: string; state: string };

      // Send code + state to backend
      connectFetcher.submit(
        { code: data.code, state: data.state },
        { method: 'POST', action: '/api/integrations/klaviyo/connect', encType: 'application/json' }
      );

      popupRef.current = null;
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [connectFetcher]);

  // Reload data after successful connection
  useEffect(() => {
    if (connectFetcher.data?.ok) {
      revalidator.revalidate();
      statusFetcher.load('/api/integrations/klaviyo');
      setOauthError(null);
    } else if (connectFetcher.data && !connectFetcher.data.ok) {
      setOauthError(connectFetcher.data.error ?? 'unknown');
    }
  }, [connectFetcher.data, revalidator, statusFetcher]);

  const handleSaveMapping = useCallback(() => {
    const property = properties.find((p) => p.key === selectedProperty);
    if (!property) return;

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

  // Reload after saving mapping
  useEffect(() => {
    if (saveMappingFetcher.data?.ok) {
      statusFetcher.load('/api/integrations/klaviyo');
      onClose();
    }
  }, [saveMappingFetcher.data, statusFetcher, onClose]);

  const handleDisconnect = useCallback(() => {
    if (window.confirm(t.customers.klaviyoDetail.disconnectConfirm)) {
      disconnectFetcher.submit(
        { intent: 'disconnect' },
        { method: 'POST', action: '/api/integrations/klaviyo', encType: 'application/json' }
      );
    }
  }, [disconnectFetcher, t]);

  // Reload after disconnect
  useEffect(() => {
    if (disconnectFetcher.data?.ok) {
      statusFetcher.load('/api/integrations/klaviyo');
      setSelectedProperty('');
      setDateFormat('auto');
    }
  }, [disconnectFetcher.data, statusFetcher]);

  const handleImport = useCallback(() => {
    importFetcher.submit(
      {},
      { method: 'POST', action: '/api/integrations/klaviyo/import' }
    );
  }, [importFetcher]);

  // Not connected
  if (status === 'not_connected' || status === 'needs_reconnect') {
    return (
      <BlockStack gap="400">
        <Text as="p">{t.customers.klaviyoDetail.benefitText}</Text>

        {oauthError && (
          <Banner tone="warning" onDismiss={() => setOauthError(null)}>
            {t.customers.klaviyoDetail.oauthErrors[oauthError as keyof typeof t.customers.klaviyoDetail.oauthErrors] ?? t.customers.klaviyoDetail.oauthErrors.unknown}
          </Banner>
        )}

        {popupBlocked && (
          <Banner tone="warning">
            {t.customers.klaviyoDetail.popupBlocked}{' '}
            {oauthFetcher.data?.url && (
              <a href={oauthFetcher.data.url} target="_blank" rel="noopener noreferrer">
                {t.customers.klaviyoDetail.openInNewTab}
              </a>
            )}
          </Banner>
        )}

        <Button
          variant="primary"
          onClick={handleConnect}
          loading={oauthFetcher.state === 'loading' || connectFetcher.state === 'submitting'}
        >
          {status === 'needs_reconnect'
            ? t.customers.integrations.reconnect
            : t.customers.klaviyoDetail.connect}
        </Button>
      </BlockStack>
    );
  }

  // Connected
  const selectedProp = properties.find((p) => p.key === selectedProperty);
  const previews = selectedProp ? previewLines(selectedProp.samples, dateFormat) : [];
  const canSave = canSaveMapping({
    sourceKey: selectedProperty,
    ambiguous: selectedProp?.ambiguous ?? false,
    dateFormat,
  });

  return (
    <BlockStack gap="400">
      <Text as="p" tone="subdued">
        {t.customers.klaviyoDetail.accountLabel}: {accountName}
      </Text>

      <InlineStack align="end">
        <Button
          variant="plain"
          tone="critical"
          onClick={handleDisconnect}
          loading={disconnectFetcher.state === 'submitting'}
        >
          {t.customers.klaviyoDetail.disconnect}
        </Button>
      </InlineStack>

      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          {t.customers.klaviyoDetail.fieldMappingTitle}
        </Text>

        <Select
          label={t.customers.klaviyoDetail.klaviyoPropertyLabel}
          options={[
            { label: t.customers.klaviyoDetail.selectProperty, value: '' },
            ...properties.map((p) => ({ label: p.key, value: p.key })),
          ]}
          value={selectedProperty}
          onChange={setSelectedProperty}
        />

        <Select
          label={t.customers.klaviyoDetail.kerdonFieldLabel}
          options={[{ label: t.customers.klaviyoDetail.birthdate, value: 'birthdate' }]}
          value="birthdate"
          disabled
        />

        {selectedProp && selectedProp.ambiguous && (
          <Select
            label={t.customers.klaviyoDetail.dateFormatLabel}
            options={[
              { label: 'DD/MM/YYYY', value: 'DMY' },
              { label: 'MM/DD/YYYY', value: 'MDY' },
            ]}
            value={dateFormat}
            onChange={(value) => setDateFormat(value as DateFormat)}
          />
        )}

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

        <InlineStack gap="200">
          <Button
            variant="primary"
            onClick={handleSaveMapping}
            loading={saveMappingFetcher.state === 'submitting'}
            disabled={!canSave}
          >
            {t.customers.klaviyoDetail.save}
          </Button>

          <Button
            onClick={handleImport}
            loading={importFetcher.state === 'submitting'}
            disabled={!mapping}
          >
            {t.customers.integrations.importData}
          </Button>
        </InlineStack>

        {importFetcher.data?.queued === false && importFetcher.data.reason && (
          <Banner tone="warning">
            {t.customers.integrations.importReasons[
              importFetcher.data.reason as keyof typeof t.customers.integrations.importReasons
            ] ?? importFetcher.data.reason}
          </Banner>
        )}
      </BlockStack>
    </BlockStack>
  );
}
