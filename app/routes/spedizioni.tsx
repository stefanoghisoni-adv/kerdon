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
import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import { requireShopCapability } from '~/lib/authz/require-capability.server';
import { useT } from '~/lib/i18n/context';
import { authenticate } from '~/shopify.server';
import { syncShippingZones } from '~/lib/shipping/sync-zones.server';
import { enqueueLogisticsRecompute } from '~/lib/shipping/recompute.server';
import { loadShippingPageData } from '~/lib/shipping/page-data.server';
import { parseBrackets } from '~/components/Shipping/brackets';
import { parsePackaging } from '~/components/Shipping/packaging';
import { parseOptionBrackets } from '~/components/Shipping/option-cost';
import { feedbackFromActionData, type ShippingIntent } from '~/components/Shipping/feedback';
import { ShippingZonesTable } from '~/components/Shipping/ShippingZonesTable';
import { EditZoneModal } from '~/components/Shipping/EditZoneModal';
import { EditOptionModal } from '~/components/Shipping/EditOptionModal';
import { PackagingCard } from '~/components/Shipping/PackagingCard';
import type { RateBracket, PackagingCategory, FallbackRule, OptionCostType, OptionBracket } from '~/lib/shipping/types';
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
 * La pagina usa un fetcher solo per tre azioni, e quando la risposta arriva
 * `fetcher.formData` e' gia' stato azzerato da Remix: l'intento va rimandato
 * qui, o il client non sa quale toast mostrare (vedi feedback.ts).
 */
function risposta(intent: ShippingIntent | null, esito: { success: true } | { success: false; error: string }) {
  return json({ intent, ...esito } as { intent: ShippingIntent | null; success: boolean; error?: string });
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
    // recompute-enqueue.server): le zone sono gia' salvate comunque.
    await enqueueLogisticsRecompute(shop.id);

    return risposta('sync-zones', { success: true });
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

    // Accoda il ricalcolo dei costi logistici in background
    await enqueueLogisticsRecompute(shop.id);

    return risposta('save-zone-rates', { success: true });
  }

  if (intent === 'save-packaging') {
    const parsed = parsePackaging(
      formData.get('categories')?.toString(),
      formData.get('rules')?.toString(),
    );
    if (parsed.error !== null) {
      return risposta('save-packaging', { success: false, error: parsed.error });
    }
    const categories: PackagingCategory[] = parsed.value.categories;
    const rules: FallbackRule[] = parsed.value.rules;

    const defaultWeight = importoFacoltativo(formData.get('defaultWeightPerItemKg')?.toString());
    const returnCost = importoFacoltativo(formData.get('returnCost')?.toString());

    // Verifica valori finiti e non negativi
    if (defaultWeight !== null && Number.isNaN(defaultWeight)) {
      return risposta('save-packaging', { success: false, error: 'invalid_default_weight' });
    }
    if (returnCost !== null && Number.isNaN(returnCost)) {
      return risposta('save-packaging', { success: false, error: 'invalid_return_cost' });
    }

    // Upsert della configurazione
    await prisma.packagingConfig.upsert({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        categories: categories as unknown as Prisma.InputJsonValue,
        fallbackRules: rules as unknown as Prisma.InputJsonValue,
        defaultWeightPerItem: defaultWeight !== null ? new Decimal(defaultWeight) : null,
        returnCost: returnCost !== null ? new Decimal(returnCost) : null,
      },
      update: {
        categories: categories as unknown as Prisma.InputJsonValue,
        fallbackRules: rules as unknown as Prisma.InputJsonValue,
        defaultWeightPerItem: defaultWeight !== null ? new Decimal(defaultWeight) : null,
        returnCost: returnCost !== null ? new Decimal(returnCost) : null,
      },
    });

    // Accoda il ricalcolo dei costi logistici in background
    await enqueueLogisticsRecompute(shop.id);

    return risposta('save-packaging', { success: true });
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
        return risposta('save-option-cost', { success: false, error: 'shipping.errors.invalidLinearCost' });
      }

      // Sostituisci le tariffe in una transazione
      await prisma.$transaction([
        prisma.shippingOptionRate.deleteMany({ where: { optionId } }),
        prisma.shippingOption.update({
          where: { id: optionId },
          data: { costType },
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
        prisma.shippingOption.update({
          where: { id: optionId },
          data: { costType },
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

    // Accoda il ricalcolo dei costi logistici in background
    await enqueueLogisticsRecompute(shop.id);

    return risposta('save-option-cost', { success: true });
  }

  return risposta(null, { success: false, error: 'unknown_intent' });
}

export default function ShippingPage() {
  const { zones, packaging } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const t = useT();

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
  const isSavingPackaging = intentInCorso === 'save-packaging';
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

  const handlePackagingSave = (data: {
    categories: PackagingCategory[];
    rules: FallbackRule[];
    defaultWeightPerItemKg: string | null;
    returnCost: string | null;
  }) => {
    const formData = new FormData();
    formData.append('intent', 'save-packaging');
    formData.append('categories', JSON.stringify(data.categories));
    formData.append('rules', JSON.stringify(data.rules));
    if (data.defaultWeightPerItemKg) {
      formData.append('defaultWeightPerItemKg', data.defaultWeightPerItemKg);
    }
    if (data.returnCost) {
      formData.append('returnCost', data.returnCost);
    }

    fetcher.submit(formData, { method: 'post' });
  };

  // Il banner del permesso mancante arriva dalla risposta del fetcher, come
  // l'importazione che lo provoca; resta finche' non arriva un'altra risposta.
  const scopeError = feedback?.scopeError ?? false;

  return (
    <Page
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
          <InlineGrid columns={{ xs: 1, md: '2fr 1fr' }} gap="400">
            <Card padding="0">
              <ShippingZonesTable zones={zones} onEdit={handleEdit} onEditOption={handleEditOption} />
            </Card>
            <PackagingCard
              key={packaging.configKey}
              initialCategories={packaging.categories}
              initialRules={packaging.fallbackRules}
              initialDefaultWeight={packaging.defaultWeightPerItemKg}
              initialReturnCost={packaging.returnCost}
              configKey={packaging.configKey}
              onSave={handlePackagingSave}
              isSaving={isSavingPackaging}
            />
          </InlineGrid>
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
