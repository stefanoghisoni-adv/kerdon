import type { LoaderFunctionArgs, ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { getIntegration } from '~/lib/integrations/registry';
import { connectionStatus, disconnect } from '~/lib/integrations/connections.server';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const { provider } = params;

  if (!provider || !getIntegration(provider)) {
    return json({ error: 'Provider non valido' }, { status: 404 });
  }

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    return json({ error: 'Shop non trovato' }, { status: 404 });
  }

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
  const { session } = await authenticate.admin(request);
  const { provider } = params;

  if (!provider || !getIntegration(provider)) {
    return json({ error: 'Provider non valido' }, { status: 404 });
  }

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    return json({ error: 'Shop non trovato' }, { status: 404 });
  }

  const body = (await request.json()) as { intent?: string };
  const { intent } = body;

  if (intent === 'disconnect') {
    await disconnect(shop.id);
    return json({ ok: true });
  }

  return json({ error: 'Intent non valido' }, { status: 400 });
}
