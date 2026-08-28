import { useCallback } from 'react';
import { useFetcher } from '@remix-run/react';
import { Badge, BlockStack, Box, InlineStack, Modal, Text } from '@shopify/polaris';
import { planLabel } from './account-format';
import {
  planComparisonRows,
  type PlanComparisonCounts,
  type PlanForSuggestion,
} from './plan-suggestion';
import { useLocale, useT } from '~/lib/i18n/context';

/** Larghezza delle due colonne dei valori: uguale, cosi' restano incolonnate. */
const VALUE_COLUMN = '120px';

type SubscribeResponse =
  | { confirmationUrl: string }
  | { ok: true }
  | { error: string };

export interface PlanUpgradeModalProps {
  open: boolean;
  onClose: () => void;
  /** Il piano che si lascia. */
  currentPlan: PlanForSuggestion;
  /** Il piano che si prende. */
  nextPlan: PlanForSuggestion;
  /** Valuta dei prezzi dei due piani: arriva con loro, non si indovina. */
  currency: string;
  counts?: PlanComparisonCounts;
}

/**
 * "Stai per passare a…": cosa cambia fra il piano in uso e quello proposto, e
 * il comando per prenderlo.
 *
 * Vive per conto suo e non dentro l'avviso del tetto prodotti, dov'e' nato:
 * l'invito ad aggiornare compare in quattro punti dell'app, e finche' il
 * confronto stava annidato dentro uno di quelli gli altri tre non potevano fare
 * altro che mandare il merchant sulla tab Piano — cioe' rispondere a "cosa
 * ottengo?" con "vai a cercartelo". Ora la risposta e' la stessa ovunque, ed
 * essendo scritta una volta sola non ci sono due tabelle che possono cominciare
 * a raccontare cose diverse.
 *
 * Qui dentro non si decide nulla: i due piani arrivano gia' scelti da chi apre
 * il confronto — l'avviso del tetto propone il piu' piccolo che contiene il
 * catalogo, la card dei clienti il piu' economico che li comprende — e questo e'
 * il motivo per cui la scelta non e' finita qui: e' l'unica cosa che cambia da
 * un punto all'altro.
 */
export function PlanUpgradeModal({
  open,
  onClose,
  currentPlan,
  nextPlan,
  currency,
  counts = {},
}: PlanUpgradeModalProps) {
  const t = useT();
  const locale = useLocale();
  const fetcher = useFetcher<SubscribeResponse>();
  const submitting = fetcher.state !== 'idle';

  const confirm = useCallback(() => {
    fetcher.submit(
      { plan: nextPlan.planName },
      { method: 'POST', action: '/billing/subscribe' },
    );
  }, [fetcher, nextPlan.planName]);

  // Shopify vuole la conferma dell'addebito fuori dal riquadro dell'app: si
  // esce dall'iframe, non si naviga dentro.
  const confirmationUrl =
    fetcher.data && 'confirmationUrl' in fetcher.data ? fetcher.data.confirmationUrl : null;
  if (confirmationUrl && typeof window !== 'undefined') {
    window.top?.location.replace(confirmationUrl);
  }

  const nextLabel = planLabel(nextPlan.planName);
  const rows = planComparisonRows(currentPlan, nextPlan, currency, locale, t, counts);
  // L'errore si legge qui e non nell'avviso da cui si e' arrivati: il pulsante
  // che ha provato l'addebito e' questo, e la risposta va dove sta la domanda.
  const error = fetcher.data && 'error' in fetcher.data ? fetcher.data.error : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.overflow.modalTitle(nextLabel)}
      primaryAction={{
        content: t.overflow.confirm,
        onAction: confirm,
        loading: submitting,
        disabled: submitting,
      }}
      secondaryActions={[
        { content: t.overflow.cancel, onAction: onClose, disabled: submitting },
      ]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {/* Le due colonne dei valori hanno la STESSA larghezza fissa. Senza,
              ognuna si dimensionava sul proprio contenuto e i numeri finivano
              addosso all'intestazione della colonna accanto, riga per riga in
              posizioni diverse: la tabella smetteva di leggersi per colonne. */}
          <InlineStack gap="400" align="space-between" blockAlign="center">
            <Text as="span" variant="bodySm" tone="subdued">
              {t.overflow.whatChanges}
            </Text>
            <InlineStack gap="300" blockAlign="center">
              <Box minWidth={VALUE_COLUMN}>
                <InlineStack align="end">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {planLabel(currentPlan.planName)}
                  </Text>
                </InlineStack>
              </Box>
              <Box minWidth={VALUE_COLUMN}>
                <InlineStack align="end">
                  <Text as="span" variant="bodySm" tone="subdued">
                    {nextLabel}
                  </Text>
                </InlineStack>
              </Box>
            </InlineStack>
          </InlineStack>

          {rows.map((row) => (
            <InlineStack key={row.key} gap="400" align="space-between" blockAlign="center">
              <Text as="span">
                {row.label}
                {/* Il numero di adesso, nello stesso grigio della riga in
                    fondo al modal: e' un termine di paragone, non un altro
                    dato da leggere. */}
                {row.note && (
                  <>
                    {' '}
                    <Text as="span" tone="subdued">
                      {row.note}
                    </Text>
                  </>
                )}
              </Text>
              <InlineStack gap="300" blockAlign="center">
                {/* Il valore che si lascia resta in grigio: e' il termine di
                    paragone, non una cosa da leggere per prima. */}
                <Box minWidth={VALUE_COLUMN}>
                  <InlineStack align="end">
                    <Text as="span" tone="subdued">
                      {row.current}
                    </Text>
                  </InlineStack>
                </Box>
                <Box minWidth={VALUE_COLUMN}>
                  <InlineStack align="end">
                    {row.key === 'matching' ? (
                      // Il matching non porta un tetto ma un colore, lo stesso
                      // che ha in fondo alle card dei prezzi: chi l'ha visto la'
                      // lo ritrova identico qui, e il badge verde delle altre
                      // righe lo rimetterebbe in fila con le funzioni fra cui
                      // non sta. Il viola arriva dalla classe del foglio di
                      // stile — fra i toni di Polaris quel viola non c'e', ed e'
                      // il perche' e' scritto li'.
                      <div
                        className={row.nextIncluded ? 'plan-feature-matching' : undefined}
                      >
                        <Text as="span" tone={row.nextIncluded ? undefined : 'subdued'}>
                          {row.next}
                        </Text>
                      </div>
                    ) : (
                      <Badge tone="success">{row.next}</Badge>
                    )}
                  </InlineStack>
                </Box>
              </InlineStack>
            </InlineStack>
          ))}

          {error && (
            <Text as="p" tone="critical">
              {error}
            </Text>
          )}

          <Text as="p" tone="subdued">
            {t.overflow.chargeNote}
          </Text>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
