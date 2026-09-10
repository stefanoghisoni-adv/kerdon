import { useEffect } from 'react';
import { useFetcher } from '@remix-run/react';
import { Banner, BlockStack, Text } from '@shopify/polaris';
import { hasPausedRows, readScopeStatus } from './scope-status';
import { formatDateTime } from './sync-log-format';
import { useT, useLocale } from '~/lib/i18n/context';

export interface ProductScopeBannerProps {
  /** Il fuso del negozio: la data dei dati fermi si legge nel suo, non nel nostro. */
  timeZone: string | null;
}

/**
 * Avviso per chi ha dei prodotti fermi.
 *
 * DISTINTO DALL'AVVISO DEL TETTO RAGGIUNTO, e la differenza conta. Quello parla
 * di prodotti che non entrano; questo di prodotti che sono gia' entrati e hanno
 * smesso di aggiornarsi. Il primo e' una cosa che non e' successa, il secondo e'
 * un dato che il merchant sta guardando adesso credendolo di oggi.
 *
 * Per questo porta sempre una data: "50 prodotti fermi" senza un "da quando"
 * lascia intendere che siano fermi da poco, e il caso in cui questo avviso
 * serve davvero e' esattamente l'altro.
 *
 * Non si chiude: il tetto resta quello finche' non si cambia piano, e un avviso
 * che dice che dei numeri sono vecchi non deve poter sparire lasciando i numeri
 * dove sono.
 */
export function ProductScopeBanner({ timeZone }: ProductScopeBannerProps) {
  const t = useT();
  const locale = useLocale();

  // I dati se li procura il componente, invece di riceverli: le pagine che lo
  // mostrano non devono caricarseli ognuna nel proprio loader, e soprattutto
  // non possono finire a mostrare numeri diversi per la stessa cosa.
  const scope = useFetcher<{
    active?: number;
    paused?: number;
    pausedDataFrom?: string | null;
  }>();

  useEffect(() => {
    if (scope.state === 'idle' && !scope.data) scope.load('/api/product-scope');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!scope.data) return null;

  const status = readScopeStatus(scope.data);
  if (!hasPausedRows(status)) return null;

  return (
    <Banner tone="warning" title={t.productScope.title}>
      <BlockStack gap="200">
        <Text as="p">{t.productScope.counts(status.active, status.paused)}</Text>
        <Text as="p">
          {status.pausedDataFrom
            ? t.productScope.since(formatDateTime(status.pausedDataFrom, timeZone, locale))
            : t.productScope.sinceUnknown}
        </Text>
        <Text as="p">{t.productScope.kept}</Text>
      </BlockStack>
    </Banner>
  );
}
