import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useFetcher, useLoaderData } from '@remix-run/react';
import { useAppBridge } from '@shopify/app-bridge-react';
import { useState, useEffect } from 'react';
import {
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  InlineGrid,
  Page,
} from '@shopify/polaris';
import { prisma } from '~/db.server';
import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import { requireShopCapability } from '~/lib/authz/require-capability.server';
import { useLocale, useT } from '~/lib/i18n/context';
import { authenticate } from '~/shopify.server';
import { syncShippingZones } from '~/lib/shipping/sync-zones.server';
import { recomputeLogisticsAfterSave, type NumbersRefresh } from '~/lib/shipping/recompute-inline.server';
import { enqueueShippingMethodBackfill } from '~/lib/shipping/shipping-method-backfill-enqueue.server';
import { loadShippingPageData } from '~/lib/shipping/page-data.server';
import { parseBrackets } from '~/components/Shipping/brackets';
import {
  deleteCategory,
  deleteRule,
  saveCategory,
  saveRule,
  type PackagingEditResult,
} from '~/components/Shipping/packaging-edit';
import { readPackaging, writePackaging } from '~/lib/shipping/packaging-store.server';
import { parseOptionBrackets } from '~/components/Shipping/option-cost';
import { feedbackFromActionData, type ShippingIntent } from '~/components/Shipping/feedback';
import { ShippingZonesTable } from '~/components/Shipping/ShippingZonesTable';
import { EditZoneModal } from '~/components/Shipping/EditZoneModal';
import { EditOptionModal } from '~/components/Shipping/EditOptionModal';
import { PackagingCategoriesCard } from '~/components/Shipping/PackagingCategoriesCard';
import { PackagingRulesCard, describeRuleWeight } from '~/components/Shipping/PackagingRulesCard';
import { PackagingDefaultsCard } from '~/components/Shipping/PackagingDefaultsCard';
import { CategoryModal, ConfirmDeleteModal, RuleModal } from '~/components/Shipping/PackagingModals';
import type { RateBracket, PackagingCategory, OptionCostType, OptionBracket } from '~/lib/shipping/types';

/** La modale aperta sulle tabelle di imballo, una alla volta. */
type PackagingDialog =
  | { kind: 'category'; category: PackagingCategory | null }
  | { kind: 'delete-category'; category: PackagingCategory }
  | { kind: 'rule'; index: number | null }
  | { kind: 'delete-rule'; index: number };
import { Decimal } from '@prisma/client/runtime/library';

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, shop } = await requireShopCapability(request, 'use_app', {
    onDenied: 'redirect',
  });
  await requireSetupComplete(session.shop);

  // Zone, tariffe e packaging. Con le tabelle owner non ancora migrate la
  // pagina si apre vuota invece di rispondere 500 (vedi page-data.server).
  return json(await loadShippingPageData(shop.id));
}

/**
 * La risposta dell'azione, sempre con l'intento a cui risponde.
 *
 * La pagina usa un fetcher solo per tutte le azioni, e quando la risposta arriva
 * `fetcher.formData` e' gia' stato azzerato da Remix: l'intento va rimandato
 * qui, o il client non sa quale toast mostrare (vedi feedback.ts).
 */
function risposta(
  intent: ShippingIntent | null,
  esito: { success: true; numbers?: NumbersRefresh } | { success: false; error: string },
) {
  // `numbers` solo quando c'e' qualcosa da dire: una risposta senza ricalcolo
  // resta identica a prima.
  const { numbers, ...resto } = esito as { numbers?: NumbersRefresh };
  const corpo = numbers ? { intent, ...resto, numbers } : { intent, ...resto };
  return json(corpo as { intent: ShippingIntent | null; success: boolean; error?: string; numbers?: NumbersRefresh });
}

/**
 * Un importo facoltativo dal form: null se assente, NaN se non e' un numero
 * finito e non negativo. `Number.isFinite` e non `isNaN`: "Infinity" passa
 * `parseFloat` e farebbe fallire il Decimal con un 500.
 */
