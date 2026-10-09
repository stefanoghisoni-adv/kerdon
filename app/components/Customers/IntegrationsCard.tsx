// app/components/Customers/IntegrationsCard.tsx
//
// La card «Integrazioni» nella tab Clienti: mostra le integrazioni disponibili
// come riquadri cliccabili, con logo e stato visivo (installata, da collegare,
// richiede attenzione, non disponibile). Al clic il riquadro mostra lo spinner
// finche' i dati della modal non sono pronti, e gli altri restano fermi.

import {
  Banner,
  BlockStack,
  Box,
  Card,
  Icon,
  Image,
  InlineStack,
  Spinner,
  Text,
  UnstyledButton,
} from '@shopify/polaris';
import { AppsIcon } from '@shopify/polaris-icons';
import { useT } from '~/lib/i18n/context';
import { PlanUpgradeAction } from '~/components/Dashboard/PlanUpgradeAction';
import { INTEGRATIONS, type IntegrationEntry, type IntegrationId } from '~/lib/integrations/registry';

/** Lato del logo nel riquadro, in pixel. */
const LOGO_SIZE = 40;

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
  /** Il riquadro di cui si stanno caricando i dati (null = nessuno). */
  pendingProvider?: IntegrationId | null;
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

export interface TileVisualState {
  /** Il riquadro risponde al clic adesso. */
  clickable: boolean;
  /** Il riquadro sta caricando i dati della sua modal (spinner). */
  loading: boolean;
  /** Fermo solo finche' un altro riquadro carica. */
  disabledTemporarily: boolean;
}

/**
 * Funzione pura: lo stato visivo di un riquadro durante il caricamento al clic.
 *
 * - Non disponibile: mai cliccabile, aspetto suo (grigio), non «temporaneo».
 * - Il riquadro che carica: spinner, non cliccabile.
 * - Gli altri riquadri attivi mentre uno carica: fermi per il momento.
 * - Nessun caricamento: cliccabile.
 */
export function tileVisualState(
  state: Pick<TileState, 'clickable'>,
  pendingProvider: IntegrationId | null | undefined,
  provider: IntegrationId,
): TileVisualState {
  if (!state.clickable) {
    return { clickable: false, loading: false, disabledTemporarily: false };
  }
  if (pendingProvider === provider) {
    return { clickable: false, loading: true, disabledTemporarily: false };
  }
  if (pendingProvider) {
    return { clickable: false, loading: false, disabledTemporarily: true };
  }
  return { clickable: true, loading: false, disabledTemporarily: false };
}

export function IntegrationsCard({
  integrations,
  upgradePlan,
  onManage,
  pendingProvider = null,
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

  // Niente Scrollable: con pochi riquadri non serve, e tagliava il bordo
  // dell'ultimo in fondo.
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {t.customers.integrations.title}
        </Text>
        <BlockStack gap="300">
          {INTEGRATIONS.map((entry) => {
            const integration = integrationsByProvider.get(entry.id);
            const state = tileState(entry, integration);
            const visual = tileVisualState(state, pendingProvider, entry.id);

            return (
              <IntegrationTile
                key={entry.id}
                entry={entry}
                state={state}
                visual={visual}
                onManage={onManage}
              />
            );
          })}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

interface IntegrationTileProps {
  entry: IntegrationEntry;
  state: TileState;
  visual: TileVisualState;
  onManage?: (provider: IntegrationId) => void;
}

function IntegrationTile({ entry, state, visual, onManage }: IntegrationTileProps) {
  const t = useT();
  const notAvailable = !state.clickable;

  // Logo senza cornice; segnaposto per le voci senza logo
  const logo = entry.logo ? (
    <Image
      source={entry.logo}
      alt=""
      width={LOGO_SIZE}
      height={LOGO_SIZE}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  ) : (
    <Box minWidth={`${LOGO_SIZE}px`}>
      <Icon source={AppsIcon} tone="subdued" />
    </Box>
  );

  // Il riquadro: bordo sottile, angoli arrotondati, niente ombra. Lo sfondo
  // lo da' il pulsante (per hover e pressione) o, se non cliccabile, il Box.
  const tileContent = (
    <Box
      background={notAvailable ? 'bg-surface' : undefined}
      borderColor="border"
      borderWidth="025"
      borderStyle="solid"
      borderRadius="300"
      paddingBlockStart="200"
      paddingBlockEnd="200"
      paddingInlineStart="200"
      paddingInlineEnd="100"
    >
      <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
        <InlineStack gap="400" blockAlign="center" wrap={false}>
          {notAvailable ? <span className="integration-logo-disabled">{logo}</span> : logo}
          <BlockStack gap="100">
            <Text
              as="span"
              variant="headingMd"
              fontWeight="bold"
              tone={notAvailable ? 'disabled' : undefined}
            >
              {entry.name}
            </Text>
            <Text as="span" tone={state.tone}>
              {t.customers.integrations[state.label]}
            </Text>
          </BlockStack>
        </InlineStack>
        {/* Lo spinner va centrato in altezza e a 20px dal bordo destro: il
            riquadro ne da' 4 di padding, gli altri 16 li aggiunge la classe. */}
        {visual.loading && (
          <span className="integration-tile-spinner">
            <Spinner size="small" />
          </span>
        )}
      </InlineStack>
    </Box>
  );

  // Voce non disponibile: solo il riquadro, nessun pulsante
  if (notAvailable) {
    return tileContent;
  }

  // Voce cliccabile: pulsante senza stile Polaris, l'aspetto lo da' la
  // classe `integration-tile`. `disabled` di UnstyledButton mette
  // aria-disabled, toglie il focus e blocca il clic; `loading` mette aria-busy.
  return (
    <UnstyledButton
      className="integration-tile"
      onClick={() => onManage?.(entry.id)}
      disabled={!visual.clickable}
      loading={visual.loading}
      accessibilityLabel={`${entry.name} - ${t.customers.integrations[state.label]}`}
    >
      {tileContent}
    </UnstyledButton>
  );
}
