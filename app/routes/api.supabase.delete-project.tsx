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
  // NESSUN CONTROLLO SUL PIANO QUI, ED E' VOLUTO.
  //
  // Scollegare il proprio database e farsi eliminare i dati sono le due vie
  // d'uscita: un merchant con la prova finita, sospeso o che semplicemente non
  // vuole piu' l'app deve poterle percorrere. Prima serviva `use_app`, quindi
  // chi non pagava piu' restava chiuso dentro con i suoi dati ancora qui —
  // condizionare la cancellazione all'avere un abbonamento attivo e' esattamente
  // cio' che il GDPR non ammette, oltre a essere la prima domanda che si fa chi
  // valuta l'app.
  //
  // Cio' che deve restare impedito — due cancellazioni insieme — lo impedisce il
  // lucchetto dentro `deleteMerchantData`, che e' il posto giusto: li' si sa se
  // una cancellazione e' gia' in corso, qui no.

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
