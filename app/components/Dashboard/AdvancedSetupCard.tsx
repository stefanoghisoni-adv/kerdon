import { Card, BlockStack, Badge, Button, InlineStack, Text } from '@shopify/polaris';
import { XIcon } from '@shopify/polaris-icons';
import { ServerSideStep } from './ServerSideStep';
import type { ServerSideAnswer } from './tracking-platforms';
import { useT } from '~/lib/i18n/context';

export interface AdvancedSetupCardProps {
  selected: string[];
  onSelectedChange: (platforms: string[]) => void;
  onAnswer: (answer: ServerSideAnswer) => void;
  submitting: ServerSideAnswer | null;
  disabled?: boolean;
  error?: string | null;
}

/**
 * La proposta di configurazione avanzata, in dashboard.
 *
 * Stava fra i passi della configurazione, ed era l'unico che non configurava
 * niente: serviva a raccogliere una richiesta di contatto. Una configurazione
 * deve finire quando l'app funziona — tutto cio' che sta in mezzo e non e'
 * necessario allunga la strada di chi vuole solo cominciare, e in revisione fa
 * chiedere perche' sia obbligatorio.
 *
 * Qui invece arriva dopo, a cose fatte, e si puo' chiudere. Chi la chiude non
 * la rivede: il gesto viene registrato come qualunque altra risposta.
 */
export function AdvancedSetupCard({
  selected,
  onSelectedChange,
  onAnswer,
  submitting,
  disabled,
  error,
}: AdvancedSetupCardProps) {
  const t = useT();

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
          <InlineStack gap="200" blockAlign="center" wrap={false}>
            <Text as="h2" variant="headingMd">
              {t.advancedSetup.title}
            </Text>
            <Badge tone="new">{t.advancedSetup.beta}</Badge>
          </InlineStack>

          {/* Chiudere e' una risposta: "non adesso". Senza, l'unico modo di far
              sparire la card sarebbe dichiarare qualcosa che non si e' voluto
              dichiarare. */}
          <Button
            icon={XIcon}
            variant="tertiary"
            accessibilityLabel={t.common.cancel}
            onClick={() => onAnswer('dismissed')}
            loading={submitting === 'dismissed'}
            disabled={disabled || submitting !== null}
          />
        </InlineStack>

        <ServerSideStep
          selected={selected}
          onSelectedChange={onSelectedChange}
          onAnswer={onAnswer}
          submitting={submitting === 'dismissed' ? null : submitting}
          disabled={disabled || submitting !== null}
          answered={null}
          error={error}
        />
      </BlockStack>
    </Card>
  );
}
