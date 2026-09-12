import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { prisma } from '~/db.server';
import { requireShopCapability } from '~/lib/authz/require-capability.server';

/**
 * "Questa fonte non tocca il tracciamento": il merchant lo dichiara e non gliene
 * parliamo piu'.
 *
 * Non e' una chiusura del riquadro ma un giudizio sul merito, quindi va
 * conservato: un canale collegato per il solo catalogo resta collegato, e
 * riproporre l'avviso a ogni apertura lo renderebbe rumore.
 *
 * E si puo' disdire. Un giudizio dato per sbaglio, o cambiato dopo aver
 * guardato meglio, deve poter tornare indietro: senza, l'unico modo per
 * rivedere quell'avviso sarebbe non vederlo mai piu'.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Scrive un giudizio del merchant sulla configurazione del suo negozio: vale
  // come gli altri gesti, e chiede lo stesso permesso.
  const { shop } = await requireShopCapability(request, 'use_app');

  const form = await request.formData();
  const kind = String(form.get('kind') ?? '').trim();
  const name = String(form.get('name') ?? '').trim();

  // Solo i due tipi che sappiamo rilevare: un valore inventato creerebbe righe
  // che non corrispondono a nessuna fonte e non verrebbero mai riesaminate.
  if ((kind !== 'channel' && kind !== 'theme') || !name) {
    return json({ ok: false }, { status: 400 });
  }

  // Disdetta: la dichiarazione sparisce e la fonte torna fra quelle da
  // guardare. deleteMany e non delete: se la riga non c'e' piu' — doppio clic,
  // due schede aperte — il risultato voluto e' comunque quello.
  if (String(form.get('intent') ?? '') === 'restore') {
    await prisma.dismissedTrackingSource.deleteMany({
      where: { shopId: shop.id, kind, name },
    });
    return json({ ok: true });
  }

  await prisma.dismissedTrackingSource.upsert({
    where: { shopId_kind_name: { shopId: shop.id, kind, name } },
    create: { shopId: shop.id, kind, name },
    // Gia' dichiarata: non c'e' niente da aggiornare, ma l'upsert evita di
    // trattare come errore un doppio clic.
    update: {},
  });

  return json({ ok: true });
}
