// app/components/Customers/IntegrationsCard.tsx
//
// La card «Integrazioni» nella tab Clienti: mostra le integrazioni disponibili
// (oggi solo Klaviyo), il loro stato di connessione, l'ultimo import e i conflitti
// da risolvere.

import { useSearchParams } from '@remix-run/react';
import type { ReactNode } from 'react';
import { useIntegrationImport } from './useIntegrationImport';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Link,
  Scrollable,
  Text,
  Thumbnail,
} from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import { useLocale } from '~/lib/i18n/context';
import { PlanUpgradeAction } from '~/components/Dashboard/PlanUpgradeAction';

/**
 * Altezza massima dello Scrollable per evitare che la card cresca oltre lo
 * schermo con molte integrazioni. ExtraFieldsCard non ha altezza fissa.
 */
const SCROLLABLE_MAX_HEIGHT = '200px';

export interface IntegrationStatus {
  provider: 'klaviyo';
  status: 'connected' | 'not_connected' | 'needs_reconnect';
  accountName?: string | null;
  mapping: { sourceKey: string; dateFormat: string } | null;
  lastRun: {
    status: 'completed' | 'interrupted';
    finishedAt: string | null;
    counters: { filled?: number; conflicts?: number; [key: string]: unknown };
  } | null;
  openConflicts: number;
}

export interface IntegrationsCardProps {
  /** Le integrazioni disponibili e il loro stato. */
  integrations: IntegrationStatus[] | null;
  /** Se il piano non include la sincronizzazione clienti, nome del piano da proporre. */
  upgradePlan: string | null;
  /** Callback per aprire il modal di gestione (Task 11). */
  onManage?: (provider: 'klaviyo') => void;
}

/**
 * Costruisce l'URL per il link ai conflitti, preservando i parametri esistenti
 * e impostando view=conflicts.
 *
 * @param currentSearch La query string corrente (da useSearchParams o location.search)
 * @returns L'URL relativo con view=conflicts e gli altri parametri preservati
 */
export function buildConflictsUrl(currentSearch: string): string {
  const params = new URLSearchParams(currentSearch);
  params.set('view', 'conflicts');
  return `?${params.toString()}`;
}

interface RowState {
  badge: 'success' | 'attention' | 'warning';
  tone: string;
  showImport: boolean;
}

/**
 * Funzione pura che decide lo stato visivo di una riga integrazione.
 *
 * @param status Stato della connessione
 * @param lastRun Ultimo import (se esiste)
 * @returns Lo stato visivo: badge, tone (label del badge), showImport
 */
export function integrationRowState(
  status: 'connected' | 'not_connected' | 'needs_reconnect',
  lastRun: { status: string; finishedAt: string | null; counters: unknown } | null,
): RowState {
  if (status === 'not_connected') {
    return { badge: 'attention', tone: 'Da collegare', showImport: false };
  }
  if (status === 'needs_reconnect') {
    return { badge: 'warning', tone: 'Riconnetti', showImport: false };
  }
  // connected: sempre success, showImport true
  return { badge: 'success', tone: 'Collegata', showImport: true };
}

export function IntegrationsCard({
  integrations,
  upgradePlan,
  onManage,
}: IntegrationsCardProps) {
  const t = useT();
  const locale = useLocale();

  // Piano senza clienti: stesso invito all'upgrade della pagina Clienti
  if (integrations === null && upgradePlan) {
    return (
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            {t.customers.integrations.title}
          </Text>
          <Banner tone="info">
            <Text as="p">
              <PlanUpgradeAction plan={upgradePlan} />
              {t.customers.planRequired}
            </Text>
          </Banner>
        </BlockStack>
      </Card>
    );
  }

  // Nessuna integrazione collegata o disponibile
  if (!integrations || integrations.length === 0) {
    return (
      <Card>
        <BlockStack gap="300">
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <Text as="h2" variant="headingMd">
              {t.customers.integrations.title}
            </Text>
            <Button onClick={() => onManage?.('klaviyo')} variant="plain">
              {t.customers.integrations.manage}
            </Button>
          </InlineStack>
          <Text as="p" tone="subdued">
            {t.customers.integrations.noIntegrations}
          </Text>
        </BlockStack>
      </Card>
    );
  }

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Text as="h2" variant="headingMd">
            {t.customers.integrations.title}
          </Text>
          <Button onClick={() => onManage?.('klaviyo')} variant="plain">
            {t.customers.integrations.manage}
          </Button>
        </InlineStack>
        <Scrollable style={{ maxHeight: SCROLLABLE_MAX_HEIGHT }} focusable>
          <BlockStack gap="300">
            {integrations.map((integration) => (
              <IntegrationRow
                key={integration.provider}
                integration={integration}
                onManage={onManage}
                locale={locale}
              />
            ))}
          </BlockStack>
        </Scrollable>
      </BlockStack>
    </Card>
  );
}

interface IntegrationRowProps {
  integration: IntegrationStatus;
  onManage?: (provider: 'klaviyo') => void;
  locale: string;
}

function IntegrationRow({ integration, onManage, locale }: IntegrationRowProps) {
  const t = useT();
  const [searchParams] = useSearchParams();
  const { provider, status, lastRun, openConflicts } = integration;

  // I8 FIX: Use shared import hook
  const { importFetcher, handleImport, importReason } = useIntegrationImport(provider);

  const rowState = integrationRowState(status, lastRun);
  const isImporting = importFetcher.state !== 'idle';
  const conflictsUrl = buildConflictsUrl(searchParams.toString());

  // needs_reconnect: banner warning
  const showReconnectBanner = status === 'needs_reconnect';

  return (
    <BlockStack gap="200">
      <InlineStack gap="300" blockAlign="center" wrap={false}>
        <Thumbnail
          source={`/integrations/${provider}.webp`}
          alt={provider}
          size="small"
        />
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {provider.charAt(0).toUpperCase() + provider.slice(1)}
            </Text>
            <Badge tone={rowState.badge}>{rowState.tone}</Badge>
          </InlineStack>
        </BlockStack>
      </InlineStack>

      {showReconnectBanner && (
        <Banner tone="warning">
          <InlineStack gap="200" blockAlign="center">
            <Text as="span">
              {t.customers.integrations.importReasons.not_connected}
            </Text>
            <Button onClick={() => onManage?.(provider)} variant="plain">
              {t.customers.integrations.reconnect}
            </Button>
          </InlineStack>
        </Banner>
      )}

      {rowState.showImport && lastRun && (
        <BlockStack gap="100">
          <Text as="p" variant="bodySm" tone="subdued">
            {t.customers.integrations.lastImport(
              formatDate(lastRun.finishedAt, locale),
              (lastRun.counters.filled as number) ?? 0,
            )}
          </Text>
          {openConflicts > 0 && (
            <Link url={conflictsUrl}>
              {t.customers.integrations.conflicts(openConflicts)}
            </Link>
          )}
          <InlineStack gap="200" blockAlign="center">
            <Button
              onClick={handleImport}
              loading={isImporting}
              disabled={isImporting}
              size="slim"
            >
              {t.customers.integrations.importData}
            </Button>
          </InlineStack>
        </BlockStack>
      )}

      {importReason && (
        <Banner tone="warning">
          {t.customers.integrations.importReasons[
            importReason as keyof typeof t.customers.integrations.importReasons
          ] ?? importReason}
        </Banner>
      )}
    </BlockStack>
  );
}

function formatDate(dateStr: string | null, locale: string): string {
  if (!dateStr) return '—';
  try {
    const date = new Date(dateStr);
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return '—';
  }
}
