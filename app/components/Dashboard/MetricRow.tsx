import type { ReactNode } from 'react';
import { InlineStack, Badge, Text, Icon, Tooltip } from '@shopify/polaris';
import { InfoIcon } from '@shopify/polaris-icons';

export interface MetricRowProps {
  /**
   * Di solito una stringa. Accetta anche un nodo perche' una riga sola — il
   * matching avanzato — porta il proprio colore, e passare una classe da fuori
   * era l'alternativa: una prop di stile su un componente che di stile non
   * parla.
   */
  label: ReactNode;
  /**
   * Omesso quando l'azione dice gia' tutto (es. "Aggiorna a Scale" al posto
   * di "Non attiva"): la riga resta a due colonne invece di ripetere lo stesso
   * concetto due volte.
   */
  badge?: { tone?: 'success' | 'warning'; content: string };
  info?: string;
  action?: ReactNode;
}

// Riga singola delle card della dashboard: etichetta (con eventuale info),
// azione opzionale, badge. Estratta perche' si ripete identica nelle tre card e
// tiene i badge allineati sulla stessa colonna.
export function MetricRow({ label, badge, info, action }: MetricRowProps) {
  return (
    <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
      <InlineStack gap="100" blockAlign="center" wrap={false}>
        <Text as="span" variant="bodyMd">
          {label}
        </Text>
        {info ? (
          <Tooltip content={info}>
            <span className="info-icon">
              <Icon source={InfoIcon} tone="subdued" />
            </span>
          </Tooltip>
        ) : null}
      </InlineStack>
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        {action}
        {badge ? <Badge tone={badge.tone}>{badge.content}</Badge> : null}
      </InlineStack>
    </InlineStack>
  );
}
