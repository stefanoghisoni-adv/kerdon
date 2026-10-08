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
  /** Un import e' in corso adesso. */
  running?: boolean;
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

type StatusLabel = 'statusConnected' | 'statusNotConnected' | 'statusNeedsReconnect';

interface RowState {
  badge: 'success' | 'attention' | 'warning';
  /** La chiave della traduzione dell'etichetta del badge. */
  label: StatusLabel;
  showImport: boolean;
}

/**
 * Funzione pura che decide lo stato visivo di una riga integrazione.
 *
 * «Importa dati» c'e' appena l'integrazione e' collegata e ha un campo
 * associato: il primo import parte anche da qui, non solo dal modal.
 */
export function integrationRowState(
  status: 'connected' | 'not_connected' | 'needs_reconnect',
  mapping: { sourceKey: string; dateFormat: string } | null,
): RowState {
  if (status === 'not_connected') {
    return { badge: 'attention', label: 'statusNotConnected', showImport: false };
  }
  if (status === 'needs_reconnect') {
    return { badge: 'warning', label: 'statusNeedsReconnect', showImport: false };
  }
  return { badge: 'success', label: 'statusConnected', showImport: mapping !== null };
}

/** Il titolo della card con «Gestisci» a destra. */
function CardHeader({ onManage }: { onManage?: (provider: 'klaviyo') => void }) {
  const t = useT();
  return (
    <InlineStack align="space-between" blockAlign="center" wrap={false}>
      <Text as="h2" variant="headingMd">
        {t.customers.integrations.title}
      </Text>
      <Button onClick={() => onManage?.('klaviyo')} variant="plain">
        {t.customers.integrations.manage}
      </Button>
    </InlineStack>
  );
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
          <CardHeader onManage={onManage} />
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
        <CardHeader onManage={onManage} />
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
  const { provider, status, mapping, lastRun, openConflicts } = integration;

  // I8 FIX: Use shared import hook
  const { importFetcher, handleImport, importReason } = useIntegrationImport(provider);

  const rowState = integrationRowState(status, mapping);
  const running = integration.running === true;
  const isImporting = importFetcher.state !== 'idle' || running;
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
            <Badge tone={rowState.badge}>{t.customers.integrations[rowState.label]}</Badge>
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

      {(lastRun || openConflicts > 0 || rowState.showImport) && (
        <BlockStack gap="100">
          {lastRun && (
            <Text as="p" variant="bodySm" tone="subdued">
              {t.customers.integrations.lastImport(
                formatDate(lastRun.finishedAt, locale),
                (lastRun.counters.filled as number) ?? 0,
              )}
            </Text>
          )}
          {openConflicts > 0 && (
            <Link url={conflictsUrl}>
              {t.customers.integrations.conflicts(openConflicts)}
            </Link>
          )}
          {rowState.showImport && (
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
          )}
          {running && (
            <Text as="p" variant="bodySm" tone="subdued">
              {t.customers.integrations.importRunning}
            </Text>
          )}
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