function importoFacoltativo(valore: string | undefined): number | null {
  if (valore === undefined || valore === '') return null;
  const n = parseFloat(valore);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

/** Una posizione nell'elenco delle regole: solo cifre, o null. */
function indiceRegola(valore: string | undefined): number | null {
  return valore !== undefined && /^\d+$/.test(valore) ? Number(valore) : null;
}

/**
 * Applica una modifica di una riga (categoria o regola) alla configurazione
 * salvata, la riscrive se passa e solo allora ricalcola i costi sugli ordini.
 */
async function modificaPackaging(
  shopId: string,
  intent: ShippingIntent,
  modifica: (attuale: Awaited<ReturnType<typeof readPackaging>>) => PackagingEditResult,
) {
  const esito = modifica(await readPackaging(shopId));
  if (esito.error !== null) return risposta(intent, { success: false, error: esito.error });
  await writePackaging(shopId, esito.value);
  const numbers = await recomputeLogisticsAfterSave(shopId);
  return risposta(intent, { success: true, numbers });
}

/*
 * NIENTE `export const config = { maxDuration }` QUI, e non per dimenticanza.
 * La configurazione per rotta la legge solo il preset Vercel di Remix
 * (`vercelPreset()` da `@vercel/remix`), che questo progetto non usa:
 * vite.config.ts monta il plugin di Remix nudo, e Vercel impacchetta l'app in
 * una funzione sola. Un `config` esportato qui verrebbe ignorato in silenzio,
 * cioe' dichiarerebbe un tetto che non esiste.
 *
 * Vale quindi il tetto di default del progetto, lo stesso su cui contano i job
 * della coda (MAX_RUN_MS, 270 s). Il ricalcolo nel salvataggio sta molto sotto:
 * INLINE_RECOMPUTE_BUDGET_MS (15 s) e, come interruzione dura,
 * INLINE_RECOMPUTE_MAX_RUN_MS (45 s), in recompute-inline.server.ts.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { session, shop } = await requireShopCapability(request, 'use_app', {
    onDenied: 'redirect',
  });
  await requireSetupComplete(session.shop);

  const formData = await request.formData();
  const intent = formData.get('intent')?.toString();

  if (intent === 'sync-zones') {
    try {
      // Re-authenticate to get the admin object with graphql method
      const { admin } = await authenticate.admin(request);
      await syncShippingZones(admin, shop.id);
    } catch (error) {
      const isScopeError =
        error instanceof Error && error.message.includes('read_shipping');
      return risposta('sync-zones', {
        success: false,
        error: isScopeError ? 'scope_error' : 'sync_error',
      });
    }

    // L'importazione puo' cambiare i paesi di una zona o quale zona fa da
    // resto del mondo: i costi gia' scritti sugli ordini vanno rifatti come
    // dopo un salvataggio delle tariffe. Non solleva mai (vedi
    // recompute-inline.server): le zone sono gia' salvate comunque.
    const numbers = await recomputeLogisticsAfterSave(shop.id);

    // Le opzioni appena importate raggiungono solo gli ordini che sanno quale
    // opzione ha scelto il cliente: quelli scritti prima dello schema 13 non
    // lo sanno. Il recupero lo chiede a Shopify in sottofondo e alla fine
    // ricalcola. Idempotente e deduplicato: reimportare non costa niente se
    // lo storico e' gia' completo. Non solleva mai.
    //
    // DOPO il ricalcolo, non prima: l'accodamento sveglia la coda con
    // un'autochiamata che spesso prende il lucchetto del negozio per prima, e
    // il ricalcolo qui sopra tornerebbe 'occupato' proprio al primo import.
    await enqueueShippingMethodBackfill(shop.id);

    return risposta('sync-zones', { success: true, numbers });
  }

  if (intent === 'save-zone-rates') {
    const zoneId = formData.get('zoneId')?.toString();
    const rateType = formData.get('rateType')?.toString();

    if (!zoneId || (rateType !== 'linear' && rateType !== 'brackets')) {
      return risposta('save-zone-rates', { success: false, error: 'invalid_request' });
    }

    // Verifica che la zona appartenga a questo shop
    const zone = await prisma.shippingZone.findFirst({
      where: { id: zoneId, shopId: shop.id },
    });

    if (!zone) {
      return risposta('save-zone-rates', { success: false, error: 'zone_not_found' });
    }

    if (rateType === 'linear') {
      const cost = importoFacoltativo(formData.get('costPerKg')?.toString());

      if (cost === null || Number.isNaN(cost)) {
        return risposta('save-zone-rates', { success: false, error: 'shipping.errors.invalidLinearCost' });
      }

      // Sostituisci le tariffe in una transazione
      await prisma.$transaction([
        prisma.shippingRate.deleteMany({ where: { zoneId } }),
        prisma.shippingZone.update({
          where: { id: zoneId },
          data: { rateType: 'linear' },
        }),
        prisma.shippingRate.create({
          data: {
            zoneId,
            weightFrom: null,
            weightTo: null,
            cost: new Decimal(cost),
          },
        }),
      ]);
    } else {
      // Il JSON malformato o con tipi sbagliati torna come errore di
      // validazione, non come eccezione: il merchant vede il motivo nella
      // modale invece di una pagina di errore.
      const parsed = parseBrackets(formData.get('brackets')?.toString());
      if (parsed.error !== null) {
        return risposta('save-zone-rates', { success: false, error: parsed.error });
      }
      const brackets: RateBracket[] = parsed.brackets;

      // Sostituisci le tariffe in una transazione
      await prisma.$transaction([
        prisma.shippingRate.deleteMany({ where: { zoneId } }),
        prisma.shippingZone.update({
          where: { id: zoneId },
          data: { rateType: 'brackets' },
        }),
        ...brackets.map((bracket) =>
          prisma.shippingRate.create({
            data: {
              zoneId,
              weightFrom: bracket.weightFromKg !== null ? new Decimal(bracket.weightFromKg) : null,
              weightTo: bracket.weightToKg !== null ? new Decimal(bracket.weightToKg) : null,
              cost: new Decimal(bracket.cost),
            },
          }),
        ),
      ]);
    }

    // I costi sugli ordini si ricalcolano adesso, cosi' Dashboard e Clienti
    // mostrano gia' i numeri nuovi; oltre il budget il resto va in coda.
    const numbers = await recomputeLogisticsAfterSave(shop.id);

    return risposta('save-zone-rates', { success: true, numbers });
  }

  if (intent === 'save-category') {
    const originalName = formData.get('originalName')?.toString() || null;
    const name = formData.get('name')?.toString() ?? '';
    // Il costo e' obbligatorio: vuoto vale come non valido, non come zero.
    const cost = importoFacoltativo(formData.get('cost')?.toString()) ?? Number.NaN;
    return modificaPackaging(shop.id, 'save-category', (attuale) =>
      saveCategory(attuale, originalName, { name, cost }),
    );
  }

  if (intent === 'delete-category') {
    const name = formData.get('name')?.toString() ?? '';
    return modificaPackaging(shop.id, 'delete-category', (attuale) => deleteCategory(attuale, name));
  }

  if (intent === 'save-rule') {
    const indexRaw = formData.get('index')?.toString();
    const index = indiceRegola(indexRaw);
    if (indexRaw && index === null) {
      return risposta('save-rule', { success: false, error: 'shipping.packaging.errors.ruleNotFound' });
    }
    const category = formData.get('category')?.toString() ?? '';
    // Peso vuoto = "tutto il resto"; un peso non valido arriva come NaN e lo
    // rifiuta la validazione.
    const weightRaw = formData.get('weightMaxKg')?.toString();
    const weightMaxKg = weightRaw === undefined || weightRaw === '' ? null : Number(weightRaw);
    return modificaPackaging(shop.id, 'save-rule', (attuale) =>
      saveRule(attuale, index, { weightMaxKg, category }),
    );
  }

  if (intent === 'delete-rule') {
    const index = indiceRegola(formData.get('index')?.toString());
    if (index === null) {
      return risposta('delete-rule', { success: false, error: 'shipping.packaging.errors.ruleNotFound' });
    }
    return modificaPackaging(shop.id, 'delete-rule', (attuale) => deleteRule(attuale, index));
  }

  if (intent === 'save-packaging-defaults') {
    const defaultWeight = importoFacoltativo(formData.get('defaultWeightPerItemKg')?.toString());
    const returnCost = importoFacoltativo(formData.get('returnCost')?.toString());

    if (defaultWeight !== null && Number.isNaN(defaultWeight)) {
      return risposta('save-packaging-defaults', {
        success: false,
        error: 'shipping.packaging.errors.invalidDefaultWeight',
      });
    }
    if (returnCost !== null && Number.isNaN(returnCost)) {
      return risposta('save-packaging-defaults', {
        success: false,
        error: 'shipping.packaging.errors.invalidReturnCost',
      });
    }

    // Solo questi due campi: categorie e regole hanno il loro salvataggio.
    const data = {
      defaultWeightPerItem: defaultWeight !== null ? new Decimal(defaultWeight) : null,
      returnCost: returnCost !== null ? new Decimal(returnCost) : null,
    };
    await prisma.packagingConfig.upsert({
      where: { shopId: shop.id },
      create: { shopId: shop.id, ...data },
      update: data,
    });

    const numbers = await recomputeLogisticsAfterSave(shop.id);

    return risposta('save-packaging-defaults', { success: true, numbers });
  }

  if (intent === 'save-option-cost') {
    const optionId = formData.get('optionId')?.toString();
    const costType = formData.get('costType')?.toString();

    if (!optionId || !costType) {
      return risposta('save-option-cost', { success: false, error: 'invalid_request' });
    }

    if (costType !== 'flat' && costType !== 'linear' && costType !== 'weight_brackets' && costType !== 'value_brackets') {
      return risposta('save-option-cost', { success: false, error: 'invalid_request' });
    }

    // Verifica che l'opzione appartenga a una zona di questo shop (ownership)
    const option = await prisma.shippingOption.findFirst({
      where: { id: optionId },
      include: { zone: true },
    });

    if (!option || option.zone.shopId !== shop.id) {
      return risposta('save-option-cost', { success: false, error: 'option_not_found' });
    }

    if (costType === 'flat' || costType === 'linear') {
      const costField = costType === 'flat' ? 'flatCost' : 'linearCost';
      const cost = importoFacoltativo(formData.get(costField)?.toString());

      if (cost === null || Number.isNaN(cost)) {
        // Ogni tipo ha il suo messaggio: il merchant legge l'errore sotto il
        // campo che ha compilato, fisso o al kg.
        const error = costType === 'flat' ? 'shipping.errors.invalidFlatCost' : 'shipping.errors.invalidLinearCost';
        return risposta('save-option-cost', { success: false, error });
      }

      // Sostituisci le tariffe in una transazione
      await prisma.$transaction([
        prisma.shippingOptionRate.deleteMany({ where: { optionId } }),
        // Salvare conferma l'opzione: da qui in poi il suo costo vale sugli
        // ordini al posto della tariffa della zona.
        prisma.shippingOption.update({
          where: { id: optionId },
          data: { costType, confirmed: true },
        }),
        prisma.shippingOptionRate.create({
          data: {
            optionId,
            rangeFrom: null,
            rangeTo: null,
            cost: new Decimal(cost),
          },
        }),
      ]);
    } else {
      // weight_brackets o value_brackets
      const parsed = parseOptionBrackets(costType, formData.get('brackets')?.toString());
      if (parsed.error !== null) {
        return risposta('save-option-cost', { success: false, error: parsed.error });
      }
      const brackets: OptionBracket[] = parsed.brackets;

      // Sostituisci le tariffe in una transazione
      await prisma.$transaction([
        prisma.shippingOptionRate.deleteMany({ where: { optionId } }),
        // Salvare conferma l'opzione: da qui in poi il suo costo vale sugli
        // ordini al posto della tariffa della zona.
        prisma.shippingOption.update({
          where: { id: optionId },
          data: { costType, confirmed: true },
        }),
        ...brackets.map((bracket) =>
          prisma.shippingOptionRate.create({
            data: {
              optionId,
              rangeFrom: bracket.from !== null ? new Decimal(bracket.from) : null,
              rangeTo: bracket.to !== null ? new Decimal(bracket.to) : null,
              cost: new Decimal(bracket.cost),
            },
          }),
        ),
      ]);
    }

    // Come per le tariffe di zona: ricalcolo adesso, coda oltre il budget.
    const numbers = await recomputeLogisticsAfterSave(shop.id);

    return risposta('save-option-cost', { success: true, numbers });
  }

  return risposta(null, { success: false, error: 'unknown_intent' });
}

export default function ShippingPage() {
  const { zones, packaging } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const t = useT();
  const locale = useLocale();

  const [packagingDialog, setPackagingDialog] = useState<PackagingDialog | null>(null);
  // L'errore del server sulla riga in modifica: la modale resta aperta e lo mostra.
  const [packagingServerError, setPackagingServerError] = useState<string | null>(null);

  const [editingZone, setEditingZone] = useState<typeof zones[0] | null>(null);
  // L'errore del server sulla zona in modifica: la modale resta aperta e lo mostra.
  const [zoneServerError, setZoneServerError] = useState<string | null>(null);

  const [editingOption, setEditingOption] = useState<{ option: typeof zones[0]['options'][0]; zone: typeof zones[0] } | null>(null);
  // L'errore del server sull'opzione in modifica: la modale resta aperta e lo mostra.
  const [optionServerError, setOptionServerError] = useState<string | null>(null);

  // Il toast e' quello dell'admin (App Bridge), non il Toast di Polaris: quello
  // vuole un <Frame> attorno alla pagina, e senza butta giu' tutta la pagina
  // proprio nel momento in cui dovrebbe dire che e' andato tutto bene.
  const shopify = useAppBridge();

  // Durante l'invio `fetcher.formData` c'e' ancora: e' la risposta che non ce
  // l'ha piu' (vedi feedback.ts).
  const intentInCorso =
    fetcher.state !== 'idle' ? (fetcher.formData as FormData | undefined)?.get('intent') : undefined;
  const isSyncing = intentInCorso === 'sync-zones';
  const isSavingDefaults = intentInCorso === 'save-packaging-defaults';
  const isSavingPackagingRow =
    intentInCorso === 'save-category' ||
    intentInCorso === 'delete-category' ||
    intentInCorso === 'save-rule' ||
    intentInCorso === 'delete-rule';
  const isSavingZone = intentInCorso === 'save-zone-rates';
  const isSavingOption = intentInCorso === 'save-option-cost';

  // Cosa mostrare, deciso dalla risposta (con il suo intento) e non dal form.
  const feedback = fetcher.state === 'idle' ? feedbackFromActionData(fetcher.data, t) : null;

  // Una volta per risposta: `fetcher.data` e' un oggetto nuovo a ogni risposta.
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    const esito = feedbackFromActionData(fetcher.data, t);
    if (esito.toast) shopify.toast.show(esito.toast.content, { isError: esito.toast.error });
    if (esito.zoneSaved) {
      setEditingZone(null);
      setZoneServerError(null);
    } else if (esito.zoneError) {
      setZoneServerError(esito.zoneError);
    }
    if (esito.optionSaved) {
      setEditingOption(null);
      setOptionServerError(null);
    } else if (esito.optionError) {
      setOptionServerError(esito.optionError);
    }
    if (esito.packagingSaved) {
      setPackagingDialog(null);
      setPackagingServerError(null);
    } else if (esito.packagingError) {
      setPackagingServerError(esito.packagingError);
    }
    // `t` resta fuori di proposito: cambiare lingua non e' una risposta nuova,
    // e non deve rimostrare il toast dell'ultima azione.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const handleSync = () => {
    fetcher.submit({ intent: 'sync-zones' }, { method: 'post' });
  };

  const handleEdit = (zone: typeof zones[0]) => {
    setZoneServerError(null);
    setEditingZone(zone);
  };

  const handleModalClose = () => {
    setZoneServerError(null);
    setEditingZone(null);
  };

  const handleModalSave = (data: { rateType: 'linear' | 'brackets'; costPerKg?: string; brackets?: RateBracket[] }) => {
    if (!editingZone) return;

    const formData = new FormData();
    formData.append('intent', 'save-zone-rates');
    formData.append('zoneId', editingZone.id);
    formData.append('rateType', data.rateType);

    if (data.rateType === 'linear' && data.costPerKg) {
      formData.append('costPerKg', data.costPerKg);
    } else if (data.rateType === 'brackets' && data.brackets) {
      formData.append('brackets', JSON.stringify(data.brackets));
    }

    // La modale NON si chiude qui: si chiude quando il server conferma, e resta
    // aperta con il motivo se rifiuta (vedi l'effetto sopra).
    setZoneServerError(null);
    fetcher.submit(formData, { method: 'post' });
  };

  const handleEditOption = (option: typeof zones[0]['options'][0], zone: typeof zones[0]) => {
    setOptionServerError(null);
    setEditingOption({ option, zone });
  };

  const handleOptionModalClose = () => {
    setOptionServerError(null);
    setEditingOption(null);
  };

  const handleOptionModalSave = (data: {
    costType: OptionCostType;
    flatCost?: string;
    linearCost?: string;
    brackets?: OptionBracket[];
  }) => {
    if (!editingOption) return;

    const formData = new FormData();
    formData.append('intent', 'save-option-cost');
    formData.append('optionId', editingOption.option.id);
    formData.append('costType', data.costType);

    if (data.costType === 'flat' && data.flatCost) {
      formData.append('flatCost', data.flatCost);
    } else if (data.costType === 'linear' && data.linearCost) {
      formData.append('linearCost', data.linearCost);
    } else if ((data.costType === 'weight_brackets' || data.costType === 'value_brackets') && data.brackets) {
      formData.append('brackets', JSON.stringify(data.brackets));
    }

    // La modale NON si chiude qui: si chiude quando il server conferma, e resta
    // aperta con il motivo se rifiuta (vedi l'effetto sopra).
    setOptionServerError(null);
    fetcher.submit(formData, { method: 'post' });
  };

  const openPackagingDialog = (dialog: PackagingDialog) => {
    setPackagingServerError(null);
    setPackagingDialog(dialog);
  };

  const closePackagingDialog = () => {
    setPackagingServerError(null);
    setPackagingDialog(null);
  };

  /** Invia una modifica di riga; la modale si chiude solo quando il server conferma. */
  const submitPackaging = (fields: Record<string, string>) => {
    setPackagingServerError(null);
    fetcher.submit(fields, { method: 'post' });
  };

  const handleDefaultsSave = (data: { defaultWeightPerItemKg: string; returnCost: string }) => {
    fetcher.submit({ intent: 'save-packaging-defaults', ...data }, { method: 'post' });
  };

  const packagingCurrent = { categories: packaging.categories, rules: packaging.fallbackRules };

  // Il banner del permesso mancante arriva dalla risposta del fetcher, come
  // l'importazione che lo provoca; resta finche' non arriva un'altra risposta.
  const scopeError = feedback?.scopeError ?? false;

  return (
    <Page
      // A tutta larghezza come la dashboard: zone e categorie sono tabelle, e
      // nella larghezza stretta dei cataloghi i nomi delle opzioni andavano a
      // capo.
      fullWidth
      title={t.shipping.title}
      primaryAction={
        zones.length > 0
          ? {
              content: t.shipping.sync,
              onAction: handleSync,
              loading: isSyncing,
            }
          : undefined
      }
    >
      <BlockStack gap="500">
        {scopeError && (
          <Banner tone="critical" title={t.shipping.scopeError} />
        )}

        {zones.length === 0 ? (
          <Card>
            <EmptyState
              heading={t.shipping.empty.title}
              image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
            >
              <p>{t.shipping.empty.description}</p>
              <Button variant="primary" onClick={handleSync} loading={isSyncing}>
                {t.shipping.empty.action}
              </Button>
            </EmptyState>
          </Card>
        ) : (
          <>
            {/* Riga 1: Categorie di imballo + Regole per peso */}
            <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
              <PackagingCategoriesCard
                categories={packaging.categories}
                onAdd={() => openPackagingDialog({ kind: 'category', category: null })}
                onEdit={(category) => openPackagingDialog({ kind: 'category', category })}
                onDelete={(category) => openPackagingDialog({ kind: 'delete-category', category })}
              />
              <PackagingRulesCard
                rules={packaging.fallbackRules}
                hasCategories={packaging.categories.length > 0}
                onAdd={() => openPackagingDialog({ kind: 'rule', index: null })}
                onEdit={(index) => openPackagingDialog({ kind: 'rule', index })}
                onDelete={(index) => openPackagingDialog({ kind: 'delete-rule', index })}
              />
            </InlineGrid>

            {/* Riga 2: Prezzi di spedizione + Peso di default e costo resi */}
            <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
              <BlockStack>
                <Card padding="0">
                  <ShippingZonesTable zones={zones} onEdit={handleEdit} onEditOption={handleEditOption} />
                </Card>
              </BlockStack>
              <BlockStack>
                <PackagingDefaultsCard
                  key={packaging.configKey}
                  initialDefaultWeight={packaging.defaultWeightPerItemKg}
                  initialReturnCost={packaging.returnCost}
                  onSave={handleDefaultsSave}
                  isSaving={isSavingDefaults}
                />
              </BlockStack>
            </InlineGrid>
          </>
        )}

        {packagingDialog?.kind === 'category' && (
          <CategoryModal
            key={packagingDialog.category?.name ?? 'nuova'}
            current={packagingCurrent}
            category={packagingDialog.category}
            onClose={closePackagingDialog}
            onSave={(data) =>
              submitPackaging({
                intent: 'save-category',
                originalName: data.originalName ?? '',
                name: data.name,
                cost: data.cost,
              })
            }
            isSaving={isSavingPackagingRow}
            serverError={packagingServerError}
          />
        )}

        {packagingDialog?.kind === 'delete-category' && (
          <ConfirmDeleteModal
            title={t.shipping.packaging.categories.deleteTitle(packagingDialog.category.name)}
            body={t.shipping.packaging.categories.deleteBody}
            onClose={closePackagingDialog}
            onConfirm={() => submitPackaging({ intent: 'delete-category', name: packagingDialog.category.name })}
            isDeleting={isSavingPackagingRow}
            serverError={packagingServerError}
          />
        )}

        {packagingDialog?.kind === 'rule' && (
          <RuleModal
            key={packagingDialog.index ?? 'nuova'}
            current={packagingCurrent}
            index={packagingDialog.index}
            onClose={closePackagingDialog}
            onSave={(data) =>
              submitPackaging({
                intent: 'save-rule',
                index: data.index !== null ? String(data.index) : '',
                weightMaxKg: data.weightMaxKg,
                category: data.category,
              })
            }
            isSaving={isSavingPackagingRow}
            serverError={packagingServerError}
          />
        )}

        {packagingDialog?.kind === 'delete-rule' && packaging.fallbackRules[packagingDialog.index] && (
          <ConfirmDeleteModal
            title={t.shipping.packaging.rules.deleteTitle}
            body={t.shipping.packaging.rules.deleteBody(
              describeRuleWeight(packaging.fallbackRules[packagingDialog.index], t, locale),
              packaging.fallbackRules[packagingDialog.index].category,
            )}
            onClose={closePackagingDialog}
            onConfirm={() => submitPackaging({ intent: 'delete-rule', index: String(packagingDialog.index) })}
            isDeleting={isSavingPackagingRow}
            serverError={packagingServerError}
          />
        )}

        {editingZone && (
          <EditZoneModal
            key={editingZone.id}
            zone={editingZone}
            onClose={handleModalClose}
            onSave={handleModalSave}
            isSaving={isSavingZone}
            serverError={zoneServerError}
          />
        )}

        {editingOption && (
          <EditOptionModal
            key={editingOption.option.id}
            option={editingOption.option}
            zone={editingOption.zone}
            onClose={handleOptionModalClose}
            onSave={handleOptionModalSave}
            isSaving={isSavingOption}
            serverError={optionServerError}
          />
        )}

      </BlockStack>
    </Page>
  );
}
