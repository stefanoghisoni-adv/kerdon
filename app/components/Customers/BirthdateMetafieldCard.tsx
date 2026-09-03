import { useFetcher } from '@remix-run/react';
import { useEffect, useState } from 'react';
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Box,
  InlineStack,
  Labelled,
  Link,
  OptionList,
  Popover,
  Text,
} from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import {
  BIRTHDATE_METAFIELD_KEY,
  formatMetafieldKey,
  isDateMetafieldType,
  type BirthdateFieldState,
} from '~/lib/customers/birthdate-metafield';
import {
  birthdateView,
  readDismissedFor,
  rememberDismissedFor,
  type BirthdateView,
} from './birthdate-notice';

/**
 * Cosa mostrare della data di nascita, e come cambiarlo.
 *
 * Lo tiene la pagina e non questo riquadro, perche' a leggerlo sono in due: il
 * riquadro e la riga di stato sopra la tabella, che sono la stessa cosa vista
 * in due momenti — o si guarda com'e' messa, o la si sta cambiando. Con due
 * memorie separate una delle due avrebbe finito per raccontare il passato.
 */
export interface BirthdateNotice {
  view: BirthdateView;
  /** Apre il riquadro di scelta: "Aggiungi", "Cambia", "Cambia campo". */
  open(): void;
  /** Lo richiude, a scelta fatta. */
  close(): void;
  /** Chiude l'avviso di conferma, e si ricorda per quale campo. */
  dismiss(): void;
}

export function useBirthdateNotice(
  configured: string,
  state: BirthdateFieldState,
): BirthdateNotice {
  // Il merchant ha chiesto di scegliere, o di rivedere la scelta gia' fatta.
  // Vive nel browser e non sul server: e' un ripensamento momentaneo, non una
  // configurazione.
  const [reopened, setReopened] = useState(false);

  // Per quale campo l'avviso e' gia' stato chiuso.
  //
  // Sta nel browser e non sul server perche' non e' una configurazione: e' cosa
  // questa persona ha gia' letto. Sopravvive alla ricarica — altrimenti "non
  // mostrare piu'" durerebbe fino al primo aggiornamento di pagina — ma non
  // viaggia con il negozio, e va bene cosi': l'ha letto chi l'ha chiuso.
  const [dismissedFor, setDismissedFor] = useState<string | null | undefined>(undefined);

  // Solo nel browser: `localStorage` non esiste durante il render sul server, e
  // leggerlo li' romperebbe l'idratazione. Fino a quel momento vale
  // `undefined`, che non e' "nessuno" ma "non lo so ancora": tiene la scelta
  // sospesa invece di prenderla sbagliata e correggerla un istante dopo, sotto
  // gli occhi di chi guarda.
  useEffect(() => {
    setDismissedFor(readDismissedFor());
  }, []);

  return {
    view: birthdateView({ state, configured, reopened, dismissedFor }),
    open: () => setReopened(true),
    close: () => setReopened(false),
    dismiss: () => {
      setDismissedFor(configured);
      rememberDismissedFor(configured);
    },
  };
}

interface Definition {
  /** La chiave per intero, namespace compreso: `custom.data_di_nascita`. */
  key: string;
  name: string;
  type: string;
}

interface BirthdateMetafieldCardProps {
  /** Il campo da cui si legge oggi. Vuoto = nessuno scelto. */
  configured: string;
  /**
   * Cosa dire di quel campo: nessuno, in uso, oppure scelto ma non presente
   * sul negozio. Lo decide il server, che e' l'unico ad avere sotto mano sia la
   * scelta salvata sia l'elenco vero delle definizioni.
   */
  state: BirthdateFieldState;
  /**
   * Il nostro campo esiste gia' sul negozio? `null` quando non si e' potuto
   * chiedere a Shopify: in quel caso si propone comunque di crearlo, perche'
   * crearlo due volte non fa danno mentre nascondere il pulsante lascerebbe il
   * merchant senza strada.
   */
  ourDefinitionPresent: boolean | null;
  /** I campi personalizzati che il negozio ha sui clienti. */
  definitions: Definition[];
  /** Il campo in uso non contiene una data. */
  notADate: boolean;
  /** La pagina dell'admin dove i campi si vedono e si modificano. */
  adminUrl: string | null;
  /** Cosa mostrare, e come cambiarlo. Lo tiene la pagina: vedi sopra. */
  notice: BirthdateNotice;
}

