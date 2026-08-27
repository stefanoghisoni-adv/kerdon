import { BlockStack, Box, Divider, InlineStack, Icon, Text, Tooltip } from '@shopify/polaris';
import { CheckCircleIcon, InfoIcon, XCircleIcon } from '@shopify/polaris-icons';
import type { PlanFeature } from './plan-catalog';
import { sortFeatures } from './plan-features';
import { featureLabel } from './feature-label';
import { useT, useLocale } from '~/lib/i18n/context';

interface Props {
  features: PlanFeature[];
}

// Feature incluse in verde con la spunta cerchiata, non incluse in grigio con
// la X cerchiata; le verdi vengono ordinate in alto da sortFeatures (no-op sul
// catalogo attuale, che le elenca gia' in quest'ordine per tenere allineate le
// card).
//
// I due simboli sono cerchiati e non nudi perche' cosi' hanno lo stesso
// ingombro: una spunta e una X sciolte hanno larghezze diverse, e in una colonna
// di righe si vedeva il testo ballare di un paio di pixel fra una riga inclusa e
// una esclusa.
//
// wrap={false} tiene icona e testo sulla stessa riga: che la label non vada a
// capo dipende invece dalla sua lunghezza, verificata nei test del catalogo.
export function PlanFeatureList({ features }: Props) {
  const t = useT();
  const locale = useLocale();

  // Il matching si stacca dalle altre: non e' una funzione in piu' nell'elenco,
  // e' quello che il piano fa con i clienti che gia' sincronizza. Sta in fondo,
  // dopo una riga di separazione, e non entra nell'ordinamento — deve restare
  // ultima anche quando e' inclusa e le altre no.
  const matching = features.find((feature) => feature.key === 'matching') ?? null;
  const sorted = sortFeatures(features.filter((feature) => feature.key !== 'matching'));

  return (
    <BlockStack gap="300" inlineAlign="start">
      {sorted.map((feature) => (
        <InlineStack key={feature.key} align="start" gap="200" blockAlign="center" wrap={false}>
          <Icon
            source={feature.included ? CheckCircleIcon : XCircleIcon}
            tone={feature.included ? 'success' : 'subdued'}
          />
          <Text as="span" tone={feature.included ? 'success' : 'subdued'}>
            {featureLabel(feature, t, locale)}
          </Text>
          {/* "Multi-feed prodotto" e' l'unica riga che nomina una cosa invece
              di misurarla: chi sta scegliendo un piano non sa per forza cosa
              sia un feed, e senza spiegazione quella riga non lo aiuta a
              decidere. La spiegazione sta nel tooltip perche' scritta per
              esteso allungherebbe la card piu' delle altre tre. */}
          {feature.key === 'feeds' && (
            <Tooltip content={t.plan.features.feedsHelp}>
              <Icon source={InfoIcon} tone="subdued" />
            </Tooltip>
          )}
        </InlineStack>
      ))}

      {matching && (
        <>
          {/* La riga di separazione porta tutto il peso: e' lei a dire che quel
              che viene dopo e' di un altro ordine rispetto all'elenco sopra.

              Dentro un Box a tutta larghezza perche' la pila qui sopra ha
              `inlineAlign="start"`, che stringe ogni figlio al proprio
              contenuto: un `<hr>` non ne ha, quindi collassava a zero e la riga
              c'era nel markup ma non si vedeva. */}
          <Box width="100%">
            <Divider />
          </Box>
          <div className={matching.included ? 'plan-feature-matching' : undefined}>
          <InlineStack align="start" gap="200" blockAlign="center" wrap={false}>
            {/* Il fulmine viene dai web component di App Home e non da
                `polaris-icons`: quel pacchetto un fulmine non ce l'ha, e questa
                riga il fulmine lo vuole. Gli elementi li registra
                `app-bridge.js`, che l'app carica gia' — lo inietta AppProvider.

                Pieno dove la funzione c'e', vuoto dove non c'e': la differenza
                si coglie prima di leggere, ed e' la stessa distinzione che
                passa fra il cerchio spuntato e quello sbarrato sopra.

                Il tono non puo' essere il viola che si vorrebbe: `s-icon`
                ammette solo info, success, warning, critical, auto, neutral e
                caution. Fra questi `info` e' l'unico che stacca dal testo senza
                promettere un esito — success direbbe "riuscito", warning
                "attenzione", e qui non c'e' ne' l'uno ne' l'altro. */}
            {matching.included ? (
              <s-icon type="bolt-filled" />
            ) : (
              <s-icon type="bolt" color="subdued" />
            )}
            <Text as="span" tone={matching.included ? undefined : 'subdued'}>
              {featureLabel(matching, t, locale)}
            </Text>
          </InlineStack>
          </div>
        </>
      )}
    </BlockStack>
  );
}
