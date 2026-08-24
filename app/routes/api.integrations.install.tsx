import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { canInstall, normalizeStatus } from '~/lib/integrations/platforms';
import { dictionaryForShop } from '~/lib/i18n/server';
import { signState } from '~/lib/oauth-state.server';
import {
  buildMetaAuthorizeUrl,
  metaCredentials,
  metaRedirectUri,
} from '~/lib/integrations/meta/oauth.server';

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

  // Meta e' la prima piattaforma con una connessione vera: si risponde con
  // l'indirizzo di autorizzazione, e la finestra la apre il browser.
  if (platform.slug === 'meta-ads') {
    const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
    if (!shop) return json({ ok: false, error: t.errors.suspended }, { status: 404 });

    const credentials = metaCredentials();
    if (!credentials || !process.env.SHOPIFY_APP_URL) {
      console.error('[integrations.install] credenziali Meta non configurate');
      return json({ ok: false, error: t.integrations.notConfigured }, { status: 500 });
    }

    return json({
      ok: true,
      url: buildMetaAuthorizeUrl({
        appId: credentials.appId,
        redirectUri: metaRedirectUri(),
        state: signState(shop.id),
      }),
    });
  }

  // Le altre arrivano una alla volta: finche' la loro connessione non esiste,
  // si dice quello che c'e' da dire invece di far girare un loader.
  return json({ ok: false, error: t.integrations.notReady(platform.name) }, { status: 501 });
}
