import { useT } from '~/lib/i18n/context';
import { PlanLimitBanner } from './PlanLimitBanner';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFetcher, useRevalidator } from '@remix-run/react';
import {
  Badge,
  Checkbox,
  Modal,
  ActionList,
  BlockStack,
  Box,
  Button,
  Banner,
  Combobox,
  Icon,
  InlineStack,
  Labelled,
  Listbox,
  OptionList,
  Popover,
  Spinner,
  Text,
  TextField,
} from '@shopify/polaris';
import { DeleteIcon, ExchangeIcon, SearchIcon, PlusIcon } from '@shopify/polaris-icons';
import { groupRegionsByContinent } from '~/lib/supabase-regions';

interface SupabaseProject {
  id: string;
  name: string;
  organization_id: string;
  region: string;
}

export interface SupabaseProjectConnectProps {
  /** Un database e' gia' collegato e le tabelle sono pronte. */
  connected: boolean;
  projectName?: string;
  projectUrl?: string;
  // Se true (negozio non ENABLED) tutti i pulsanti d'azione sono disabilitati.
  disabled?: boolean;
  // Stato di autorizzazione: guida il banner nello stato "collegato".
  authorization?: 'ENABLED' | 'PENDING' | 'DISABLED';
  /**
   * Come si presenta a database collegato.
   *
   * `buttons`: il nome del database e sotto i due comandi, come nel passo
   * della configurazione. `menu`: una riga di card — nome a sinistra, valore e
   * una tendina "Gestisci" a destra — per stare fra le righe della card
   * Database, dove due pulsanti in fila spezzerebbero l'incolonnamento.
   */
  variant?: 'buttons' | 'menu';
  /**
   * Il piano Supabase non consente altri database.
   *
   * Chi passa questa funzione si prende in carico l'avviso e lo mette dove
   * serve: in Impostazioni il menu che lo fa comparire vive dentro una card, e
   * il banner deve stare sopra tutte le card. Senza, l'avviso resta qui.
   */
  onPlanLimit?: (info: { planLabel: string | null; billingUrl: string | null }) => void;
  // Disconnessione riuscita: il parent mostra il banner di conferma in cima alla
  // dashboard. Qui non lo si puo' fare, il componente viene rimontato subito dopo.
}

/**
 * Secondo passo: scelta o creazione del database.
 *
 * Arriva a questo punto chi ha gia' fatto l'accesso, quindi l'elenco dei
 * progetti si carica da solo: non ha senso far premere un altro pulsante per
 * vedere qualcosa che a questo punto e' dovuto.
 */
