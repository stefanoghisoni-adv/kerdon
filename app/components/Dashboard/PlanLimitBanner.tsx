import { Banner, Button, Text } from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';

export interface PlanLimitBannerProps {
  /** Il piano Supabase, quando lo conosciamo. */
  planLabel: string | null;
  /** Dove si cambia piano. null quando non lo sappiamo. */
  billingUrl: string | null;
  onDismiss?: () => void;
}

/**
 * Il limite di database del piano Supabase.
 *
 * Sta in un file suo perche' lo stesso avviso serve in due posti che non si
 * contengono: dentro la scelta del database (dashboard) e in cima a
 * Impostazioni, dove il menu che lo fa comparire vive dentro una card e il
 * banner deve invece stare sopra tutte.
 */
export function PlanLimitBanner({ planLabel, billingUrl, onDismiss }: PlanLimitBannerProps) {
  const t = useT();

  return (
    <Banner tone="warning" onDismiss={onDismiss}>
      <Text as="p">
        {/* Il piano lo conosciamo solo se la OAuth App concede lo scope
            organizations:read. Quando il limite emerge dal rifiuto di Supabase
            alla creazione non lo sappiamo: in quel caso si dice cosa e'
            successo senza inventare un nome di piano. */}
        {planLabel
          ? t.connect.database.limitKnown(planLabel)
          : t.connect.database.limitUnknown}{' '}
        {/* Button e non Link: dentro un Banner, Polaris spegne i Link rendendoli
            monocromatici (leggono BannerContext e non hanno una prop per
            chiedere il contrario). Il Button variant="plain" resta blu, ed e' lo
            stesso comando gia' usato altrove nell'app. */}
        {billingUrl ? (
          <Button variant="plain" url={billingUrl} target="_blank">
            {t.connect.database.limitUpgradeLink}
          </Button>
        ) : (
          t.connect.database.limitUpgradePlain
        )}
        {t.connect.database.limitAfter}
      </Text>
    </Banner>
  );
}
