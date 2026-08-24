import { Badge, BlockStack, Card, InlineStack, Text } from '@shopify/polaris';
import { freshness } from './coverage';
import { formatCountdown } from '~/lib/sync/next-sync';
import { formatSyncDate } from './sync-format';
import { useLocale, useT } from '~/lib/i18n/context';

export interface FreshnessCardProps {
  lastSync: string | null;
  nextSync: string | null;
  frequencyHours: number | null;
  /** Fuso del negozio: le date si scrivono nel suo, non in quello del browser. */
  timeZone: string | null;
  loading?: boolean;
}

/**
 * Se quel che si sta guardando e' di oggi.
 *
 * Prima c'erano tre date — frequenza, ultima, prossima — e toccava al merchant
 * ricavarne il giudizio. Il giudizio e' l'unica cosa che gli serve: le date
 * restano sotto, per chi vuole verificare.
 */
export function FreshnessCard({
  lastSync,
  nextSync,
  frequencyHours,
  timeZone,
  loading,
}: FreshnessCardProps) {
  const t = useT();
  const locale = useLocale();
  const state = freshness({ lastSync, frequencyHours });
  const lastSyncLabel = lastSync ? formatSyncDate(lastSync, timeZone, locale) : null;
  // Il conto alla rovescia si calcola al render: fatto nel loader invecchierebbe
  // con la pagina aperta.
  const nextSyncCountdown = nextSync
    ? formatCountdown(new Date(), new Date(nextSync), t)
    : null;

  const label =
    state === 'fresh'
      ? t.dashboard.freshness.fresh
      : state === 'stale'
        ? t.dashboard.freshness.stale
        : t.dashboard.freshness.never;

  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="headingMd">
          {t.dashboard.freshness.title}
        </Text>

        <InlineStack>
          <Badge tone={state === 'fresh' ? 'success' : state === 'stale' ? 'warning' : undefined}>
            {loading ? '—' : label}
          </Badge>
        </InlineStack>

        {/* Le date sotto il giudizio, non al posto suo. */}
        {state === 'never' ? (
          <Text as="p" tone="subdued">
            {t.dashboard.freshness.noSyncYet}
          </Text>
        ) : (
          <BlockStack gap="050">
            {lastSyncLabel && (
              <Text as="p" tone="subdued">
                {t.dashboard.freshness.lastSync(lastSyncLabel)}
              </Text>
            )}
            {nextSyncCountdown && (
              <Text as="p" tone="subdued" variant="bodySm">
                {t.dashboard.freshness.nextSync(nextSyncCountdown)}
              </Text>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
