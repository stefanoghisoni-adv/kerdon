import { BlockStack, Card, Text } from '@shopify/polaris';
import { MetricRow } from './MetricRow';
import { syncFrequencyLabel } from './account-format';
import { formatCountdown } from '~/lib/sync/next-sync';
import { formatSyncDate } from './sync-format';
import { useT, useLocale } from '~/lib/i18n/context';

export interface SyncCardProps {
  /** Cadenza prevista dal piano, in ore. null = piano senza cadenza nota. */
  frequencyHours: number | null;
  /** Ultima corsa periodica completata (ISO), o null se non ce n'e' ancora una. */
  lastSync: string | null;
  /** Prossima corsa prevista (ISO), o null se non e' prevedibile. */
  nextSync: string | null;
  /** Fuso del negozio: le date si leggono nell'ora del merchant, non del server. */
  timeZone?: string | null;
}

/**
 * Come funziona la sincronizzazione per questo negozio.
 *
 * Di sola lettura, e non per pigrizia: la cadenza la stabilisce il piano, ed e'
 * uno dei suoi contenuti — comprare un piano superiore significa anche essere
 * aggiornati piu' spesso. Un campo modificabile qui darebbe l'idea di poter
 * andare piu' veloci senza cambiare piano, che non e' vero.
 */
export function SyncCard({ frequencyHours, lastSync, nextSync, timeZone }: SyncCardProps) {
  const t = useT();
  const locale = useLocale();
  const countdown = nextSync ? formatCountdown(new Date(), new Date(nextSync), t) : null;

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {t.sync.title}
        </Text>
        <MetricRow
          label={t.sync.frequency}
          badge={{ content: syncFrequencyLabel(frequencyHours, t) }}
        />
        <MetricRow
          label={t.sync.last}
          badge={{
            content: lastSync ? formatSyncDate(lastSync, timeZone, locale) : t.common.never,
          }}
        />
        {/* Il conto alla rovescia e non l'orario: "fra 2 giorni" si capisce a
            colpo d'occhio, mentre una data va confrontata con oggi. Quando non
            e' prevedibile la riga sparisce, invece di mostrare un trattino che
            somiglia a un guasto. */}
        {countdown && (
          <MetricRow label={t.sync.next} badge={{ content: t.sync.inLabel(countdown) }} />
        )}
      </BlockStack>
    </Card>
  );
}
