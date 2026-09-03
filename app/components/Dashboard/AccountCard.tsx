import { Card, BlockStack, Box, Divider, InlineStack, Text } from '@shopify/polaris';
import { MetricRow } from './MetricRow';
import { planLabel, syncStatusBadge } from './account-format';
import { PlanUpgradeAction } from './PlanUpgradeAction';
import { useT } from '~/lib/i18n/context';
import {
  PreferencesSelect,
  type PreferenceOption,
  type Preferences,
} from './PreferencesSelect';

export interface AccountCardProps {
  planName: string;
  /** Gli ordini: non una funzione del piano ma un permesso concesso o no. */
  ordersSyncActive: boolean;
  productsSyncActive: boolean;
  customersSyncActive: boolean;
  /** I feed di catalogo verso le piattaforme: previsti dal piano, o no. */
  productFeedsActive: boolean;
  /** Il riconoscimento della stessa persona fra dispositivi diversi. */
  matchingActive: boolean;
  /**
   * Piano da proporre quando i clienti non sono inclusi (nome tecnico). Null
   * quando i clienti sono gia' inclusi o non c'e' un piano superiore da
   * proporre: in quel caso la riga torna al badge.
   */
  customersUpgradePlan?: string | null;
  /** Piano piu' economico che include i feed, per chi non li ha. */
  feedsUpgradePlan?: string | null;
  /** La lingua in uso e come cambiarla: vive qui perche' e' un dato di account. */
  /** Lingua e valuta in uso, e quelle fra cui scegliere. */
  preferences: Preferences;
  locales: PreferenceOption[];
  currencies: PreferenceOption[];
  onPreferencesChange: (next: Preferences) => void;
  localeSaving?: boolean;
}

export function AccountCard({
  planName,
  ordersSyncActive,
  productsSyncActive,
  customersSyncActive,
  productFeedsActive,
  matchingActive,
  customersUpgradePlan,
  feedsUpgradePlan,
  preferences,
  locales,
  currencies,
  onPreferencesChange,
  localeSaving,
}: AccountCardProps) {
  const t = useT();

  const upgrade = !customersSyncActive && Boolean(customersUpgradePlan);
  // Stessa regola dei clienti: dire "non ce l'hai" senza dire come averlo
  // lascia il merchant a cercare da solo in che piano stia quella funzione.
  const feedsUpgrade = !productFeedsActive && Boolean(feedsUpgradePlan);

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {t.account.title}
        </Text>
        <MetricRow label={t.account.plan} badge={{ content: planLabel(planName) }} />
        {/* Gli ordini per primi, sopra i prodotti: sono la base del profitto,
            e quando mancano non manca una funzione in piu' — mancano i numeri
            che il merchant e' venuto a vedere. */}
        <MetricRow
          label={t.account.ordersSync}
          badge={syncStatusBadge(ordersSyncActive, t)}
        />
        <MetricRow
          label={t.account.productsSync}
          badge={syncStatusBadge(productsSyncActive, t)}
        />
        <MetricRow
          label={t.account.customersSync}
          // L'invito all'upgrade prende il posto del badge "Non attiva": dice la
          // stessa cosa e in piu' dice cosa farci. Il badge resta quando la sync
          // e' attiva, o quando non c'e' nessun piano da proporre — altrimenti
          // la riga rimarrebbe senza risposta.
          //
          // Questo invito e quello dei feed sono due comandi distinti e ognuno
          // porta il proprio stato, perche' sta in un componente suo: prima
          // condividevano quello della navigazione verso /plan — stessa
          // destinazione, quindi stesso cerchietto — e premendone uno partivano
          // tutti e due.
          action={upgrade ? <PlanUpgradeAction plan={customersUpgradePlan} /> : undefined}
          badge={upgrade ? undefined : syncStatusBadge(customersSyncActive, t)}
        />
        {/* Sotto i clienti: e' la terza cosa che il piano concede o no, e si
            legge con gli stessi due badge delle altre due. */}
        <MetricRow
          label={t.account.productFeeds}
          action={feedsUpgrade ? <PlanUpgradeAction plan={feedsUpgradePlan} /> : undefined}
          badge={feedsUpgrade ? undefined : syncStatusBadge(productFeedsActive, t)}
        />
        {/* Il matching in viola, come nelle card dei piani: e' lo stesso nome
            per la stessa cosa, e un colore diverso qui lo farebbe sembrare
            un'altra. Il viola sta sulla sola scritta — il badge resta verde o
            grigio come tutte le righe sopra, perche' risponde alla stessa
            domanda. */}
        <MetricRow
          label={<span className="plan-feature-matching">{t.account.matching}</span>}
          badge={syncStatusBadge(matchingActive, t)}
        />

        {/* La lingua sta qui e non in una card sua: e' una preferenza
            dell'account, come il piano, e una card intera per una tendina
            sarebbe piu' cornice che contenuto.

            Stessa impaginazione delle righe sopra — nome a sinistra, valore a
            destra — cosi' la card continua a leggersi per colonne invece di
            spezzarsi in due blocchi. Il comando non prende tutta la riga: e'
            una tendina di poche voci, e larga quanto la card sembrerebbe il
            campo principale della pagina. */}
        <Divider />
        <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
          <Text as="span" variant="bodyMd">
            {t.language.label}
          </Text>
          <Box minWidth="45%">
            <PreferencesSelect
              locales={locales}
              currencies={currencies}
              value={preferences}
              onConfirm={onPreferencesChange}
              saving={localeSaving}
            />
          </Box>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
