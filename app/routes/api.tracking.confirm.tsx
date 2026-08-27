import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';

/**
 * Il merchant ha guardato cosa sta gia' leggendo il suo negozio, e va avanti.
 *
 * E' una rotta a se' e non un intento dell'azione della dashboard perche' quella
 * accoda sempre una sincronizzazione: passare di li' avrebbe fatto partire del
 * lavoro che nessuno ha chiesto, solo per segnare un passo come letto.
 *
 * Prima questo segno lo metteva l'endpoint del controllo, appena aveva una
 * risposta. Ma "il controllo ha risposto" e "il merchant ha visto" sono due
 * cose diverse, e confonderle si vedeva: il terzo passo si chiudeva da solo
 * nell'istante in cui si apriva, e il quarto si sbloccava insieme — con il
 * merchant davanti a due passi aperti, di cui uno che non aveva ancora letto.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) return json({ ok: false }, { status: 404 });

  await prisma.shop.update({
    where: { id: shop.id },
    data: { trackingCheckedAt: new Date() },
  });

  return json({ ok: true });
}
