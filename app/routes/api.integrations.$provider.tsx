import type { LoaderFunctionArgs, ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { requireShop, requireCustomersSyncShop } from '~/lib/integrations/route-guard.server';
import { prisma } from '~/db.server';
import { getIntegration } from '~/lib/integrations/registry';
import { connectionStatus, disconnect, getAccessToken, markNeedsReconnect } from '~/lib/integrations/connections.server';
import { importInProgress } from '~/lib/integrations/import.server';
import { sampleProperties, KlaviyoAuthError, KlaviyoUnavailableError } from '~/lib/integrations/klaviyo/api.server';
import { parseDate, detectFormat } from '~/lib/integrations/values';
import type { DateFormat } from '~/lib/integrations/values';

/**
 * Stato e disconnessione integrazione, o vista delle proprietà per la mappatura.
 *
 * Senza query string (`?view=properties`): usa requireShop (NON requireCustomersSyncShop)
 * perché un merchant sospeso o con un piano downgraded deve poter vedere lo stato
 * della connessione e scollegare l'integrazione.
 *
 * Con `?view=properties`: usa requireCustomersSyncShop perché è una funzionalità
 * plan-gated.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { provider } = params;

  if (!provider || !getIntegration(provider)) {
    return json({ error: 'invalid_provider' }, { status: 404 });
  }

  const url = new URL(request.url);
  const view = url.searchParams.get('view');

  // Vista proprietà: plan-gated
  if (view === 'properties') {
    const shop = await requireCustomersSyncShop(request);
    if (shop instanceof Response) return shop;

    try {
      const token = await getAccessToken(shop.id);
      const { keys, samples: rawSamples } = await sampleProperties(token);

      const properties = keys
        .map((key) => {
          const rawValues = (rawSamples[key] ?? []).filter((v) => v != null);
          const { format, ambiguous } = detectFormat(rawValues);

          const samples = rawValues
            .map((raw) => {
              const parsed = parseDate(raw, 'auto');
              return {
                raw: String(raw),
                parsed: parsed.ok ? parsed.date : null,
              };
            })
            // Include sample if parsed is valid OR if it's ambiguous (will be resolved by user)
            .filter((s) => {
              const result = parseDate(s.raw, 'auto');
              return result.ok || result.reason === 'ambiguous';
            });

          // Skip properties where all values are invalid (not ambiguous, truly invalid)
          if (samples.length === 0) return null;

          return { key, samples, format, ambiguous };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .sort((a, b) => b.samples.length - a.samples.length);

      return json({ properties });
    } catch (e) {
      if (e instanceof KlaviyoAuthError) {
        await markNeedsReconnect(shop.id);
        return json({ error: 'reconnect' }, { status: 409 });
      }
      if (e instanceof KlaviyoUnavailableError) {
        return json({ error: 'unavailable' }, { status: 503 });
      }
      throw e;
    }
  }

  // Vista stato: accessibile anche a merchant sospesi
  const shop = await requireShop(request);
  if (shop instanceof Response) return shop;

  const { status, accountName } = await connectionStatus(shop.id);

  // Mapping: leggere dalla tabella IntegrationFieldMapping
  const mappingRow = await prisma.integrationFieldMapping.findUnique({
    where: {
      shopId_provider_targetField: {
        shopId: shop.id,
        provider,
        targetField: 'birthdate',
      },
    },
  });

  const mapping = mappingRow
    ? { sourceKey: mappingRow.sourceKey, dateFormat: mappingRow.dateFormat ?? 'auto' }
    : null;

  // lastRun: l'ultimo import completato o interrotto (Tasks 8-9 non ancora implementati)
  const lastRunRow = await prisma.integrationImportRun.findFirst({
    where: {
      shopId: shop.id,
      provider,
      status: { in: ['completed', 'interrupted'] },
    },
    orderBy: { startedAt: 'desc' },
  });

  const lastRun = lastRunRow
    ? {
        status: lastRunRow.status,
        finishedAt: lastRunRow.finishedAt?.toISOString() ?? null,
        counters: lastRunRow.counters,
      }
    : null;

  // openConflicts: conflitti non ancora risolti (Task 1, Tasks 10-11 non ancora implementati)
  const openConflicts = await prisma.integrationConflict.count({
    where: {
      shopId: shop.id,
      provider,
      status: 'open',
    },
  });

  const running = await importInProgress(shop.id, provider as 'klaviyo');

  return json({
    status,
    accountName,
    mapping,
    lastRun,
    running,
    openConflicts,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { provider } = params;

  if (!provider || !getIntegration(provider)) {
    return json({ error: 'invalid_provider' }, { status: 404 });
  }

  let body: { intent?: string; sourceKey?: string; targetField?: string; dateFormat?: string; ambiguous?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const { intent } = body;

  // save-mapping: plan-gated
  if (intent === 'save-mapping') {
    const shop = await requireCustomersSyncShop(request);
    if (shop instanceof Response) return shop;

    const { sourceKey, targetField, dateFormat, ambiguous } = body;

    // Validazione: targetField solo 'birthdate'
    if (targetField !== 'birthdate') {
      return json({ ok: false, error: 'invalid_target_field' }, { status: 400 });
    }

    // Validazione: sourceKey non vuoto e <= 255 caratteri
    if (!sourceKey || sourceKey.trim().length === 0 || sourceKey.length > 255) {
      return json({ ok: false, error: 'invalid_source_key' }, { status: 400 });
    }

    // Validazione: dateFormat in 'auto'|'DMY'|'MDY'|'YMD'
    const validFormats: DateFormat[] = ['auto', 'DMY', 'MDY', 'YMD'];
    if (!dateFormat || !validFormats.includes(dateFormat as DateFormat)) {
      return json({ ok: false, error: 'invalid_date_format' }, { status: 400 });
    }

    // Se ambiguous=true, dateFormat deve essere DMY o MDY
    if (ambiguous && (dateFormat === 'auto' || dateFormat === 'YMD')) {
      return json({ ok: false, error: 'ambiguous_requires_format' }, { status: 400 });
    }

    // Upsert del mapping
    await prisma.integrationFieldMapping.upsert({
      where: {
        shopId_provider_targetField: {
          shopId: shop.id,
          provider,
          targetField: 'birthdate',
        },
      },
      create: {
        shopId: shop.id,
        provider,
        sourceKey,
        targetField: 'birthdate',
        dateFormat,
      },
      update: {
        sourceKey,
        dateFormat,
      },
    });

    return json({ ok: true });
  }

  // disconnect: accessibile anche a merchant sospesi
  if (intent === 'disconnect') {
    const shop = await requireShop(request);
    if (shop instanceof Response) return shop;

    await disconnect(shop.id);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'invalid_intent' }, { status: 400 });
}
