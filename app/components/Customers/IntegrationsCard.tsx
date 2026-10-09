// app/components/Customers/IntegrationsCard.tsx
//
// La card «Integrazioni» nella tab Clienti: mostra le integrazioni disponibili
// come riquadri cliccabili, con logo e stato visivo (installata, da collegare,
// richiede attenzione, non disponibile).

import type { ReactNode } from 'react';
import {
  Banner,
  BlockStack,
  Box,
  Card,
  InlineStack,
  Scrollable,
  Text,
  Thumbnail,
  UnstyledButton,
} from '@shopify/polaris';
import { AppsIcon } from '@shopify/polaris-icons';
import { useT } from '~/lib/i18n/context';
import { PlanUpgradeAction } from '~/components/Dashboard/PlanUpgradeAction';
import { INTEGRATIONS, type IntegrationEntry, type IntegrationId } from '~/lib/integrations/registry';

/**
 * Altezza massima dello Scrollable per evitare che la card cresca oltre lo
 * schermo con molte integrazioni. Alzata rispetto a prima (200px) per far
 * stare 2 riquadri interi senza scroll.
 */
const SCROLLABLE_MAX_HEIGHT = '400px';

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
  onManage?: (provider: IntegrationId) => void;
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

type TileStateKey = 'tileInstalled' | 'tileNotConnected' | 'tileNeedsAttention' | 'tileNotAvailable';

interface TileState {
  /** La chiave della traduzione dell'etichetta dello stato. */
  label: TileStateKey;
  /** Il tono del testo dello stato. */
  tone: 'success' | 'subdued' | 'caution' | 'disabled';
  /** Se il riquadro e' cliccabile. */
  clickable: boolean;
}

/**
 * Funzione pura che decide lo stato visivo di un riquadro integrazione.
 *
 * - Non disponibile: coming_soon, non cliccabile, tutto grigio.
 * - Da collegare: disponibile ma non collegata, cliccabile.
 * - Installata: collegata senza problemi (no needs_reconnect, no conflitti aperti).
 * - Richiede attenzione: needs_reconnect OPPURE collegata con conflitti aperti.
 */
export function tileState(
  entry: IntegrationEntry,
  integration?: IntegrationStatus,
): TileState {
  // Voce non disponibile (coming_soon)
  if (entry.status === 'coming_soon') {
    return { label: 'tileNotAvailable', tone: 'disabled', clickable: false };
  }

  // Voce disponibile senza stato dal loader → da collegare
  if (!integration || integration.status === 'not_connected') {
    return { label: 'tileNotConnected', tone: 'subdued', clickable: true };
  }

  // Needs reconnect → richiede attenzione
  if (integration.status === 'needs_reconnect') {
    return { label: 'tileNeedsAttention', tone: 'caution', clickable: true };
  }

  // Collegata con conflitti aperti → richiede attenzione
  if (integration.openConflicts > 0) {
    return { label: 'tileNeedsAttention', tone: 'caution', clickable: true };
  }

  // Collegata senza problemi → installata
  return { label: 'tileInstalled', tone: 'success', clickable: true };
}

export function IntegrationsCard({
  integrations,
  upgradePlan,
  onManage,
}: IntegrationsCardProps) {
  const t = useT();

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

  // Mappa le integrazioni disponibili dal loader per provider
  const integrationsByProvider = new Map<string, IntegrationStatus>();
  if (integrations) {
    for (const integration of integrations) {
      integrationsByProvider.set(integration.provider, integration);
    }
  }

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {t.customers.integrations.title}
        </Text>
        <Scrollable style={{ maxHeight: SCROLLABLE_MAX_HEIGHT }} focusable>
          <BlockStack gap="300">
            {INTEGRATIONS.map((entry) => {
              const integration = integrationsByProvider.get(entry.id);
              const state = tileState(entry, integration);

              return (
                <IntegrationTile
                  key={entry.id}
                  entry={entry}
                  state={state}
                  onManage={onManage}
                />
              );
            })}
          </BlockStack>
        </Scrollable>
      </BlockStack>
    </Card>
  );
}

interface IntegrationTileProps {
  entry: IntegrationEntry;
  state: TileState;
  onManage?: (provider: IntegrationId) => void;
}

function IntegrationTile({ entry, state, onManage }: IntegrationTileProps) {
  const t = useT();

  // Logo: per le voci non disponibili, avvolto in un elemento con classe CSS
  const logo = entry.logo ? (
    <Thumbnail
      source={entry.logo}
      alt={entry.name}
      size="medium"
      transparent
    />
  ) : (
    // Segnaposto per le voci senza logo (es. Omnisend)
    <Thumbnail
      source={AppsIcon}
      alt={entry.name}
      size="medium"
      transparent
    />
  );

  const logoElement = state.clickable ? (
    logo
  ) : (
    <span className="integration-logo-disabled">{logo}</span>
  );

  const tileContent = (
    <Box
      background="bg-surface"
      borderRadius="300"
      shadow="200"
      padding="400"
    >
      <InlineStack gap="300" blockAlign="center" wrap={false}>
        {logoElement}
        <BlockStack gap="100">
          <Text
            as="span"
            variant="headingMd"
            fontWeight="bold"
            tone={state.tone === 'disabled' ? 'disabled' : undefined}
          >
            {entry.name}
          </Text>
          <Text as="span" tone={state.tone}>
            {t.customers.integrations[state.label]}
          </Text>
        </BlockStack>
      </InlineStack>
    </Box>
  );

  // Voce non disponibile: Box senza UnstyledButton
  if (!state.clickable) {
    return tileContent;
  }

  // Voce cliccabile: UnstyledButton con aria-label accessibile
  return (
    <UnstyledButton
      onClick={() => onManage?.(entry.id)}
      ariaLabel={`${entry.name} - ${t.customers.integrations[state.label]}`}
    >
      {tileContent}
    </UnstyledButton>
  );
}
