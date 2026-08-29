import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { deleteProject, listProjects } from '~/lib/supabase-management.server';
import { dictionaryForShop } from '~/lib/i18n/server';

/**
 * Eliminazione di un database che il merchant non sta usando.
 *
 * Il gesto e' irreversibile e riguarda dati suoi, quindi qui ci sono due
 * verifiche che non dipendono da cosa dichiara il browser: i progetti devono
 * risultare fra i suoi, e nessuno di loro puo' essere quello collegato all'app. La seconda
 * conta piu' della prima — cancellare il database collegato significherebbe
 * portarsi via i dati che l'app sta sincronizzando, e da qui non si torna
 * indietro.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Richiesta non valida' }, { status: 405 });
  }

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { supabaseConfig: true },
  });
  if (!shop) {
    return json({ ok: false, error: 'Negozio non trovato' }, { status: 404 });
  }
  if (!can(await shopCapabilities(shop), 'use_app')) {
    return json(
      { ok: false, error: (await dictionaryForShop(session.shop)).errors.suspended },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { refs?: unknown };
  const refs = Array.isArray(body.refs)
    ? [...new Set(body.refs.filter((r): r is string => typeof r === 'string' && r.trim() !== ''))]
    : [];
  if (refs.length === 0) {
    return json({ ok: false, error: 'nessun progetto indicato' }, { status: 400 });
  }

  const t = await dictionaryForShop(session.shop);

  // Il database collegato non si elimina da qui: prima lo si stacca, e quella
  // e' una strada che chiede le sue conferme. Basta che sia in elenco perche'
  // l'intera richiesta si fermi — non se ne elimina meta'.
  if (refs.includes(shop.supabaseConfig?.supabaseProjectRef ?? '')) {
    return json({ ok: false, error: t.errors.deleteConnected }, { status: 400 });
  }

  try {
    const token = await getValidAccessToken(shop.id);

    // Che i progetti siano suoi lo dice Supabase, non il browser.
    const projects = await listProjects(token);
    const known = new Set(projects.map((p) => p.id));
    if (refs.some((ref) => !known.has(ref))) {
      return json({ ok: false, error: t.errors.deleteUnknown }, { status: 404 });
    }

    // In sequenza: sono richieste distruttive, e mandarle in parallelo
    // renderebbe piu' difficile dire quale non e' passata.
    for (const ref of refs) {
      await deleteProject(token, ref);
    }
    return json({ ok: true });
  } catch (e) {
    console.error(
      '[api.supabase.delete-project]',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return json({ ok: false, error: t.errors.deleteFailed }, { status: 502 });
  }
}
