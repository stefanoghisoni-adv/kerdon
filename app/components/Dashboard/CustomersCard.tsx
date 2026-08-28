import { Card, BlockStack, Text, Box, Tooltip } from '@shopify/polaris';
import { MetricRow } from './MetricRow';
import { PlanUpgradeAction } from './PlanUpgradeAction';
import { useT } from '~/lib/i18n/context';

export interface CustomersCardProps {
  enabled: boolean;
  totalCustomers: number;
  optIn: number;
  optOut: number;
  /** Piano piu' economico che include i clienti, per chi non li ha. */
  upgradePlan?: string | null;
  loading: boolean;
}

export function CustomersCard({
  enabled,
  totalCustomers,
  optIn,
  optOut,
  upgradePlan,
  loading,
}: CustomersCardProps) {
  const t = useT();
  const value = (n: number) => (loading ? '—' : String(n));

  return (
    <Card>
      <BlockStack gap="300">
        {/* Stesso titolo delle card di statistica accanto: piccolo, in secondo
            piano, con la spiegazione nel tooltip. Un headingMd qui faceva
            sembrare questa card di un livello diverso dalle altre della stessa
            riga, che invece dicono cose dello stesso peso. */}
        <Tooltip content={t.dashboard.customers.hint}>
          <span
            style={{
              borderBottom: '1px dotted var(--p-color-border)',
              cursor: 'help',
              alignSelf: 'start',
            }}
          >
            <Text as="span" variant="bodySm" tone="subdued">
              {t.dashboard.customers.title}
            </Text>
          </span>
        </Tooltip>

        {enabled ? (
          <BlockStack gap="300">
            <MetricRow
              label={t.dashboard.customers.total}
              badge={{ content: value(totalCustomers) }}
            />
            <MetricRow
              label={t.dashboard.customers.optIn}
              info={t.dashboard.customers.optInInfo}
              badge={{ tone: 'success', content: value(optIn) }}
            />
            <MetricRow
              label={t.dashboard.customers.optOut}
              info={t.dashboard.customers.optOutInfo}
              badge={{ content: value(optOut) }}
            />
          </BlockStack>
        ) : (
          // Piano senza sync clienti: i dati non si mostrano affatto, nemmeno
          // velati. Non avendo nulla da nascondere spariscono sia l'overlay in
          // CSS sia il contenuto inerte da rendere inaccessibile: resta solo
          // l'invito all'upgrade, tutto in Polaris.
          <BlockStack gap="200" inlineAlign="center">
            {/* Il piano da prendere sta dentro la frase, come link: prima era
                un invito generico sopra un pulsante generico, e il nome del
                piano non compariva da nessuna parte — restava da cercare.

                Premendolo si apre qui il confronto fra i due piani, invece di
                spedire il merchant sulla tab Piano a ricostruirselo da solo:
                l'invito e' lo stesso che compare altrove nell'app, ed e' giusto
                che risponda allo stesso modo. */}
            <Box paddingInline="400">
              <Text as="p" tone="subdued" alignment="center" variant="bodySm">
                <PlanUpgradeAction plan={upgradePlan} />
                {t.dashboard.customers.upsell}
              </Text>
            </Box>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
