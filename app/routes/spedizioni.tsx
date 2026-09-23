import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { useActionData, useFetcher, useLoaderData } from '@remix-run/react';
import { useState, useEffect } from 'react';
import {
  Banner,
  BlockStack,
  Button,
  Card,
  EmptyState,
  InlineGrid,
  Page,
  Toast,
} from '@shopify/polaris';
import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { requireSetupComplete } from '~/lib/setup/require-setup.server';
import { requireShopCapability } from '~/lib/authz/require-capability.server';
import { useT } from '~/lib/i18n/context';
import { authenticate } from '~/shopify.server';
import { syncShippingZones } from '~/lib/shipping/sync-zones.server';
import { enqueueLogisticsRecompute } from '~/lib/shipping/recompute.server';
import { validateCategories, validateFallbackRules } from '~/lib/shipping/load-config.server';
import { validateBrackets } from '~/components/Shipping/brackets';
import { validatePackaging } from '~/components/Shipping/packaging';
import { ShippingZonesTable } from '~/components/Shipping/ShippingZonesTable';
import { EditZoneModal } from '~/components/Shipping/EditZoneModal';
import { PackagingCard } from '~/components/Shipping/PackagingCard';
import type { RateBracket, PackagingCategory, FallbackRule } from '~/lib/shipping/types';
import { Decimal } from '@prisma/client/runtime/library';

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, shop } = await requireShopCapability(request, 'use_app', {
    onDenied: 'redirect',
  });
  await requireSetupComplete(session.shop);

  // Carica le zone di spedizione con le tariffe
  const zones = await prisma.shippingZone.findMany({
    where: { shopId: shop.id },
    include: { rates: true },
    orderBy: { zoneName: 'asc' },
  });

  // Carica la configurazione packaging
  const packagingConfig = await prisma.packagingConfig.findUnique({
    where: { shopId: shop.id },
  });

  return json({
    zones: zones.map((zone) => ({
      id: zone.id,
      zoneName: zone.zoneName,
      countries: zone.countries,
      restOfWorld: zone.restOfWorld,
      rateType: zone.rateType as 'linear' | 'brackets',
      rates: zone.rates.map((rate) => ({
        id: rate.id,
        weightFromKg: rate.weightFrom ? Number(rate.weightFrom) : null,
        weightToKg: rate.weightTo ? Number(rate.weightTo) : null,
        cost: Number(rate.cost),
      })),
    })),
    packaging: packagingConfig
      ? {
          categories: validateCategories(packagingConfig.categories),
          fallbackRules: validateFallbackRules(packagingConfig.fallbackRules),
          defaultWeightPerItemKg: packagingConfig.defaultWeightPerItem
            ? Number(packagingConfig.defaultWeightPerItem)
            : null,
          returnCost: packagingConfig.returnCost ? Number(packagingConfig.returnCost) : null,
          configKey: packagingConfig.updatedAt.toISOString(),
        }
      : {
          categories: [],
          fallbackRules: [],
          defaultWeightPerItemKg: null,
          returnCost: null,
          configKey: 'empty',
        },
  });
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
      const result = await syncShippingZones(admin, shop.id);
      return json({ success: true, synced: result });
    } catch (error) {
      const isScopeError =
        error instanceof Error && error.message.includes('read_shipping');
      return json({
        success: false,
        error: isScopeError ? 'scope_error' : 'sync_error',
      });
    }
  }

  if (intent === 'save-zone-rates') {
    const zoneId = formData.get('zoneId')?.toString();
    const rateType = formData.get('rateType')?.toString() as 'linear' | 'brackets';

    if (!zoneId || !rateType) {
      return json({ success: false, error: 'invalid_request' });
    }

    // Verifica che la zona appartenga a questo shop
    const zone = await prisma.shippingZone.findFirst({
      where: { id: zoneId, shopId: shop.id },
    });

    if (!zone) {
      return json({ success: false, error: 'zone_not_found' });
    }

    if (rateType === 'linear') {
      const costPerKg = formData.get('costPerKg')?.toString();
      const cost = parseFloat(costPerKg || '');

      if (isNaN(cost) || cost < 0) {
        return json({ success: false, error: 'invalid_cost' });
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
      // Brackets
      const bracketsJson = formData.get('brackets')?.toString();
      if (!bracketsJson) {
        return json({ success: false, error: 'invalid_brackets' });
      }

      const brackets: RateBracket[] = JSON.parse(bracketsJson);

      // Valida i brackets
      const validationError = validateBrackets(brackets);
      if (validationError) {
        return json({ success: false, error: validationError });
      }

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

    return json({ success: true });
  }

  if (intent === 'save-packaging') {
    const categoriesJson = formData.get('categories')?.toString();
    const rulesJson = formData.get('rules')?.toString();
    const defaultWeightStr = formData.get('defaultWeightPerItemKg')?.toString();
    const returnCostStr = formData.get('returnCost')?.toString();

    if (!categoriesJson || !rulesJson) {
      return json({ success: false, error: 'invalid_request' });
    }

    let categories: PackagingCategory[];
    let rules: FallbackRule[];

    try {
      categories = JSON.parse(categoriesJson);
      rules = JSON.parse(rulesJson);
    } catch {
      return json({ success: false, error: 'invalid_json' });
    }

    // Valida il packaging
    const validationError = validatePackaging({ categories, rules });
    if (validationError) {
      return json({ success: false, error: validationError });
    }

    // Parse dei valori opzionali
    const defaultWeight =
      defaultWeightStr && defaultWeightStr !== ''
        ? parseFloat(defaultWeightStr)
        : null;
    const returnCost =
      returnCostStr && returnCostStr !== ''
        ? parseFloat(returnCostStr)
        : null;

    // Verifica valori non negativi
    if (defaultWeight !== null && (isNaN(defaultWeight) || defaultWeight < 0)) {
      return json({ success: false, error: 'invalid_default_weight' });
    }
    if (returnCost !== null && (isNaN(returnCost) || returnCost < 0)) {
      return json({ success: false, error: 'invalid_return_cost' });
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

    return json({ success: true });
  }

  return json({ success: false, error: 'unknown_intent' });
}

export default function ShippingPage() {
  const { zones, packaging } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const fetcher = useFetcher<typeof action>();
  const t = useT();

  const [editingZone, setEditingZone] = useState<typeof zones[0] | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);

  const isSyncing = fetcher.state !== 'idle' && (fetcher.formData as FormData | undefined)?.get('intent') === 'sync-zones';
  const isSavingPackaging = fetcher.state !== 'idle' && (fetcher.formData as FormData | undefined)?.get('intent') === 'save-packaging';

  // Mostra toast solo dopo risposta del server
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      const formData = fetcher.formData as FormData | undefined;
      const intent = formData?.get('intent')?.toString();

      if (fetcher.data.success) {
        if (intent === 'sync-zones') {
          setSuccessToast(t.shipping.syncSuccess);
        } else if (intent === 'save-zone-rates') {
          setSuccessToast(t.shipping.modal.saveSuccess);
        } else if (intent === 'save-packaging') {
          setSuccessToast(t.shipping.packaging.saveSuccess);
        }
      } else if ('error' in fetcher.data && fetcher.data.error !== 'scope_error') {
        if (intent === 'sync-zones') {
          setErrorToast(t.shipping.syncError);
        } else if (intent === 'save-zone-rates') {
          setErrorToast(t.shipping.modal.saveError);
        } else if (intent === 'save-packaging') {
          setErrorToast(t.shipping.packaging.saveError);
        }
      }
    }
  }, [fetcher.state, fetcher.data, t]);

  const handleSync = () => {
    fetcher.submit({ intent: 'sync-zones' }, { method: 'post' });
  };

  const handleEdit = (zone: typeof zones[0]) => {
    setEditingZone(zone);
  };

  const handleModalClose = () => {
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

    fetcher.submit(formData, { method: 'post' });
    setEditingZone(null);
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

  // Mostra errore di scope se presente
  const scopeError = actionData && !actionData.success && 'error' in actionData && actionData.error === 'scope_error';

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
              <ShippingZonesTable zones={zones} onEdit={handleEdit} />
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
          />
        )}

        {successToast && (
          <Toast
            content={successToast}
            onDismiss={() => setSuccessToast(null)}
          />
        )}

        {errorToast && (
          <Toast
            content={errorToast}
            error
            onDismiss={() => setErrorToast(null)}
          />
        )}
      </BlockStack>
    </Page>
  );
}
