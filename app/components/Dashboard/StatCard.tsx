import type { ReactNode } from 'react';
import { BlockStack, Card, InlineStack, Text, Tooltip } from '@shopify/polaris';

export interface StatCardProps {
  label: string;
  /** Cosa significa quel numero: compare al passaggio del puntatore. */
  hint?: string;
  value: string;
  /** Tono del valore: acceso solo quando il numero chiede attenzione. */
  tone?: 'success' | 'caution' | 'critical';
  /** Una riga sotto, piccola: il dettaglio o cosa manca. */
  detail?: ReactNode;
  /** Variazione o comando, accanto al valore. */
  trailing?: ReactNode;
}

/**
 * Un numero e il suo nome, nella forma compatta dell'admin.
 *
 * Le card di prima erano alte quanto un paragrafo: in una griglia la piu' alta
 * detta l'altezza di tutte, e bastava un elenco di quattro righe in una sola per
 * far crescere l'intera fila. Qui c'e' il nome piccolo, il valore, e al massimo
 * una riga di dettaglio — quanto serve a rispondere, niente che serva a
 * spiegare.
 *
 * Il nome porta la sottolineatura tratteggiata dell'admin quando c'e' una
 * spiegazione: e' il segno con cui Shopify dice "qui sotto c'e' altro", e
 * riusarlo evita di doverlo insegnare.
 */
export function StatCard({ label, hint, value, tone, detail, trailing }: StatCardProps) {
  const name = (
    <Text as="span" variant="bodySm" tone="subdued">
      {label}
    </Text>
  );

  return (
    <Card padding="400">
      <BlockStack gap="100">
        {hint ? (
          <Tooltip content={hint}>
            <span
              style={{
                borderBottom: '1px dotted var(--p-color-border)',
                cursor: 'help',
              }}
            >
              {name}
            </span>
          </Tooltip>
        ) : (
          name
        )}

        <InlineStack gap="200" blockAlign="baseline" wrap={false}>
          <Text as="p" variant="headingLg" tone={tone === 'caution' ? 'caution' : undefined}>
            {value}
          </Text>
          {trailing}
        </InlineStack>

        {detail}
      </BlockStack>
    </Card>
  );
}
