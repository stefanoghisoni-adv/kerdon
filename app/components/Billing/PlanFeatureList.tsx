import { BlockStack, Box, Divider, InlineStack, Icon, Text, Tooltip } from '@shopify/polaris';
import { CheckCircleIcon, DatabaseIcon, InfoIcon, XCircleIcon } from '@shopify/polaris-icons';
import type { PlanFeature } from './plan-catalog';
import { sortFeatures } from './plan-features';
import { featureLabel, isDatabaseExtended } from './feature-label';
import { BoltFilledIcon, BoltIcon } from './BoltIcon';
import { useT, useLocale } from '~/lib/i18n/context';

interface Props {
  features: PlanFeature[];
  /** Nome del piano: serve per l'etichetta del database (limitato/esteso). */
  planName?: string;
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
export function PlanFeatureList({ features, planName }: Props) {
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
          {/* Il database porta la propria icona al posto del cerchio spuntato.
              Sulle altre righe il cerchio dice "questo il piano ce l'ha"; qui
              non servirebbe a niente, perche' il database c'e' su tutti i piani
              — quello che cambia e' quanto. Lo dicono l'etichetta ("limitato" o
              "esteso") e il colore dell'icona: grigia sul Free, verde dove il
              database e' quello esteso.

              La condizione e' la stessa che sceglie l'etichetta, e viene dallo
              stesso posto: due condizioni scritte a mano prima o poi
              divergono, e una card direbbe "esteso" con l'icona spenta.

              E' l'icona `database` di `@shopify/polaris-icons` — quella vera,
              non un disegno somigliante. 17px invece dei 20 nativi: nella
              colonna dei simboli un database a piena misura pesa piu' dei
              cerchi che gli stanno sopra e sotto, e sbilancia la lettura. */}
          {feature.key === 'database' ? (
            /* Verde su tutti i piani, Free compreso: il database c'e' sempre,
               e un'icona spenta direbbe che manca. Quello che cambia — quanto
               sincronizza — lo dicono l'etichetta e il tooltip, che sul Free
               parlano di soli prodotti. */
            <span className="plan-feature-database-icon">
              <Icon source={DatabaseIcon} tone="success" />
            </span>
          ) : (
            <Icon
              source={feature.included ? CheckCircleIcon : XCircleIcon}
              tone={feature.included ? 'success' : 'subdued'}
            />
          )}
          {/* Il database e' verde su tutti i piani, icona e scritta: c'e'
              sempre, e spegnerlo sul Free direbbe che manca. Le altre righe
              invece si spengono quando il piano non le comprende. */}
          <Text
            as="span"
            tone={feature.key === 'database' || feature.included ? 'success' : 'subdued'}
          >
            {featureLabel(feature, t, locale, planName)}
          </Text>
          {/* "Multi-feed prodotto" e' l'unica riga che nomina una cosa invece
              di misurarla: chi sta scegliendo un piano non sa per forza cosa
              sia un feed, e senza spiegazione quella riga non lo aiuta a
              decidere. La spiegazione sta nel tooltip perche' scritta per
              esteso allungherebbe la card piu' delle altre tre. */}
          {feature.key === 'feeds' && (
            <Tooltip content={t.plan.features.feedsHelp}>
              <span className="info-icon">
              <Icon source={InfoIcon} tone="subdued" />
            </span>
            </Tooltip>
          )}
          {/* Il database c'e' su tutti i piani, ma "limitato" o "esteso" non
              dice a chi legge cosa cambia davvero: senza spiegare cosa si
              sincronizza, la riga non aiuta a scegliere. Il tooltip dice che
              si tratta di dati utente GDPR-compliant e connessioni con ordini,
              senza nomi di tabelle o colonne. */}
          {feature.key === 'database' && (
            /* Due spiegazioni e non una: sul Free il database sincronizza i
               soli prodotti — non gli ordini, non i dati dei clienti — e
               promettergli "tutti i dati utente" sarebbe scritto falso proprio
               sulla card di chi non li ha. */
            <Tooltip
              content={
                isDatabaseExtended(planName)
                  ? t.plan.features.databaseHelp
                  : t.plan.features.databaseHelpLimited
              }
            >
              <span className="info-icon">
              <Icon source={InfoIcon} tone="subdued" />
            </span>
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
            <div className="plan-feature-divider">
              <Divider />
            </div>
          </Box>
          <div className={matching.included ? 'plan-feature-matching' : undefined}>
          <InlineStack align="start" gap="200" blockAlign="center" wrap={false}>
            {/* Pieno dove la funzione c'e', vuoto dove non c'e': la
                differenza si coglie prima di leggere, ed e' la stessa
                distinzione che passa fra il cerchio spuntato e quello sbarrato
                nelle righe sopra.

                Il fulmine sta in un file nostro perche' `polaris-icons` non ne
                ha uno: il perche' della scelta e' scritto li'. Il viola arriva
                dal foglio di stile e non da una prop — fra i toni dell'`Icon`
                quel viola non c'e'. */}
            <Icon
              source={matching.included ? BoltFilledIcon : BoltIcon}
              tone={matching.included ? undefined : 'subdued'}
            />
            <Text as="span" tone={matching.included ? undefined : 'subdued'}>
              {featureLabel(matching, t, locale, planName)}
            </Text>
          </InlineStack>
          </div>
        </>
      )}
    </BlockStack>
  );
}
