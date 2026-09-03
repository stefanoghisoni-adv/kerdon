import type { ReactNode } from 'react';
import { BlockStack, Card, Icon, InlineStack, Text, Tooltip } from '@shopify/polaris';
import { InfoIcon } from '@shopify/polaris-icons';
import { useT } from '~/lib/i18n/context';

interface Props {
  /** Le righe dei campi: oggi una sola, la data di nascita. */
  children: ReactNode;
}

/**
 * I campi che ai clienti si aggiungono, accanto alla tabella.
 *
 * Sono informazioni che Shopify non ha come campi propri e che il negozio tiene
 * dove vuole: qui si dice quali di quelle l'app sta leggendo, e da qui si
 * collegano. Sta a fianco della tabella e non sopra perche' non e' un filtro
 * ne' un comando — non cambia quello che si sta guardando, dice cosa altro c'e'
 * dentro. Sopra la tabella avrebbe fatto da diaframma fra i filtri e le righe.
 *
 * Un elenco e non una riga sola: oggi il campo e' uno, la data di nascita, ma
 * la card e' fatta per contenerne altri senza doverla rifare.
 */
export function ExtraFieldsCard({ children }: Props) {
  const t = useT();

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack gap="100" blockAlign="center" wrap={false}>
          <Text as="h2" variant="headingMd">
            {t.customers.extraFields.title}
          </Text>
          {/* La stessa "i" delle card dei piani: il titolo dice cosa sono, il
              tooltip da dove arrivano. Scritto per esteso allungherebbe la card
              per una frase che si legge una volta sola. */}
          <Tooltip content={t.customers.extraFields.help}>
            <span className="info-icon">
              <Icon source={InfoIcon} tone="subdued" />
            </span>
          </Tooltip>
        </InlineStack>
        <BlockStack gap="200">{children}</BlockStack>
      </BlockStack>
    </Card>
  );
}
