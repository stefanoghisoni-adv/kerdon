import { useEffect, useState, type ReactNode } from 'react';
import {
  Card,
  BlockStack,
  Icon,
  InlineStack,
  Text,
  Button,
  Divider,
  Tooltip,
} from '@shopify/polaris';
import { InfoIcon } from '@shopify/polaris-icons';
import { MetricRow } from './MetricRow';
import { middleTruncate } from './copy-value';
import { CopyIconButton } from './CopyIconButton';
import { useT } from '~/lib/i18n/context';

export interface DatabaseCardProps {
  connected: boolean;
  /** Indirizzo a cui il progetto risponde: si legge e si copia. */
  databaseUrl: string | null;
  /**
   * La pagina del progetto sulla dashboard di Supabase: e' li' che si va a
   * guardare le tabelle. `databaseUrl` aperto in un browser darebbe una
   * risposta dell'API, non una pagina.
   */
  dashboardUrl: string | null;
  /**
   * Le righe del collegamento — account e database — in cima alla card.
   *
   * Le compone chi ha i dati, questa card si limita a dar loro il posto
   * giusto: prima dell'indirizzo, perche' dicono a cosa si riferisce.
   */
  header?: ReactNode;
}

/**
 * Riga con il valore che si copia con un clic: niente pulsante accanto, il
 * valore stesso e' il bersaglio. Il tooltip dice cosa succede prima del clic e
 * conferma dopo, cosi' non serve spostare l'occhio altrove per sapere se ha
 * funzionato.
 *
 * Stessa impaginazione di MetricRow — etichetta a sinistra, valore a destra —
 * cosi' i valori cadono nella colonna del badge dello stato e la card si legge
 * per colonne invece che a blocchi.
 */
function CopyableRow({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  help?: string;
}) {
  return (
    // Il valore non e' piu' il bersaglio del clic: accanto c'e' un pulsante che
    // dice apertamente cosa fa. Cliccare un testo per copiarlo lo sapeva solo
    // chi ci passava sopra col puntatore.
    <InlineStack align="space-between" blockAlign="center" gap="200" wrap={false}>
      <InlineStack gap="100" blockAlign="center" wrap={false}>
        <Text as="span" variant="bodyMd">
          {label}
        </Text>
        {/* Cosa farsene di questo valore. Sono due stringhe che il merchant
            copia altrove: senza sapere dove vanno, copiarle non gli dice
            niente. */}
        {help ? (
          <Tooltip content={help}>
            <span className="info-icon">
              <Icon source={InfoIcon} tone="subdued" />
            </span>
          </Tooltip>
        ) : null}
      </InlineStack>
      <InlineStack gap="200" blockAlign="center" wrap={false}>
        <Text as="span" tone="subdued" truncate>
          {middleTruncate(value)}
        </Text>
        <CopyIconButton value={value} />
      </InlineStack>
    </InlineStack>
  );
}

/**
 * Riga di un valore che esiste solo a database collegato.
 *
 * La riga c'e' comunque: sparendo, la card non direbbe quali dati serviranno
 * per il tracciamento, e il collegamento sembrerebbe togliere qualcosa invece
 * di aggiungerlo. Finche' non c'e' nulla da copiare, al posto del valore va un
 * badge grigio — che e' il modo in cui il resto delle Impostazioni dice "questa
 * cosa non e' in uso".
 */
function ValueRow({
  label,
  value,
  available,
  help,
}: {
  label: string;
  value: string | null;
  available: boolean;
  help?: string;
}) {
  const t = useT();
  if (!available || !value) {
    return <MetricRow label={label} badge={{ content: t.database.notConfigured }} info={help} />;
  }
  return <CopyableRow label={label} value={value} help={help} />;
}

/**
 * L'indirizzo del database per esteso, con il pulsante che lo apre.
 *
 * Non e' una riga da copiare come le altre: si legge tutto intero e sta a
 * sinistra, perche' e' un indirizzo e va riconosciuto a colpo d'occhio. Il
 * pulsante porta fuori dall'admin, quindi il caricamento non e' una navigazione
 * che possiamo seguire: lo stato di attesa e' a tempo, il minimo per non far
 * partire due schede con due clic ravvicinati.
 */
function DatabaseAddress({ url, openUrl }: { url: string; openUrl: string }) {
  const t = useT();
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!opening) return;
    const timer = setTimeout(() => setOpening(false), 1500);
    return () => clearTimeout(timer);
  }, [opening]);

  return (
    // Una riga sola, come le altre della card: nome a sinistra, valore e
    // comando a destra. Su due righe l'indirizzo si staccava dal pulsante che
    // lo apre, e la card perdeva l'allineamento per colonne.
    <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
      <Text as="span" variant="bodyMd">
        {t.database.ownerUrl}
      </Text>
      <InlineStack gap="300" blockAlign="center" wrap={false}>
        {/* truncate e non breakWord: l'indirizzo deve restare su una riga
            accanto al pulsante, e se lo spazio non basta si accorcia invece di
            spingerlo fuori. */}
        <Text as="span" tone="subdued" truncate>
          {url}
        </Text>
        <Button
          url={openUrl}
          target="_blank"
          onClick={() => setOpening(true)}
          loading={opening}
          disabled={opening}
        >
          {t.database.open}
        </Button>
      </InlineStack>
    </InlineStack>
  );
}

export function DatabaseCard({
  connected,
  databaseUrl,
  dashboardUrl,
  header,
}: DatabaseCardProps) {
  const t = useT();
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {t.database.title}
        </Text>
        {header && (
          <>
            {header}
            <Divider />
          </>
        )}
        {connected && databaseUrl && (
          <DatabaseAddress url={databaseUrl} openUrl={dashboardUrl ?? databaseUrl} />
        )}
      </BlockStack>
    </Card>
  );
}

/**
 * Le credenziali con cui si legge da fuori, in una card loro.
 *
 * Stavano insieme al database, e le due cose si somigliano solo di nome: sopra
 * c'e' il progetto del merchant — dove i suoi dati vivono e da dove li guarda —
 * qui ci sono i due valori che copia altrove per farli leggere al proprio
 * tracciamento. Chi cerca l'uno non sta cercando gli altri, e tenerli in una
 * card sola faceva scorrere quattro righe per trovarne una.
 *
 * Lo stato sta qui e non di la' perche' e' lo stato di QUESTO: se non e'
 * collegato, i due valori sotto non esistono ancora ed e' quella riga a dirlo.
 */
export function TrackingCredentialsCard({
  connected,
  appUrl,
  readKey,
}: {
  connected: boolean;
  appUrl: string | null;
  readKey: string | null;
}) {
  const t = useT();

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {t.database.trackingTitle}
        </Text>
        <MetricRow
          label={t.database.status}
          badge={{
            tone: connected ? 'success' : undefined,
            content: connected ? t.common.connected : t.common.notConnected,
          }}
        />
        <ValueRow
          label={t.database.appUrl}
          value={appUrl}
          available={connected}
          help={t.database.appUrlHelp}
        />
        <ValueRow
          label={t.database.readKey}
          help={t.database.readKeyHelp}
          value={readKey}
          available={connected}
        />
      </BlockStack>
    </Card>
  );
}
