import { dictionaryForShop } from '~/lib/i18n/server';
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';
import { deleteMerchantData } from '~/lib/supabase/delete-merchant-data.server';

/**
 * Scollegare Supabase, con o senza eliminare i dati.
 *
 * Sono due gesti diversi e vanno tenuti diversi:
 *
 *  - `keepData` (il default) revoca Kerdon e basta. Nessuna tabella viene
 *    toccata: restano dove sono, con dentro tutto, e si ferma solo la
 *    sincronizzazione. E' anche cio' che succede alla disinstallazione e a
 *    `shop/redact`, che infatti non passano di qui.
 *
 *  - `deleteData` elimina le tabelle che l'app ha creato — quelle, non quelle
 *    che l'app userebbe — e revoca l'accesso SOLO dopo aver verificato che
 *    siano sparite davvero. Se la verifica non va a buon fine il merchant
 *    resta collegato: e' l'unico stato da cui puo' riprovare.
 *
 * L'ordine importa: token e configurazione servono a eliminare, quindi
 * cancellarli e' l'ultimo gesto, mai il primo. Prima si cancellavano comunque,
 * anche dopo un errore, e da li' in poi non c'era piu' modo di finire il
 * lavoro — con il merchant che intanto aveva letto "fatto".
 */
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { supabaseConfig: true },
  });
  if (!shop) return json({ ok: false, error: 'Shop non trovato' }, { status: 404 });
  const t = await dictionaryForShop(session.shop);
  if (!can(await shopCapabilities(shop), 'use_app')) {
    return json(
      {
        ok: false,
        error: t.errors.suspended,
        code: 'not_authorized',
      },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { deleteData?: unknown };
  const deleteData = body.deleteData === true;

  if (deleteData && shop.supabaseConfig) {
    const result = await deleteMerchantData(shop.id);

    if (result.status === 'already_running') {
      // Due richieste ravvicinate sullo stesso negozio: la seconda non ripete
      // niente. Non e' un successo da mostrare — l'esito vero non lo conosce —
      // ma nemmeno un guasto: e' la prima che sta lavorando.
      return json(
        { ok: false, code: 'deletion_in_progress', error: t.errors.deleteDataInProgress },
        { status: 409 },
      );
    }

    if (result.status === 'failed') {
      // Non si scollega e non si conferma niente: le credenziali restano, ed e'
      // deliberato — sono l'unica cosa con cui l'eliminazione si puo' ancora
      // portare a termine.
      return json(
        {
          ok: false,
          code: 'delete_data_failed',
          retryable: result.retryable,
          remaining: result.remaining,
          error: result.retryable ? t.errors.deleteDataFailed : t.errors.deleteDataBlocked,
        },
        { status: result.retryable ? 503 : 422 },
      );
    }

    if (result.status === 'completed') {
      // Token, configurazione e registro li ha gia' tolti l'eliminazione, dopo
      // la verifica: qui non resta niente da cancellare.
      return json({ ok: true, deleted: result.attempted });
    }

    // 'nothing_owned': su quel progetto non risulta niente creato da noi, quindi
    // non c'e' niente da eliminare. Lo scollegamento pero' si fa lo stesso — e'
    // quello che il merchant ha chiesto — e prosegue qui sotto.
  }

  // deleteMany è idempotente: non fallisce se le righe non esistono.
  await prisma.supabaseOAuthToken.deleteMany({ where: { shopId: shop.id } });
  await prisma.supabaseConfig.deleteMany({ where: { shopId: shop.id } });

  // Scollegarsi riporta il negozio al punto di partenza: da qui la
  // configurazione si rifa' da capo, ed e' l'unico gesto che la riapre.
  await prisma.shop.update({
    where: { id: shop.id },
    data: { setupCompletedAt: null },
  });

  return json({ ok: true });
}
