import type { LoaderFunctionArgs, ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { requireShop } from '~/lib/integrations/route-guard.server';
import { prisma } from '~/db.server';
import { getIntegration } from '~/lib/integrations/registry';
import { connectionStatus, disconnect } from '~/lib/integrations/connections.server';

/**
 * Stato e disconnessione integrazione.
 *
 * Usa requireShop (NON requireCustomersSyncShop): un merchant sospeso o con un
 * piano downgraded deve poter vedere lo stato della connessione e scollegare
 * l'integrazione. Questa è la sua via d'uscita, come per Supabase disconnect.
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { provider } = params;

  if (!provider || !getIntegration(provider)) {
    return json({ error: 'invalid_provider' }, { status: 404 });
  }

  const shop = await requireShop(request);
  if (shop instanceof Response) return shop;

  const { status, accountName } = await connectionStatus(shop.id);

  // Mapping: sarà implementato in Task 7, per ora sempre null
  const mapping: { sourceKey: string; dateFormat: string } | null = null;

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

  return json({
    status,
    accountName,
    mapping,
    lastRun,
    openConflicts,
  });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { provider } = params;

  if (!provider || !getIntegration(provider)) {
    return json({ error: 'invalid_provider' }, { status: 404 });
  }

  const shop = await requireShop(request);
  if (shop instanceof Response) return shop;

  let body: { intent?: string };
  try {
    body = (await request.json()) as { intent?: string };
  } catch {
    return json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const { intent } = body;

  if (intent === 'disconnect') {
    await disconnect(shop.id);
    return json({ ok: true });
  }

  return json({ ok: false, error: 'invalid_intent' }, { status: 400 });
}
