import {
  Badge,
  BlockStack,
  Box,
  Card,
  InlineGrid,
  InlineStack,
  RadioButton,
  Text,
} from '@shopify/polaris';
import type { PlanCard } from '~/components/Billing/plan-catalog';
import { PlanFeatureList } from '~/components/Billing/PlanFeatureList';
import type { BillingInterval } from '~/lib/billing/partner-pricing';
import { samePlanName } from '~/lib/billing/plan-name';
import { useLocale, useT } from '~/lib/i18n/context';
import { planPriceLabel, planSavingBadge } from './plan-step';

export interface PlanOptionGridProps {
  cards: PlanCard[];
  /** Nome del piano selezionato, '' se nessuno. */
  selected: string;
  onSelect: (planName: string) => void;
  /** Il piano attivo adesso: si segnala, non si nasconde. */
  currentPlanName: string | null | undefined;
  /** Il piano consigliato a questo negozio, se ce n'e' uno. */
  recommendedPlanName?: string | null;
  discountIntervals: number | null;
  interval: BillingInterval;
  currency: string;
  disabled?: boolean;
  loading?: boolean;
}

/**
 * Le card fra cui si sceglie un piano.
 *
 * Una sola griglia per i due posti in cui si sceglie — il passo della
 * configurazione e la tab Piano — perche' e' la stessa decisione: se le due
 * schermate mostrassero gli stessi piani in due forme diverse, il merchant
 * dovrebbe rileggerle entrambe per convincersi che dicono la stessa cosa.
 *
 * Qui c'e' solo la scelta: cosa succede dopo — sincronizzare, oppure aprire il
 * pagamento — lo decide chi la usa, con il proprio pulsante sotto la griglia.
 */
export function PlanOptionGrid({
  cards,
  selected,
  onSelect,
  currentPlanName,
  recommendedPlanName,
  discountIntervals,
  interval,
  currency,
  disabled,
  loading,
}: PlanOptionGridProps) {
  const t = useT();
  const locale = useLocale();
  const isCurrent = (card: PlanCard) => samePlanName(card.name, currentPlanName);

  // Se anche una sola card annuncia un risparmio, tutte riservano quella riga:
  // altrimenti gli elenchi partono a quote diverse e le card affiancate
  // sembrano disallineate. Dove nessuno risparmia la riga non esiste proprio, e
  // nessuno paga uno spazio vuoto.
  // Il risparmio esiste solo scegliendo l'annuale: sul mensile il badge
  // annunciava una riduzione che quel prezzo non ha, ed era il prezzo che si
  // stava guardando.
  const showSaving = interval === 'yearly';
  const anySaving =
    showSaving && cards.some((card) => planSavingBadge(card, t, currency, locale) != null);

  return (
    <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="300">
      {cards.map((card) => {
        const chosen = card.name === selected;
        return (
          // L'anello attorno alla card selezionata: Polaris non espone il bordo
          // della Card, e l'outline su un contenitore non occupa spazio —
          // quindi la card non si restringe quando si accende.
          <div
            key={card.name}
            // Tutta la card sceglie, non il solo pallino: il bersaglio e' grande
            // quanto la cosa che si sta scegliendo. Il radio resta dov'e' — e'
            // lui a dire quale sia lo stato, e a permettere di scegliere da
            // tastiera — ma non e' piu' l'unico modo.
            onClick={() => {
              if (disabled || loading) return;
              onSelect(card.name);
            }}
            style={{
              borderRadius: 'var(--p-border-radius-300)',
              outline: chosen ? '2px solid var(--p-color-bg-fill-brand)' : undefined,
              display: 'grid',
              cursor: disabled || loading ? undefined : 'pointer',
            }}
          >
            <Card padding="400">
              {/* Colonna a tutta altezza: l'elenco delle funzioni parte alla
                  stessa quota su tutte le card, che affiancate hanno altezze
                  diverse solo se qualcosa va a capo. */}
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    {/* Il radio e' l'unico comando: l'etichetta e' il nome del
                        piano, quindi ci si clicca sopra. */}
                    <RadioButton
                      label={card.name}
                      checked={chosen}
                      id={`plan-${card.name}`}
                      name="plan-option"
                      onChange={() => onSelect(card.name)}
                      disabled={disabled || loading}
                    />
                    {isCurrent(card) && <Badge tone="info">{t.planStep.current}</Badge>}
                    {/* Consigliato per QUESTO negozio: il piu' economico che
                        contenga il suo catalogo. */}
                    {recommendedPlanName != null &&
                      card.name === recommendedPlanName &&
                      !isCurrent(card) && (
                        <Badge tone="success">{t.planStep.recommended}</Badge>
                      )}
                  </InlineStack>

                  <BlockStack gap="150">
                    <Text as="p" variant="headingLg">
                      {planPriceLabel(card, discountIntervals, interval, t, currency, locale)}
                    </Text>
                    {/* Quanto fa risparmiare l'annuale su questo piano, sotto il
                        prezzo a cui si riferisce. Nasce dal testo: dove non c'e'
                        risparmio — il gratuito — il badge non esiste, invece di
                        comparire vuoto. */}
                    {anySaving && (
                      <Box minHeight="20px">
                        {showSaving && planSavingBadge(card, t, currency, locale) && (
                          <InlineStack>
                            <Badge tone="info">
                              {planSavingBadge(card, t, currency, locale) as string}
                            </Badge>
                          </InlineStack>
                        )}
                      </Box>
                    )}
                  </BlockStack>

                  <PlanFeatureList features={card.features} planName={card.name} />
                </BlockStack>
              </div>
            </Card>
          </div>
        );
      })}
    </InlineGrid>
  );
}
