import { BlockStack, Button, Card, InlineStack, Text } from '@shopify/polaris';
import { coverage, coverageTone } from './coverage';
import { useT } from '~/lib/i18n/context';

export interface CoverageCardProps {
  title: string;
  /** Quanti sono pronti, e su quanti in tutto. */
  ready: number;
  total: number;
  /** La riga sotto il numero grande: "13 di 26 pronti". */
  detail: (ready: number, total: number) => string;
  /** Cosa manca, quando manca qualcosa. */
  issue?: string;
  action?: { label: string; url: string; onAction?: () => void; loading?: boolean };
  /** Riga in fondo, in secondo piano: il consumo del piano, se ha senso. */
  footnote?: string;
  loading?: boolean;
}

/**
 * Quanta parte e' pronta, in una card.
 *
 * Il numero grande e' una percentuale e non un conteggio: "26 prodotti" non
 * dice se il catalogo e' a posto, "50%" si'. I conteggi restano sotto, perche'
 * sono quelli che si vanno a controllare quando la percentuale non piace.
 *
 * Il consumo del piano, quando c'e', sta in fondo e in piccolo: e' un'altra
 * domanda — quanto spazio resta, non quanta parte funziona — e messo alla pari
 * si leggeva come se fosse la stessa.
 */
export function CoverageCard({
  title,
  ready,
  total,
  detail,
  issue,
  action,
  footnote,
  loading,
}: CoverageCardProps) {
  const t = useT();
  const value = coverage(ready, total);
  const tone = coverageTone(value);

  return (
    <Card>
      <BlockStack gap="200">
        <Text as="h2" variant="headingMd">
          {title}
        </Text>

        <Text as="p" variant="heading2xl" tone={tone === 'warning' ? 'caution' : undefined}>
          {loading || value.percent == null ? '—' : `${value.percent}%`}
        </Text>

        <Text as="p" tone="subdued">
          {loading ? t.dashboard.coverage.none : detail(ready, total)}
        </Text>

        {/* Cosa manca e come rimediare, nella stessa riga: separati, il numero
            di problemi diventava una notizia senza seguito. */}
        {!loading && issue && (
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <Text as="span" tone="caution" variant="bodySm">
              {issue}
            </Text>
            {action && (
              <Button
                variant="plain"
                url={action.url}
                onClick={action.onAction}
                loading={action.loading}
                disabled={action.loading}
              >
                {action.label}
              </Button>
            )}
          </InlineStack>
        )}

        {footnote && (
          <Text as="p" tone="subdued" variant="bodySm">
            {footnote}
          </Text>
        )}
      </BlockStack>
    </Card>
  );
}
