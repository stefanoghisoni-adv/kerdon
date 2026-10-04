import type { ActionFunctionArgs, LoaderFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { requireCustomersSyncShop } from '~/lib/integrations/route-guard.server';
import { listConflicts, resolveConflicts } from '~/lib/integrations/conflicts.server';

/**
 * GET /api/integrations/conflicts — elenco dei conflitti aperti.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const shop = await requireCustomersSyncShop(request);
  if (shop instanceof Response) return shop;

  const conflicts = await listConflicts(shop.id, { status: 'open' });
  return json({ conflicts });
}

/**
 * POST /api/integrations/conflicts — risolve i conflitti in blocco.
 *
 * Body: { customerIds: number[], choice: 'kept_ours' | 'used_theirs' }
 *
 * Limite: 250 ID per richiesta. Oltre, risponde 400.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
  }

  const shop = await requireCustomersSyncShop(request);
  if (shop instanceof Response) return shop;

  let body: { customerIds?: unknown; choice?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const { customerIds, choice } = body;

  if (!Array.isArray(customerIds) || !customerIds.every((id) => typeof id === 'number')) {
    return json({ ok: false, error: 'invalid_customer_ids' }, { status: 400 });
  }

  if (choice !== 'kept_ours' && choice !== 'used_theirs') {
    return json({ ok: false, error: 'invalid_choice' }, { status: 400 });
  }

  if (customerIds.length > 250) {
    return json({ ok: false, error: 'too_many_ids' }, { status: 400 });
  }

  try {
    const result = await resolveConflicts(shop.id, customerIds, choice);
    return json({ ok: true, ...result });
  } catch (error) {
    console.error('[conflicts] risoluzione fallita:', error);
    return json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
