import { dictionaryForShop } from '~/lib/i18n/server';
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';
import { runQuery } from '~/lib/supabase-management.server';
import { can } from '~/lib/authz/capabilities';
import { shopCapabilities } from '~/lib/authz/shop-capabilities.server';

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { supabaseConfig: true },
  });
  if (!shop) return json({ ok: false, error: 'Shop non trovato' }, { status: 404 });
  if (!can(await shopCapabilities(shop), 'use_app')) {
    return json(
      {
        ok: false,
        error: (await dictionaryForShop(session.shop)).errors.suspended,
        code: 'not_authorized',
      },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { deleteData?: unknown };
  const deleteData = body.deleteData === true;

  // Se richiesto, elimina le tabelle sul progetto Supabase del merchant PRIMA
  // di cancellare il token OAuth (che serve per la chiamata). Non distruttivo
  // di default: senza deleteData i dati restano, si interrompe solo la sync.
  if (deleteData && shop.supabaseConfig) {
    const cfg = shop.supabaseConfig;
    const ref =
      cfg.supabaseProjectRef ||
      cfg.supabaseUrl.match(/^https:\/\/([^.]+)\.supabase\.co/)?.[1] ||
      null;
    if (ref) {
      try {
        const token = await getValidAccessToken(shop.id);
        const products = cfg.tableNameProducts;
        const customers = cfg.tableNameCustomers;
        await runQuery(
          token,
          ref,
          `DROP TABLE IF EXISTS "${products}"; DROP TABLE IF EXISTS "${customers}";`,
        );
      } catch (e) {
        // Non blocchiamo lo scollegamento se il drop fallisce: logghiamo e basta.
        console.warn(
          '[api.supabase.disconnect] drop tabelle fallito:',
          e instanceof Error ? e.message : 'errore sconosciuto',
        );
      }
    }
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
