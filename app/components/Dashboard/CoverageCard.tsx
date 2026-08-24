import { Button, InlineStack, Text } from '@shopify/polaris';
import { coverage, coverageTone } from './coverage';
import { StatCard } from './StatCard';
import { useT } from '~/lib/i18n/context';

export interface CoverageCardProps {
  label: string;
  hint?: string;
  /** Quanti sono pronti, e su quanti in tutto. */
  ready: number;
  total: number;
  /** La riga sotto il numero: "13 di 26 pronti". */
  detail: (ready: number, total: number) => string;
  /** C'e' qualcosa da sistemare: accende il comando accanto al dettaglio. */
  issue?: boolean;
  action?: { label: string; url: string; onAction?: () => void; loading?: boolean };
  loading?: boolean;
}

/**
 * Quanta parte e' pronta.
 *
 * Il numero e' una percentuale e non un conteggio: "26 prodotti" non dice se il
 * catalogo e' a posto, "50%" si'. I conteggi restano nella riga sotto, che e'
 * dove si guarda quando la percentuale non piace.
 *
 * Il comando sta su quella stessa riga: prima era una riga sua, e diceva quel
 * che il conteggio diceva gia' — "13 di 26 pronti" e "13 da sistemare" sono lo
 * stesso conto scritto due volte.
 */
export function CoverageCard({
  label,
  hint,
  ready,
  total,
  detail,
  issue,
  action,
  loading,
}: CoverageCardProps) {
  const t = useT();
  const value = coverage(ready, total);
  const tone = coverageTone(value);

  return (
    <StatCard
      label={label}
      hint={hint}
      value={loading || value.percent == null ? '—' : `${value.percent}%`}
      tone={tone === 'warning' ? 'caution' : undefined}
      detail={
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Text as="span" variant="bodySm" tone="subdued">
            {loading ? t.dashboard.coverage.none : detail(ready, total)}
          </Text>
          {!loading && issue && action && (
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
      }
    />
  );
}