export function SupabaseProjectConnect({
  connected,
  projectName,
  projectUrl,
  disabled,
  authorization = 'ENABLED',
  variant = 'buttons',
  onPlanLimit,
}: SupabaseProjectConnectProps) {
  const t = useT();
  const revalidator = useRevalidator();
  const projectsFetcher = useFetcher<{ projects: SupabaseProject[]; error?: string }>();
  const selectFetcher = useFetcher<{ ok?: boolean; error?: string }>();

  const [selectedRef, setSelectedRef] = useState<string>('');
  const [manageOpen, setManageOpen] = useState(false);
  // Eliminazione dei database non in uso: quali sono spuntati, e se si e' alla
  // domanda finale.
  const [deleting, setDeleting] = useState(false);
  const [deleteRefs, setDeleteRefs] = useState<string[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [query, setQuery] = useState('');

  // Creazione di un nuovo progetto.
  const regionsFetcher = useFetcher<{ regions: { id: string; name: string }[] }>();
  const createFetcher = useFetcher<{
    ok?: boolean;
    ref?: string;
    error?: string;
    code?: string;
    billingUrl?: string | null;
  }>();

  const [showCreate, setShowCreate] = useState(false);
  // Il merchant ha un database collegato ma vuole sceglierne un altro. Finche'
  // non ne conferma uno resta collegato a quello di prima: cambiare non e'
  // scollegare, e nessun dato si muove finche' la scelta non e' fatta.
  const [changing, setChanging] = useState(false);
  const [newName, setNewName] = useState('');
  const [region, setRegion] = useState('eu-central-1');
  // Limiti di progetto del piano Supabase: alimenta il loader sul pulsante di
  // creazione e, a limite raggiunto, il banner + il pulsante verso il billing.
  const limitsFetcher = useFetcher<{
    ok: boolean;
    planLabel: string | null;
    activeProjects: number;
    maxProjects: number | null;
    limitReached: boolean;
    billingUrl: string | null;
    debug: string | null;
  }>();
  const limits = limitsFetcher.data;
  const limitsChecking = limitsFetcher.state !== 'idle';

  // Il limite di piano puo' emergere in due momenti: dal controllo preventivo
  // (solo se lo scope organizations:read e' concesso, altrimenti il piano resta
  // ignoto) oppure dal rifiuto di Supabase alla creazione. Il banner e il
  // pulsante di upgrade valgono in entrambi i casi.
  const planLimitFromCreate = createFetcher.data?.code === 'plan_limit';
  const planLimitHit = Boolean(limits?.limitReached || planLimitFromCreate);
  const planLimitBillingUrl = createFetcher.data?.billingUrl ?? limits?.billingUrl ?? null;

  // Il limite si annuncia quando lo si incontra, non prima.
  //
  // Un banner sempre acceso in cima alla pagina diventa arredamento: si smette
  // di leggerlo dopo due aperture. Compare invece aprendo il menu — cioe'
  // quando si sta cercando come creare un database — e quando Supabase rifiuta
  // davvero una creazione.
  const [limitNoticed, setLimitNoticed] = useState(false);
  // Quando il banner lo rende il chiamante, qui dentro non si rende: in
  // Impostazioni il menu che lo fa comparire vive dentro una card, e l'avviso
  // deve stare sopra tutte — due copie della stessa frase sono due problemi.
  const showLimitBanner = !onPlanLimit && planLimitHit && (limitNoticed || planLimitFromCreate);

  // Il chiamante viene avvisato appena sappiamo che il limite c'e', non solo al
  // clic: cosi' un banner gia' aperto si aggiorna con il nome del piano quando
  // la risposta di Supabase arriva un istante dopo.
  useEffect(() => {
    if (!onPlanLimit || !planLimitFromCreate) return;
    onPlanLimit({ planLabel: limits?.planLabel ?? null, billingUrl: planLimitBillingUrl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planLimitFromCreate, planLimitBillingUrl, limits?.planLabel]);

  const [regionPopoverActive, setRegionPopoverActive] = useState(false);
  // Se la richiesta delle region non arriva mai in porto (rete giù, 500), dopo
  // qualche secondo smettiamo di mostrare il loader e ripieghiamo sulla lista
  // statica: meglio un default utilizzabile di uno spinner infinito.
  const [regionsTimedOut, setRegionsTimedOut] = useState(false);

  const [creatingRef, setCreatingRef] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // La schermata di scelta e' a video: o perche' non c'e' ancora un database, o
  // perche' se ne sta cambiando uno. E' l'unica condizione che conta — dalla
  // sola `connected` l'elenco non veniva mai chiesto a chi premeva "Cambia
  // database", e il riquadro restava a caricare per sempre.
  const choosing = !connected || changing;

  // L'elenco dei progetti si carica appena la scelta e' a video: chi e' qui ha
  // gia' dato il consenso, quindi non c'e' altro da chiedergli.
  // Ogni volta che la scelta si riapre, non solo la prima: chi torna qui dopo
  // aver creato un database lo deve trovare nell'elenco, e chi ne ha cancellato
  // uno da Supabase non deve vederselo ancora offerto.
  useEffect(() => {
    if (!choosing) return;
    if (projectsFetcher.state === 'idle') {
      projectsFetcher.load('/api/supabase/projects');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choosing]);

  useEffect(() => {
    if (!showCreate || regionsFetcher.data || regionsFetcher.state === 'loading') return;
    const timer = setTimeout(() => setRegionsTimedOut(true), 8000);
    return () => clearTimeout(timer);
  }, [showCreate, regionsFetcher.data, regionsFetcher.state]);

  // Loader nel dropdown finché non sono disponibili TUTTE le region: prima
  // mostravamo subito la sola Frankfurt del fallback, dando l'impressione che
  // l'Europa avesse una voce sola.
  const regionsLoading = !regionsFetcher.data && !regionsTimedOut;

  // Fallback usato sia mentre si carica (per l'etichetta del pulsante) sia se
  // la richiesta è andata a vuoto: il form resta utilizzabile.
  const allRegions = regionsFetcher.data?.regions ?? [
    { id: 'eu-central-1', name: 'Central EU (Frankfurt)' },
  ];
  const selectedRegionName = allRegions.find((r) => r.id === region)?.name ?? '';
  const regionGroups = useMemo(
    () => groupRegionsByContinent(allRegions),
    // allRegions deriva da regionsFetcher.data: dipendiamo da quello, non
    // dall'array ricreato a ogni render dal fallback qui sopra.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regionsFetcher.data],
  );

  // Rientro delle opzioni rispetto al titolo di sezione: le voci risultano
  // annidate sotto il continente invece che allineate a filo con esso.
  // Memoizzato perché OptionList confronta le sezioni in profondità.
  const indentedRegionGroups = useMemo(
    () =>
      regionGroups.map((group) => ({
        title: group.title,
        options: group.options.map((option) => ({
          value: option.value,
          label: <Box paddingInlineStart="300">{option.label}</Box>,
        })),
      })),
    [regionGroups],
  );

  const confirmSelection = useCallback(() => {
    selectFetcher.submit(
      { ref: selectedRef },
      { method: 'post', action: '/api/supabase/select-project', encType: 'application/json' },
    );
  }, [selectFetcher, selectedRef]);

  const deleteFetcher = useFetcher<{ ok?: boolean; error?: string }>();

  const closeDelete = useCallback(() => {
    setDeleting(false);
    setConfirmingDelete(false);
    setDeleteRefs([]);
  }, []);

  // Tutti i database dell'account, quello collegato compreso: sta in elenco ma
  // spento, cosi' si vede che c'e' e che non si tocca — sparendo sembrerebbe
  // che l'app non lo veda.
  // I database appena eliminati, tenuti da parte.
  //
  // L'elenco di Supabase impiega qualche istante ad accorgersi di una
  // cancellazione: chiedendolo subito dopo, quello appena eliminato torna
  // ancora indietro. Sceglierlo darebbe un errore incomprensibile, e vederlo
  // fa dubitare che la cancellazione sia andata a buon fine. Qui si toglie
  // subito, senza aspettare che l'elenco si aggiorni da solo.
  const [removedRefs, setRemovedRefs] = useState<string[]>([]);

  const allProjects = (projectsFetcher.data?.projects ?? []).filter(
    (project) => !removedRefs.includes(project.id),
  );

  // Eliminato: l'elenco e i limiti del piano non sono piu' quelli di prima.
  useEffect(() => {
    if (!deleteFetcher.data?.ok) return;
    setDeleting(false);
    setConfirmingDelete(false);
    setRemovedRefs((current) => [...current, ...deleteRefs]);
    setDeleteRefs([]);
    projectsFetcher.load('/api/supabase/projects');
    limitsFetcher.load('/api/supabase/project-limits');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteFetcher.data]);

  // La finestra ha bisogno dell'elenco: aprendola da sola, senza passare dalla
  // scelta del database, quell'elenco non e' ancora stato chiesto.
  useEffect(() => {
    if (deleting && projectsFetcher.state === 'idle' && !projectsFetcher.data) {
      projectsFetcher.load('/api/supabase/projects');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleting]);

  // Scelto il database, il passo si richiude su quello nuovo.
  //
  // Ricaricare il loader non basta: il negozio era gia' collegato prima e lo e'
  // anche adesso, quindi per la pagina non e' cambiato niente e la scelta
  // restava aperta — con "Conferma" di nuovo disponibile, come se il clic non
  // fosse mai avvenuto. La scelta la chiude chi l'ha aperta.
  useEffect(() => {
    if (!selectFetcher.data?.ok) return;
    setChanging(false);
    setShowCreate(false);
    // E si svuota il foglio di brutta: riaprendo "Cambia database" non deve
    // ritrovare selezionato quello di due scelte fa.
    setSelectedRef('');
    setQuery('');
    revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectFetcher.data]);

  const projects = projectsFetcher.data?.projects?.filter(
    (project) => !removedRefs.includes(project.id),
  );
  const projectsLoaded = projectsFetcher.state === 'idle' && projects !== undefined;

  const filtered = useMemo(() => {
    if (!projects) return [];
    const q = query.toLowerCase();
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
  }, [projects, query]);

  const selectedName = projects?.find((p) => p.id === selectedRef)?.name ?? '';

  // Carica le region quando si apre il form.
  useEffect(() => {
    if (showCreate && regionsFetcher.state === 'idle' && !regionsFetcher.data) {
      regionsFetcher.load('/api/supabase/regions');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCreate]);

  // Verifica i limiti del piano appena serve saperlo: il controllo deve essere
  // gia' concluso (o in corso, col suo loader) quando il merchant guarda il
  // pulsante "Crea un nuovo database". Serve in due momenti — mentre sceglie
  // fra i progetti, e a collegamento fatto, dove quel pulsante sta accanto a
  // "Cambia database".
  useEffect(() => {
    if ((projectsLoaded || connected) && limitsFetcher.state === 'idle' && !limitsFetcher.data) {
      limitsFetcher.load('/api/supabase/project-limits');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectsLoaded, connected]);

  // Quando la creazione ritorna il ref si avvia il polling.
  useEffect(() => {
    if (createFetcher.data?.ok && createFetcher.data.ref) {
      setCreatingRef(createFetcher.data.ref);
      setProvisioning(true);
      setCreateError(null);
    } else if (createFetcher.data && createFetcher.data.ok === false) {
      setCreateError(createFetcher.data.error ?? 'Creazione non riuscita.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createFetcher.data]);

  // Polling dello stato del progetto finché è pronto, poi select-project.
  useEffect(() => {
    if (!provisioning || !creatingRef) return;
    let cancelled = false;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (cancelled) return;
      if (Date.now() - started > 3 * 60 * 1000) {
        clearInterval(timer);
        setProvisioning(false);
        setCreateError('Il provisioning ci sta mettendo più del previsto. Riprova tra poco.');
        return;
      }
      try {
        const res = await fetch(
          `/api/supabase/project-status?ref=${encodeURIComponent(creatingRef)}`,
        );
        const data = (await res.json()) as { ready?: boolean };
        if (data.ready && !cancelled) {
          clearInterval(timer);
          setProvisioning(false);

          // Creare un database non vuol dire cominciare a usarlo.
          //
          // Alla prima configurazione si', perche' e' l'unico che c'e' e non
          // c'e' altro da scegliere. Ma da Impostazioni, con uno gia'
          // collegato, crearne un secondo e ritrovarsi la sincronizzazione
          // spostata sopra e' una cosa che nessuno ha chiesto: per spostarla
          // c'e' "Cambia database".
          if (connected) {
            setShowCreate(false);
            setNewName('');
            projectsFetcher.load('/api/supabase/projects');
            limitsFetcher.load('/api/supabase/project-limits');
          } else {
            selectFetcher.submit(
              { ref: creatingRef },
              {
                method: 'post',
                action: '/api/supabase/select-project',
                encType: 'application/json',
              },
            );
          }
        }
      } catch {
        // rete transitoria: riprova al tick successivo
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provisioning, creatingRef, selectFetcher, connected]);

  // La creazione, dal clic al database pronto. Sono due fasi — la richiesta e
  // il provisioning — ma per chi guarda sono una cosa sola, e i campi devono
  // restare spenti per tutte e due.
  const creatingNow = createFetcher.state !== 'idle' || provisioning;

  const submitCreate = useCallback(() => {
    setCreateError(null);
    createFetcher.submit(
      { name: newName, region },
      { method: 'post', action: '/api/supabase/create-project', encType: 'application/json' },
    );
  }, [createFetcher, newName, region]);

  // STATO: database collegato
  if (!choosing) {
    return (
      <BlockStack gap="300">
        {authorization === 'DISABLED' ? (
          <Banner tone="critical">{t.connect.database.syncDisabled}</Banner>
        ) : authorization === 'PENDING' ? (
          <Banner tone="warning">{t.connect.database.syncSuspended}</Banner>
        ) : null}
        {variant === 'menu' ? (
          <InlineStack align="space-between" blockAlign="center" gap="300" wrap={false}>
            <Text as="span" variant="bodyMd">
              {t.connect.database.connectedTo}
            </Text>
            <InlineStack gap="300" blockAlign="center" wrap={false}>
              <Text as="span" tone="subdued" truncate>
                {projectName ?? '—'}
              </Text>
              {/* Una tendina e non due pulsanti: in una card fatta di righe
                  incolonnate, due comandi in fila spostano il valore e rompono
                  la colonna. Le due strade restano entrambe, dentro. */}
              <Popover
                active={manageOpen}
                // Il comando sta all'estremo destro della card: il menu si apre
                // verso l'interno, o sborda dal bordo.
                preferredAlignment="right"
                onClose={() => setManageOpen(false)}
                activator={
                  <Button
                    disclosure
                    onClick={() => {
                      if (planLimitHit) {
                        setLimitNoticed(true);
                        onPlanLimit?.({
                          planLabel: limits?.planLabel ?? null,
                          billingUrl: planLimitBillingUrl,
                        });
                      }
                      setManageOpen((open) => !open);
                    }}
                    loading={limitsChecking}
                    disabled={disabled}
                  >
                    {t.connect.database.manage}
                  </Button>
                }
              >
                <ActionList
                  actionRole="menuitem"
                  sections={[
                    {
                      items: [
                        {
                          content: t.connect.database.create,
                          prefix: <Icon source={PlusIcon} />,
                      // Spento quando il piano Supabase non consente altri
                      // progetti. Il motivo non sta qui sotto: una voce di menu
                      // con due righe di spiegazione fa diventare il menu il
                      // posto dove si legge, invece di quello dove si sceglie.
                      // Lo dice il banner in cima, all'apertura del menu.
                      disabled: limitsChecking || planLimitHit,
                      onAction: () => {
                        setManageOpen(false);
                        setChanging(true);
                        setShowCreate(true);
                      },
                    },
                        {
                          content: t.connect.database.change,
                          prefix: <Icon source={ExchangeIcon} />,
                          onAction: () => {
                            setManageOpen(false);
                            setChanging(true);
                          },
                        },
                      ],
                    },
                    {
                      // Sezione a se': il divisore lo disegna Polaris, e un
                      // gesto irreversibile non deve stare in fila con quelli
                      // che si possono disfare.
                      items: [
                        {
                          content: t.connect.database.deleteProject,
                          prefix: <Icon source={DeleteIcon} tone="critical" />,
                          destructive: true,
                          onAction: () => {
                            setManageOpen(false);
                            setDeleting(true);
                          },
                        },
                      ],
                    },
                  ]}
                />
              </Popover>
            </InlineStack>
            <Modal
              open={deleting && !confirmingDelete}
              onClose={closeDelete}
              title={t.connect.database.deleteTitle}
              primaryAction={{
                content: t.connect.database.deleteConfirm,
                destructive: true,
                disabled: deleteRefs.length === 0,
                // Non elimina: apre la domanda finale, e chiude questa. Due
                // modal aperti insieme non si sovrappongono come sembra: il
                // velo del secondo finisce sotto il riquadro del primo, e la
                // domanda arriva senza niente che la stacchi da cio' che c'e'
                // dietro. Uno alla volta, e annullando si torna qui con la
                // selezione intatta.
                onAction: () => setConfirmingDelete(true),
              }}
              secondaryActions={[
                { content: t.common.cancel, onAction: closeDelete },
              ]}
            >
              <Modal.Section>
                <BlockStack gap="400">
                  <Text as="p">{t.connect.database.deleteIntro}</Text>

                  {deleteFetcher.data?.error && (
                    <Banner tone="critical">{deleteFetcher.data.error}</Banner>
                  )}

                  {/* Finche' l'elenco non e' arrivato non si dice niente.
                      Aprendo la finestra pochi secondi dopo aver collegato
                      l'account, la richiesta e' ancora in volo e `allProjects`
                      e' vuoto: "non hai database da eliminare" era una risposta
                      data prima di aver guardato — e infatti bastava chiudere e
                      riaprire per vederli comparire. */}
                  {!projectsLoaded ? (
                    <Box padding="600">
                      <BlockStack gap="300" inlineAlign="center">
                        <Spinner
                          accessibilityLabel={t.connect.database.loading}
                          size="small"
                        />
                        <Text as="span" tone="subdued">
                          {t.connect.database.loading}
                        </Text>
                      </BlockStack>
                    </Box>
                  ) : allProjects.length === 0 ? (
                    <Text as="p" tone="subdued">
                      {t.connect.database.deleteNone}
                    </Text>
                  ) : (
                    <BlockStack gap="200">
                      {allProjects.map((project) => {
                        const inUse = project.id === projectName;
                        return (
                          <InlineStack
                            key={project.id}
                            gap="200"
                            blockAlign="center"
                            wrap={false}
                          >
                            {/* Spunte e non pallini: i database da eliminare
                                possono essere piu' d'uno. */}
                            <Checkbox
                              label={project.name}
                              helpText={project.id}
                              checked={deleteRefs.includes(project.id)}
                              // Quello in uso resta in elenco, spento: sparendo
                              // sembrerebbe che l'app non lo veda.
                              disabled={inUse}
                              onChange={(checked) =>
                                setDeleteRefs((refs) =>
                                  checked
                                    ? [...refs, project.id]
                                    : refs.filter((ref) => ref !== project.id),
                                )
                              }
                            />
                            {inUse && <Badge>{t.connect.database.inUse}</Badge>}
                          </InlineStack>
                        );
                      })}
                    </BlockStack>
                  )}
                </BlockStack>
              </Modal.Section>
            </Modal>

            {/* La domanda finale, senza niente da riscrivere: a questo punto la
                scelta e' fatta, e quel che serve e' un istante per fermarsi. */}
            <Modal
              open={confirmingDelete}
              onClose={() => setConfirmingDelete(false)}
              title={t.connect.database.deleteConfirmTitle}
              primaryAction={{
                content: t.connect.database.deleteProceed,
                destructive: true,
                loading: deleteFetcher.state !== 'idle',
                disabled: deleteFetcher.state !== 'idle',
                onAction: () => {
                  deleteFetcher.submit(
                    { refs: deleteRefs },
                    {
                      method: 'post',
                      action: '/api/supabase/delete-project',
                      encType: 'application/json',
                    },
                  );
                },
              }}
              secondaryActions={[
                {
                  content: t.common.cancel,
                  // Torna alla scelta, che e' rimasta com'era.
                  onAction: () => setConfirmingDelete(false),
                  disabled: deleteFetcher.state !== 'idle',
                },
              ]}
            >
              <Modal.Section>
                <BlockStack gap="300">
                  <Text as="p">
                    {t.connect.database.deleteConfirmBody(deleteRefs.length)}
                  </Text>
                  <Text as="p" fontWeight="semibold">
                    {allProjects
                      .filter((project) => deleteRefs.includes(project.id))
                      .map((project) => project.name)
                      .join(', ')}
                  </Text>
                </BlockStack>
              </Modal.Section>
            </Modal>
          </InlineStack>
        ) : (
          <>
        {projectName && (
          <Text as="p" tone="subdued">
            {t.connect.database.connectedTo} <strong>{projectName}</strong>
          </Text>
        )}
        <InlineStack gap="200">
          {/* Crearne uno nuovo viene prima: e' la strada di chi non ha ancora
              il database che gli serve. Spento quando il piano Supabase non
              consente altri progetti — resta al suo posto per dire cosa non si
              puo' fare, invece di sparire senza spiegazioni. */}
          <Button
            icon={PlusIcon}
            onClick={() => {
              setChanging(true);
              setShowCreate(true);
            }}
            loading={limitsChecking}
            disabled={disabled || limitsChecking || planLimitHit}
          >
            {t.connect.database.create}
          </Button>
          {/* Cambiare database non e' scollegarsi: si torna alla scelta, e
              quello di adesso resta collegato finche' non se ne conferma un
              altro. Scollegarsi e' un'altra cosa e sta nel passo sopra, con
              l'account. */}
          <Button onClick={() => setChanging(true)} disabled={disabled}>
            {t.connect.database.change}
          </Button>
        </InlineStack>
          </>
        )}

      </BlockStack>
    );
  }

  return (
    <BlockStack gap="300">
      {showLimitBanner && (
        <PlanLimitBanner
          planLabel={limits?.planLabel ?? null}
          billingUrl={planLimitBillingUrl}
          onDismiss={() => setLimitNoticed(false)}
        />
      )}

      {projectsFetcher.data?.error && (
        <Banner tone="critical">{projectsFetcher.data.error}</Banner>
      )}

      {/* Non mentre si sta creando: li' l'elenco viene ricaricato in sottofondo
          per accogliere il database nuovo, e "Caricamento database" comparso
          sopra il modulo di creazione sembra parlare di quello che si sta
          creando — come se stesse per finire, mentre invece deve ancora
          cominciare. */}
      {!projectsLoaded && !showCreate && (
        <InlineStack gap="200" blockAlign="center">
          <Spinner accessibilityLabel={t.connect.database.loading} size="small" />
          <Text as="span" tone="subdued">
            {t.connect.database.loading}
          </Text>
        </InlineStack>
      )}

      {projectsLoaded && projects && projects.length === 0 && (
        <Banner tone="warning">
          {t.connect.database.none}
        </Banner>
      )}

      {/* La scelta fra i database esistenti sparisce mentre se ne sta creando
          uno nuovo: sono due strade alternative, e chi ha appena premuto "Crea"
          non ha piu' niente da scegliere li' dentro. Compariva perche' la
          condizione guardava solo quanti progetti esistono — e un progetto,
          appena creato, esiste. Si torna alla scelta con "Annulla". */}
      {projectsLoaded && projects && projects.length > 0 && !showCreate && (
        // 65% e non meta': i nomi dei progetti Supabase sono lunghi e a meta'
        // riga finivano troncati proprio dove il merchant deve distinguerli.
        <Box maxWidth="65%">
          <Combobox
            activator={
              <Combobox.TextField
                prefix={<Icon source={SearchIcon} />}
                onChange={(v) => {
                  setQuery(v);
                  // Ricominciare a digitare annulla la selezione, così il
                  // campo mostra ciò che si sta cercando e la lista si rifiltra.
                  if (selectedRef) setSelectedRef('');
                }}
                label={t.connect.database.label}
                value={selectedRef ? selectedName : query}
                placeholder={t.connect.database.placeholder}
                autoComplete="off"
                // Con una scelta fatta il campo non si puo' piu' svuotare
                // scrivendoci dentro: la "x" e' l'unico modo per tornare
                // indietro e poter creare un progetto nuovo.
                clearButton={Boolean(selectedRef || query)}
                onClearButtonClick={() => {
                  setSelectedRef('');
                  setQuery('');
                }}
              />
            }
          >
            {filtered.length > 0 ? (
              <Listbox
                onSelect={(value) => {
                  setSelectedRef(value);
                  setQuery('');
                }}
              >
                {filtered.map((p) => (
                  <Listbox.Option key={p.id} value={p.id} selected={p.id === selectedRef}>
                    {p.name}
                  </Listbox.Option>
                ))}
              </Listbox>
            ) : null}
          </Combobox>
        </Box>
      )}

      {projectsLoaded && projects && !showCreate && (
        // Disconnessione SEMPLICE in entrambi i rami: qui non è stato creato né
        // collegato alcun database, quindi non c'è nulla da eliminare — si
        // scollega e basta, senza il modal "mantieni/elimina dati".
        <InlineStack gap="300" blockAlign="center">
          {/* Con un database scelto la conferma e' l'azione principale, ma la
              creazione resta al suo posto accanto: sono due strade, e la
              seconda non deve sparire solo perche' si e' data un'occhiata alla
              prima. Prima si nascondeva, e per riaverla bisognava sapere che la
              "x" nel campo la faceva tornare. */}
          {selectedRef && (
            <Button
              variant="primary"
              onClick={confirmSelection}
              loading={selectFetcher.state !== 'idle'}
              disabled={disabled}
            >
              {t.common.confirm}
            </Button>
          )}
          {/* A limite raggiunto il comando resta al suo posto, spento: dice
              cosa non si puo' fare e perche' — l'avviso qui sopra porta gia'
              all'aggiornamento del piano. */}
          <Button
            // Icona di Polaris e non l'emoji: l'emoji ha colori propri e
            // restava nera a pulsante spento, come se quella parte fosse
            // ancora attiva. L'icona segue lo stato del comando.
            icon={PlusIcon}
            onClick={() => setShowCreate(true)}
            // Loader finché non sappiamo se il piano consente un altro progetto.
            loading={limitsChecking}
            disabled={disabled || limitsChecking || planLimitHit}
          >
            {t.connect.database.create}
          </Button>
          {/* Chi sta cambiando database e' gia' collegato: qui non ha niente da
              scollegare, ha solo da poter tornare indietro. Scollegarsi si fa
              dal passo sopra, dov'e' l'account. */}
          {changing && (
            <Button
              onClick={() => {
                setChanging(false);
                setShowCreate(false);
              }}
              disabled={disabled}
            >
              {t.common.cancel}
            </Button>
          )}
        </InlineStack>
      )}

      {showCreate && (
        // Larghezza fissa invece del 50% del contenitore: il pulsante region
        // risultava lunghissimo e il popover, che si dimensiona sul contenuto,
        // sembrava scollegato. Con una larghezza contenuta i due combaciano.
        <Box maxWidth="420px">
          <BlockStack gap="300">
            {/* Nome e region si spengono appena parte la creazione: quello che
                si scrive li' dopo non arriva da nessuna parte — la richiesta e'
                gia' partita con i valori di prima — e un campo che accetta
                testo mentre l'operazione e' in corso promette una modifica che
                non avverra'. */}
            <TextField
              label={t.connect.database.newName}
              value={newName}
              onChange={setNewName}
              disabled={disabled || creatingNow}
              autoComplete="off"
            />
            {/* Popover + OptionList, non <Select>: quest'ultimo rende un <select>
                nativo, quindi il menu aperto sarebbe quello del sistema operativo.
                L'attivatore e' un Button con disclosure, cosi' si legge come un
                select e non come un campo di testo. OptionList da' gia' i titoli di
                sezione in grassetto (Text headingSm) con le opzioni in peso normale,
                e non disegna divider: nessun bordo dopo l'ultima sezione. */}
            <Labelled id="region-select" label={t.connect.database.region}>
              <Popover
                active={regionPopoverActive}
                // Popover largo quanto l'attivatore: pulsante e menu combaciano.
                fullWidth
                // Sotto al campo, non sopra. L'altezza fissa del Pane serve
                // proprio a questo: un popover corto entra nello spazio
                // disponibile, quindi Polaris non e' costretto a ribaltarlo in
                // alto quando il form sta in fondo alla pagina.
                preferredPosition="below"
                onClose={() => setRegionPopoverActive(false)}
                activator={
                  <Button
                    id="region-select"
                    onClick={() => setRegionPopoverActive((active) => !active)}
                    disclosure
                    fullWidth
                    textAlign="left"
                    disabled={disabled || creatingNow}
                  >
                    {selectedRegionName || t.connect.database.regionPlaceholder}
                  </Button>
                }
              >
                <Popover.Pane height="280px">
                  {regionsLoading ? (
                    <Box padding="600">
                      <BlockStack gap="300" inlineAlign="center">
                        <Spinner accessibilityLabel={t.connect.database.regionsLoading} size="small" />
                        <Text as="span" tone="subdued">
                          {t.connect.database.regionsLoading}
                        </Text>
                      </BlockStack>
                    </Box>
                  ) : (
                    <OptionList
                      sections={indentedRegionGroups}
                      selected={[region]}
                      onChange={(selected) => {
                        if (selected[0]) setRegion(selected[0]);
                        setRegionPopoverActive(false);
                      }}
                    />
                  )}
                </Popover.Pane>
              </Popover>
            </Labelled>
            {createError && <Banner tone="critical">{createError}</Banner>}
            {/* Il messaggio compare dal primo istante e non dal provisioning:
                fra il clic e la risposta della creazione passa qualche secondo,
                e in quel buco non c'era niente a dire che stesse succedendo
                qualcosa. */}
            {creatingNow ? (
              <InlineStack gap="200" blockAlign="center">
                <Spinner accessibilityLabel={t.connect.database.creating} size="small" />
                <Text as="span">
                  {t.connect.database.creating}
                </Text>
              </InlineStack>
            ) : (
              <InlineStack gap="200">
                <Button
                  variant="primary"
                  onClick={submitCreate}
                  loading={createFetcher.state !== 'idle'}
                  disabled={!newName || disabled}
                >
                  Crea database
                </Button>
                <Button onClick={() => setShowCreate(false)}>{t.common.cancel}</Button>
              </InlineStack>
            )}
          </BlockStack>
        </Box>
      )}

      {selectedRef && selectFetcher.data?.error && (
        <Banner tone="critical">{selectFetcher.data.error}</Banner>
      )}
    </BlockStack>
  );
}