/**
 * Il riquadro del campo "Data di nascita" nella tab Clienti.
 *
 * Sta qui e non nelle impostazioni: e' qui che si guarda chi sono i clienti, ed
 * e' guardandoli che viene voglia di sapere quando sono nati.
 *
 * Due strade, perche' due sono i punti di partenza. Chi non ha niente si fa
 * creare il campo, e non ha niente da decidere: nome e valore sono quelli
 * ufficiali di Shopify, e l'anteprima qui sotto glieli mostra prima che
 * succeda. Chi ha gia' il suo campo lo indica dall'elenco del negozio.
 *
 * Sparita la casella in cui si scriveva la chiave a mano: era una liberta' che
 * serviva solo a sbagliare — un refuso li' dentro produceva una colonna vuota
 * che nessuno sapeva spiegare — e i campi che si possono scegliere sono
 * comunque tutti nell'elenco.
 *
 * Il collegamento all'admin esce dall'iframe (`target="_top"`) come gia' fa il
 * nome del cliente in tabella: aperto dentro il riquadro dell'app, l'admin di
 * Shopify non si carica affatto.
 */
export function BirthdateMetafieldCard({
  configured,
  state,
  ourDefinitionPresent,
  definitions,
  notADate,
  adminUrl,
  notice,
}: BirthdateMetafieldCardProps) {
  const t = useT();
  const fetcher = useFetcher<{ ok: boolean; error: 'invalid' | 'failed' | null }>();

  // Il pannello "Utilizza esistente" si apre solo se richiesto: chi arriva qui
  // per la prima volta ha davanti due pulsanti e un'anteprima, non un modulo.
  const [choosing, setChoosing] = useState(false);
  // Quello che finira' salvato: lo riempie l'elenco, e si vede scritto prima di
  // confermarlo.
  const [chosen, setChosen] = useState('');
  // L'elenco e' aperto. Vive qui e non dentro il pulsante: sceglierne una voce
  // lo richiude, ed e' il comportamento che ci si aspetta da una tendina.
  const [listOpen, setListOpen] = useState(false);

  // QUALE azione e' in volo, non "se ce n'e' una".
  //
  // I due comandi vivono in due form diverse ma condividono la fetcher: con un
  // solo booleano, confermando la scelta di un campo esistente partiva il
  // cerchietto anche su "Crea nuovo metafield", che con quel gesto non c'entra.
  // Il nome dell'intento arriva dalla form appena inviata, senza tenerne una
  // copia a parte: una seconda fonte per la stessa cosa e' una seconda cosa da
  // tenere allineata.
  const running = fetcher.state === 'idle' ? null : String(fetcher.formData?.get('intent') ?? '');
  const busy = running !== null;
  const creating = running === 'create';
  const choosingBusy = running === 'use';
  const failed = !busy && fetcher.data?.ok === false;

  // Andata a buon fine: si richiude quello che si era riaperto.
  //
  // Senza, dopo aver confermato un campo nuovo la card restava aperta: lo stato
  // sul server diceva "in uso", ma qui `reopened` era ancora acceso e teneva
  // la card al posto dell'avviso. Il ripensamento e' finito nel momento in cui
  // la scelta e' stata fatta.
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.ok) {
      notice.close();
      setChoosing(false);
    }
    // `notice` si ricostruisce a ogni render: metterlo fra le dipendenze
    // farebbe ripartire l'effetto in continuazione. Quel che serve e' il
    // momento in cui la richiesta si conclude, ed e' quello che c'e' scritto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // Le definizioni di tipo data per prime: sono quelle che fanno quello che
  // serve qui. Le altre restano scegliibili — un negozio puo' tenere la data di
  // nascita in un campo di testo, e non tocca a noi vietarlo — ma sotto, in un
  // gruppo a parte.
  const dates = definitions.filter((d) => isDateMetafieldType(d.type));
  const others = definitions.filter((d) => !isDateMetafieldType(d.type));
  const asOption = (d: Definition) => ({ label: `${d.name} · ${d.key}`, value: d.key });

  // Sezioni, non una lista piatta: separare le date dal resto e' l'unico modo
  // per dire "queste vanno bene, quelle forse" senza scriverlo.
  const sections = [
    ...(dates.length > 0
      ? [{ title: t.customers.birthdate.groupDates, options: dates.map(asOption) }]
      : []),
    ...(others.length > 0
      ? [{ title: t.customers.birthdate.groupOthers, options: others.map(asOption) }]
      : []),
  ];

  const activatorLabel = chosen || t.customers.birthdate.choosePlaceholder;

  // Sistemato: la card ha finito il suo lavoro e si toglie di mezzo.
  //
  // Restare aperta dopo che il campo e' stato scelto vorrebbe dire tenere in
  // pagina un modulo da compilare per una cosa gia' fatta — e la tab Clienti
  // serve a guardare i clienti, non a riguardare una configurazione conclusa.
  // Al suo posto parla l'avviso, e quando anche quello e' stato chiuso resta la
  // riga di stato sopra la tabella: da li' si torna qui in un clic, cosi' la
  // scelta non diventa irreversibile a fronte di un tocco distratto.
  if (notice.view === 'status' || notice.view === 'pending') return null;

  if (notice.view === 'notice') {
    // Chiudibile sempre, e chiuso una volta non torna piu' — a meno che il
    // campo non cambi.
    //
    // La chiusura si ricorda insieme AL CAMPO per cui e' stata fatta, non come
    // un si'/no: e' l'unico modo perche' l'avviso taccia su una configurazione
    // che il merchant ha gia' visto e riparli quando c'e' qualcosa di nuovo da
    // dire. Un "non mostrare piu'" secco avrebbe nascosto per sempre anche il
    // giorno in cui il campo diventa un altro — che e' un campo diverso, quindi
    // una conferma nuova.
    return (
      <Banner
        tone="success"
        title={t.customers.birthdate.doneTitle}
        onDismiss={notice.dismiss}
        action={{
          content: t.customers.birthdate.change,
          onAction: notice.open,
        }}
      >
        <Text as="p">{t.customers.birthdate.inUse(configured)}</Text>
      </Banner>
    );
  }

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {t.customers.birthdate.title}
        </Text>
        <Text as="p" tone="subdued">
          {t.customers.birthdate.description}
        </Text>

        {/* Cosa si sta leggendo adesso, sempre a schermo. Tre stati e non due:
            annunciare come "in uso" un campo che sul negozio non esiste
            lascerebbe il merchant convinto di raccogliere una data che non
            arrivera' mai. */}
        <Text as="p">
          {state === 'none' && t.customers.birthdate.noneInUse}
          {state === 'in_use' && t.customers.birthdate.inUse(configured)}
          {state === 'missing' && t.customers.birthdate.missingOnStore(configured)}
        </Text>

        {notADate && <Banner tone="warning">{t.customers.birthdate.notADate}</Banner>}

        {/* L'anteprima di cio' che comparira' sulla scheda cliente. Si guarda,
            non si tocca: nome e valore sono quelli con cui Shopify conosce
            questo campo, e cambiarli vorrebbe dire creare un campo diverso che
            nessun altro strumento saprebbe leggere. */}
        <Box background="bg-surface-secondary" borderRadius="200" padding="300">
          <BlockStack gap="100">
            <InlineStack gap="150" wrap>
              <Text as="span" tone="subdued">
                {t.customers.birthdate.previewNameLabel}:
              </Text>
              <Text as="span" fontWeight="semibold">
                {t.customers.birthdate.fieldName}
              </Text>
            </InlineStack>
            <InlineStack gap="150" wrap>
              <Text as="span" tone="subdued">
                {t.customers.birthdate.previewValueLabel}:
              </Text>
              <Text as="span" fontWeight="semibold">
                {formatMetafieldKey(BIRTHDATE_METAFIELD_KEY)}
              </Text>
            </InlineStack>
          </BlockStack>
        </Box>

        <InlineStack gap="300" blockAlign="center" wrap>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="create" />
            {/* Spento quando quel campo sul negozio c'e' gia': premerlo non
                creerebbe niente — Shopify risponde che esiste — e un comando
                che non fa niente e' peggio di un comando assente, perche' fa
                dubitare di aver sbagliato qualcosa. Chi lo vuole usare passa
                da "Utilizza esistente", che e' li' accanto. */}
            <Button
              submit
              variant="primary"
              loading={creating}
              disabled={busy || ourDefinitionPresent === true}
            >
              {t.customers.birthdate.create}
            </Button>
          </fetcher.Form>

          {/* Spento quando il negozio non ha campi da offrire: un pulsante che
              apre un elenco vuoto e' una promessa non mantenuta. */}
          {!choosing && (
            <Button
              onClick={() => setChoosing(true)}
              disabled={busy || definitions.length === 0}
            >
              {t.customers.birthdate.useExisting}
            </Button>
          )}

          {ourDefinitionPresent && (
            <Badge tone="success">{t.customers.birthdate.present}</Badge>
          )}

          {/* Lo stato intermedio ha bisogno di una parola: il solo cerchietto
              dentro il pulsante dice che sta succedendo qualcosa, non cosa. */}
          {busy && (
            <Text as="span" tone="subdued" variant="bodySm">
              {t.customers.birthdate.working}
            </Text>
          )}

          {adminUrl && (
            <Link url={adminUrl} target="_top" removeUnderline>
              {t.customers.birthdate.openAdmin}
            </Link>
          )}
        </InlineStack>

        {choosing && (
          /* La scelta non si applica al tocco: si sceglie, si legge quel che si
             e' scelto, e solo allora si conferma. Un tocco distratto sulla
             tendina ripunterebbe la lettura su un altro campo senza che nessuno
             se ne accorga, e da li' in avanti tutti i clienti porterebbero il
             valore sbagliato. E' la stessa ragione per cui cambiare database
             chiede conferma invece di collegare al clic. */
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="use" />
            <input type="hidden" name="metafield" value={chosen} />
            <BlockStack gap="300">
              {/* Stessa forma del selettore lingua/valuta in Impostazioni: un
                  pulsante che dice cosa e' scelto adesso e apre un elenco.
                  Scegliere qui non salva niente: la conferma resta una sola, in
                  fondo. */}
              <Labelled id="birthdate-metafield-choice" label={t.customers.birthdate.chooseLabel}>
                <Popover
                  active={listOpen}
                  preferredPosition="below"
                  preferredAlignment="left"
                  onClose={() => setListOpen(false)}
                  activator={
                    // Stretto, non a tutta riga: e' un comando che sceglie una
                    // voce, non un campo da compilare, e disteso su tutta la
                    // larghezza della card prometteva un'importanza che non ha.
                    // Il tetto sta sul contenitore e non sul pulsante, cosi' la
                    // larghezza non balla al cambiare della voce scelta.
                    <Box maxWidth="280px">
                      <Button
                        id="birthdate-metafield-choice"
                        onClick={() => setListOpen((open) => !open)}
                        disclosure
                        fullWidth
                        textAlign="left"
                        disabled={busy}
                      >
                        {activatorLabel}
                      </Button>
                    </Box>
                  }
                >
                  {/* Come nel selettore delle preferenze: l'elenco scorre da
                      solo e la rotellina, arrivata in fondo, non passa il turno
                      alla pagina sotto. */}
                  <Box minWidth="320px">
                    <div
                      className="list-tight-titles"
                      style={{
                        maxHeight: 240,
                        overflowY: 'auto',
                        overscrollBehavior: 'contain',
                      }}
                    >
                      <OptionList
                        sections={sections}
                        selected={chosen ? [chosen] : []}
                        onChange={(next) => {
                          if (next[0]) setChosen(next[0]);
                          setListOpen(false);
                        }}
                      />
                    </div>
                  </Box>
                </Popover>
              </Labelled>

              <InlineStack gap="300">
                <Button
                  submit
                  variant="primary"
                  loading={choosingBusy}
                  disabled={busy || !chosen}
                >
                  {t.common.confirm}
                </Button>
                {/* "Annulla" chiude tutto, non solo la tendina: il riquadro e'
                    aperto perche' qualcuno ha chiesto di scegliere, e lasciarlo
                    li' dopo un ripensamento non e' lasciar perdere. Il riquadro
                    si riapre dalla riga di stato con un clic, e chi invece
                    voleva il campo nuovo ha il pulsante li' sopra. */}
                <Button
                  onClick={() => {
                    setChoosing(false);
                    setChosen('');
                    notice.close();
                  }}
                  disabled={busy}
                >
                  {t.common.cancel}
                </Button>
              </InlineStack>
            </BlockStack>
          </fetcher.Form>
        )}

        {failed && (
          <Banner tone="critical">
            {fetcher.data?.error === 'invalid'
              ? t.customers.birthdate.invalid
              : t.customers.birthdate.failed}
          </Banner>
        )}
      </BlockStack>
    </Card>
  );
}
