import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { canInstall, normalizeStatus } from '~/lib/integrations/platforms';
import { dictionaryForShop } from '~/lib/i18n/server';

/**
 * L'avvio di una connessione a una piattaforma.
 *
 * Oggi non ne porta a termine nessuna: ogni piattaforma ha la sua
 * autorizzazione da costruire, e finche' quella non c'e' la risposta lo dice
 * invece di far girare un loader all'infinito.
 *
 * Lo stato lo decide il database dell'owner, non il browser: una piattaforma
 * che non e' disponibile non si installa nemmeno chiedendolo direttamente.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Richiesta non valida' }, { status: 405 });
  }

  const form = await request.formData();
  const slug = String(form.get('slug') ?? '').trim();
  const platform = slug
    ? await prisma.integrationPlatform.findUnique({ where: { slug } })
    : null;

  const t = await dictionaryForShop(session.shop);

  if (!platform || !canInstall(normalizeStatus(platform.status))) {
    return json({ ok: false, error: t.integrations.notAvailable }, { status: 400 });
  }

  // Il connettore vero — autorizzazione della piattaforma, scelta dell'account,
  // salvataggio della connessione — arriva una piattaforma alla volta. Finche'
  // manca, si dice quello che c'e' da dire.
  return json({ ok: false, error: t.integrations.notReady(platform.name) }, { status: 501 });
}
