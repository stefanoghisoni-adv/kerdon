import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { prisma } from '~/db.server';
import { requireShopCapability } from '~/lib/authz/require-capability.server';

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
  // Segna un passo della configurazione come letto: e' un gesto di chi sta
  // usando l'app, e un negozio fermo non deve poter avanzare nella propria
  // configurazione come se non lo fosse.
  const { shop } = await requireShopCapability(request, 'use_app');

  await prisma.shop.update({
    where: { id: shop.id },
    data: { trackingCheckedAt: new Date() },
  });

  return json({ ok: true });
}
