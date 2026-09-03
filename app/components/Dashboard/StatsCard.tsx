import {
  Card,
  Text,
  BlockStack,
  InlineStack,
  Icon,
  Tooltip,
  SkeletonBodyText,
} from '@shopify/polaris';
import { InfoIcon } from '@shopify/polaris-icons';

type StatsStatus = 'success' | 'warning' | 'critical';

interface StatsCardProps {
  title: string;
  value: string | number;
  icon?: React.ReactNode;
  status?: StatsStatus;
  loading?: boolean;
  // Se presente, viene mostrato al posto del valore numerico (es. un pulsante
  // "Aggiorna piano" nella card Clienti quando il piano non include i clienti).
  action?: React.ReactNode;
  // Testo mostrato in un tooltip accanto al titolo tramite un'icona "i".
  info?: string;
  // Contenuto opzionale sotto il valore (es. un pulsante "Vedi dettagli").
  footer?: React.ReactNode;
}

// Polaris <Text> uses "caution" rather than "warning" for its tone scale.
const TONE_BY_STATUS: Record<StatsStatus, 'success' | 'caution' | 'critical'> = {
  success: 'success',
  warning: 'caution',
  critical: 'critical',
};

export function StatsCard({
  title,
  value,
  icon,
  status,
  loading,
  action,
  info,
  footer,
}: StatsCardProps) {
  return (
    <Card>
      <BlockStack gap="200">
        {icon}
        <InlineStack gap="100" blockAlign="center">
          <Text as="h2" variant="headingMd">
            {title}
          </Text>
          {info && (
            <Tooltip content={info}>
              {/* span necessario: il Tooltip ha bisogno di un elemento focusabile/hoverabile */}
              <span style={{ display: 'inline-flex', cursor: 'help' }} tabIndex={0}>
                <span className="info-icon">
              <Icon source={InfoIcon} tone="subdued" />
            </span>
              </span>
            </Tooltip>
          )}
        </InlineStack>
        {action ? (
          action
        ) : loading ? (
          <SkeletonBodyText lines={1} />
        ) : (
          <Text
            as="p"
            variant="heading2xl"
            tone={status ? TONE_BY_STATUS[status] : undefined}
          >
            {String(value)}
          </Text>
        )}
        {footer}
      </BlockStack>
    </Card>
  );
}
