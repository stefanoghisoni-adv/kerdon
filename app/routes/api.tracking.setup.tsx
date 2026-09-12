import { dictionaryForShop } from '~/lib/i18n/server';
import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { prisma } from '~/db.server';
import { requireShopCapability } from '~/lib/authz/require-capability.server';
import {
  isServerSideAnswer,
  knownPlatforms,
} from '~/components/Dashboard/tracking-platforms';

/**
 * La risposta del merchant sull'infrastruttura server side.
 *
 * Non manda nessuna email: la richiesta resta registrata qui, ed e' da qui che
 * si vede chi va ricontattato. Una riga per negozio — se cambia idea, la nuova
 * risposta sostituisce la vecchia.
 */
export async function action({ request }: ActionFunctionArgs) {
  // Il permesso prima del corpo della richiesta: quel che il merchant dichiara
  // qui finisce nella sua configurazione, e la configurazione di un negozio
  // fermo non si tocca.
  const { shop } = await requireShopCapability(request, 'use_app');

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Richiesta non valida' }, { status: 405 });
  }

  const body = (await request.json()) as { answer?: unknown; platforms?: unknown };
  if (!isServerSideAnswer(body.answer)) {
    return json({ ok: false, error: 'Risposta non valida' }, { status: 400 });
  }

  // Solo i nomi del catalogo: l'elenco arriva dal browser.
  //
  // E la scelta di installazione sopravvive, perche' vive nella stessa colonna.
  // Non e' un dettaglio: senza questo, rispondere alla domanda sull'infrastruttura
  // La strada scelta e l'esito della verifica stanno in colonne loro, quindi
  // riscrivere le piattaforme non li tocca piu'. Prima vivevano dentro questo
  // stesso elenco, e rispondere alla domanda sull'infrastruttura li cancellava:
  // il tracciamento tornava "da configurare" per un gesto che non c'entrava.
  const platforms = knownPlatforms(body.platforms);

  try {
    await prisma.trackingSetup.upsert({
      where: { shopId: shop.id },
      create: { shopId: shop.id, answer: body.answer, platforms },
      update: { answer: body.answer, platforms, answeredAt: new Date() },
    });
    // Nel registro del server resta la traccia leggibile: e' il modo piu' rapido
    // per accorgersi di una richiesta senza andare a guardare la tabella.
    if (body.answer === 'needs') {
      console.info(
        `[tracking-setup] ${shop.shopDomain} chiede un'infrastruttura server side per: ${
          platforms.join(', ') || 'nessuna piattaforma indicata'
        }`,
      );
    }
    return json({ ok: true });
  } catch (err) {
    console.error(
      '[api.tracking.setup]',
      err instanceof Error ? err.message : 'errore sconosciuto',
    );
    return json(
      {
        ok: false,
        error: (await dictionaryForShop(shop.shopDomain)).errors.trackingAnswerFailed,
      },
      { status: 500 },
    );
  }
}
