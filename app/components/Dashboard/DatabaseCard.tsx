import { useEffect, useState, type ReactNode } from 'react';
import { useFetcher } from '@remix-run/react';
import {
  Card,
  BlockStack,
  Checkbox,
  Icon,
  InlineStack,
  Text,
  Button,
  Divider,
  Tooltip,
} from '@shopify/polaris';
import { InfoIcon } from '@shopify/polaris-icons';
import { MetricRow } from './MetricRow';
import { IngestKeySection, type IngestKeySummary } from './IngestKeySection';
import type { InstallPath } from '~/lib/tracking/install';
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
  /**
   * La riattivazione automatica del database, come sta adesso.
   *
   * `available: false` = non c'e' ancora nessun posto dove scrivere la scelta
   * del merchant, e l'interruttore non si mostra: un comando che non puo'
   * salvare niente e' peggio di nessun comando. Assente del tutto per chi monta
   * questa card senza quel dato (i test, e le schermate di configurazione che
   * un database ancora non ce l'hanno).
   */
  autoResume?: { available: boolean; enabled: boolean } | null;
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

/** Dove si salva la scelta sulla riattivazione automatica. */
const AUTO_RESUME_PATH = '/api/supabase/auto-resume';

/**
 * L'interruttore con cui il merchant decide se l'app debba riaccendere da sola
 * il suo database prima che non sia piu' riaccendibile.
 *
 * PERCHE' UN Checkbox. In questa card non c'era ancora nessuna opzione a
 * interruttore, quindi non c'era un modello da seguire: fra i componenti
 * Polaris, `Checkbox` e' quello che porta con se' `helpText` — cioe' il posto in
 * cui la spiegazione sta ATTACCATA al comando invece che sopra o sotto di esso.
 * Qui la spiegazione non e' un contorno: e' il modo in cui il merchant scopre
 * che l'app fa questa cosa prima che la faccia, e un componente che la tenesse
 * altrove renderebbe possibile leggere l'interruttore senza leggerla.
 *
 * Il pulsante di conferma non c'e' apposta: una spunta che si salva da sola e'
 * il modo in cui il resto dell'admin si comporta, e un "Salva" qui vorrebbe
 * dire che un merchant che spegne e chiude la scheda non ha spento niente.
 */
function AutoResumeToggle({ enabled }: { enabled: boolean }) {
  const t = useT();
  const salva = useFetcher<{ ok: boolean; enabled?: boolean }>();

  // Quel che il merchant vede mentre la scelta sta viaggiando e' quel che ha
  // appena scelto: senza, la spunta tornerebbe indietro per un istante e la
  // sensazione sarebbe che il clic non sia stato preso.
  const inVolo = salva.formData?.get('enabled');
  const spuntato =
    inVolo != null
      ? inVolo === 'true'
      : salva.data?.ok
        ? salva.data.enabled === true
        : enabled;

  // Non salvato: la spunta torna a com'era davvero e il motivo si legge sotto.
  // Lasciarla dov'e' vorrebbe dire far credere a un merchant che ha detto "non
  // toccare il mio database" che glielo abbiamo sentito dire.
  const fallito = salva.state === 'idle' && salva.data?.ok === false;

  return (
    <Checkbox
      label={t.database.autoResume.label}
      helpText={t.database.autoResume.help}
      checked={spuntato}
      disabled={salva.state !== 'idle'}
      error={fallito ? t.database.autoResume.failed : undefined}
      onChange={(valore) =>
        salva.submit(
          { enabled: String(valore) },
          { method: 'post', action: AUTO_RESUME_PATH },
        )
      }
    />
  );
}

export function DatabaseCard({
  connected,
  databaseUrl,
  dashboardUrl,
  header,
  autoResume,
}: DatabaseCardProps) {
  const t = useT();
  // Senza database collegato non c'e' niente da riaccendere: l'interruttore
  // resta fuori, come ogni altra riga di questa card che esiste solo a
  // collegamento avvenuto.
  const mostraAutoResume = connected && autoResume?.available === true;
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
        {mostraAutoResume && (
          <>
            {/* In fondo alla card e staccato: e' l'unica cosa qui dentro che
                cambia un comportamento invece di mostrare un valore. */}
            <Divider />
            <AutoResumeToggle enabled={autoResume.enabled} />
          </>
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
  install,
  ingest,
}: {
  connected: boolean;
  appUrl: string | null;
  readKey: string | null;
  /**
   * Come il negozio installa il tracciamento, e se la verifica e' passata.
   *
   * Sta in questa card e non in una sua perche' i due valori qui sopra sono
   * esattamente quelli che si copiano durante l'installazione: separarli
   * vorrebbe dire far scorrere la pagina avanti e indietro fra le istruzioni e
   * cio' che le istruzioni chiedono di copiare.
   */
  install: { path: InstallPath | null; endpoint: string | null; verifiedAt: string | null };
  /**
   * Le credenziali di invio del negozio.
   *
   * Stanno in questa card e non in una loro perche' si copiano nello stesso
   * momento delle due righe qui sopra, dentro lo stesso container: chi installa
   * ha bisogno di vederle insieme, non di cercarle in due posti.
   */
  ingest: {
    keys: IngestKeySummary[];
  };
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

        {/* La chiave di invio subito sotto quella di lettura: sono le due che
            si copiano nello stesso momento, e una accanto all'altra si vede a
            colpo d'occhio che sono due cose diverse. */}
        {connected && (
          <IngestKeySection keys={ingest.keys} />
        )}

        {/* La sezione "Installazione" del tracciamento non e' in questa
            versione, ed e' una scelta di prodotto: non e' ancora stata provata
            da un merchant vero, e una strada di installazione che nessuno ha
            percorso non si consegna — ne' a un merchant ne' a chi valuta l'app.

            Il componente resta nel repository con i suoi test perche' il lavoro
            e' fatto e non va rifatto; semplicemente non viene montato. Si
            rimette importando `TrackingInstall` e rendendolo qui, quando sara'
            stata provata. Vedi `app/components/Dashboard/TrackingInstall.tsx`. */}
      </BlockStack>
    </Card>
  );
}
