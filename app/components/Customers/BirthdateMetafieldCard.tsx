import { useFetcher } from '@remix-run/react';
import { useState } from 'react';
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
  TextField,
} from '@shopify/polaris';
import { useT } from '~/lib/i18n/context';
import { isDateMetafieldType } from '~/lib/customers/birthdate-metafield';

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
}

/**
 * Il riquadro del campo "Data di nascita" nella tab Clienti.
 *
 * Sta qui e non nelle impostazioni: e' qui che si guarda chi sono i clienti, ed
 * e' guardandoli che viene voglia di sapere quando sono nati.
 *
 * Due strade, perche' due sono i punti di partenza. Chi non ha niente si fa
 * creare il campo. Chi ha gia' il suo lo indica: dalla tendina se c'e', oppure
 * scrivendone la chiave — e questa seconda via non e' un ripiego, perche' un
 * campo puo' esistere sui clienti senza comparire fra quelli in elenco.
 *
 * Il collegamento all'admin esce dall'iframe (`target="_top"`) come gia' fa il
 * nome del cliente in tabella: aperto dentro il riquadro dell'app, l'admin di
 * Shopify non si carica affatto.
 */
export function BirthdateMetafieldCard({
  configured,
  ourDefinitionPresent,
  definitions,
  notADate,
  adminUrl,
}: BirthdateMetafieldCardProps) {
  const t = useT();
  const fetcher = useFetcher<{ ok: boolean; error: 'invalid' | 'failed' | null }>();

  // Il pannello "Metafield esistente" si apre solo se richiesto: chi arriva qui
  // per la prima volta ha davanti un pulsante e una frase, non un modulo.
  const [choosing, setChoosing] = useState(false);
  // Quello che finira' salvato. La tendina lo riempie, la casella lo lascia
  // correggere: un valore solo, e si vede prima di confermarlo.
  const [typed, setTyped] = useState('');
  // L'elenco e' aperto. Vive qui e non dentro il pulsante: sceglierne una voce
  // lo richiude, ed e' il comportamento che ci si aspetta da una tendina.
  const [listOpen, setListOpen] = useState(false);

  const busy = fetcher.state !== 'idle';
  const failed = !busy && fetcher.data?.ok === false;

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

  // Quale voce risulta scelta nell'elenco: solo se quel che c'e' scritto nel
  // campo corrisponde davvero a una definizione del negozio. Chi scrive a mano
  // una chiave che l'elenco non conosce non deve vedersi evidenziare una riga a
  // caso.
  const listed = definitions.some((d) => d.key === typed);
  const activatorLabel = typed || t.customers.birthdate.choosePlaceholder;

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {t.customers.birthdate.title}
        </Text>
        <Text as="p" tone="subdued">
          {t.customers.birthdate.description}
        </Text>

        {/* Cosa si sta leggendo adesso, sempre a schermo: senza, cambiare campo
            sarebbe un gesto al buio. */}
        <Text as="p">
          {configured
            ? t.customers.birthdate.inUse(configured)
            : t.customers.birthdate.noneInUse}
        </Text>

        {notADate && <Banner tone="warning">{t.customers.birthdate.notADate}</Banner>}

        <InlineStack gap="300" blockAlign="center" wrap>
          {ourDefinitionPresent ? (
            <Badge tone="success">{t.customers.birthdate.present}</Badge>
          ) : (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="create" />
              <Button submit variant="primary" loading={busy}>
                {t.customers.birthdate.create}
              </Button>
            </fetcher.Form>
          )}

          {!choosing && (
            <Button onClick={() => setChoosing(true)} disabled={busy}>
              {t.customers.birthdate.useExisting}
            </Button>
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
            <BlockStack gap="300">
              {/* Stessa forma del selettore lingua/valuta in Impostazioni: un
                  pulsante che dice cosa e' scelto adesso e apre un elenco.
                  Scegliere qui non salva niente — riempie il campo qui sotto,
                  cosi' si legge per intero quel che si e' scelto prima di
                  confermarlo. La conferma resta una sola, in fondo. */}
              <Labelled id="birthdate-metafield-choice" label={t.customers.birthdate.chooseLabel}>
                <Popover
                  active={listOpen}
                  preferredPosition="below"
                  preferredAlignment="left"
                  onClose={() => setListOpen(false)}
                  activator={
                    <Button
                      id="birthdate-metafield-choice"
                      onClick={() => setListOpen((open) => !open)}
                      disclosure
                      fullWidth
                      textAlign="left"
                      disabled={busy || definitions.length === 0}
                    >
                      {activatorLabel}
                    </Button>
                  }
                >
                  {/* Come nel selettore delle preferenze: l'elenco scorre da
                      solo e la rotellina, arrivata in fondo, non passa il turno
                      alla pagina sotto. */}
                  <Box minWidth="320px">
                    <div
                      style={{
                        maxHeight: 240,
                        overflowY: 'auto',
                        overscrollBehavior: 'contain',
                      }}
                    >
                      <OptionList
                        sections={sections}
                        selected={listed ? [typed] : []}
                        onChange={(next) => {
                          if (next[0]) setTyped(next[0]);
                          setListOpen(false);
                        }}
                      />
                    </div>
                  </Box>
                </Popover>
              </Labelled>

              {definitions.length === 0 && (
                <Text as="span" tone="subdued" variant="bodySm">
                  {t.customers.birthdate.chooseEmpty}
                </Text>
              )}

              <TextField
                label={t.customers.birthdate.pasteLabel}
                name="metafield"
                value={typed}
                onChange={setTyped}
                autoComplete="off"
                placeholder="custom.data_di_nascita"
                helpText={t.customers.birthdate.pasteHelp}
                error={
                  fetcher.data?.error === 'invalid'
                    ? t.customers.birthdate.invalid
                    : undefined
                }
              />

              <InlineStack gap="300">
                <Button submit variant="primary" loading={busy} disabled={!typed.trim()}>
                  {t.common.confirm}
                </Button>
                <Button
                  onClick={() => {
                    setChoosing(false);
                    setTyped('');
                  }}
                  disabled={busy}
                >
                  {t.common.cancel}
                </Button>
              </InlineStack>
            </BlockStack>
          </fetcher.Form>
        )}

        {failed && fetcher.data?.error !== 'invalid' && (
          <Banner tone="critical">{t.customers.birthdate.failed}</Banner>
        )}
      </BlockStack>
    </Card>
  );
}
