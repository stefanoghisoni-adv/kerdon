import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import {
  issueIngestKey,
  listIngestKeys,
  revokeAllIngestKeys,
  revokeIngestKey,
} from '~/lib/ingest/ingest-key.server';
import { INGEST_ROTATION_OVERLAP_MS } from '~/lib/ingest/ingest-model';

/**
 * La chiave di scrittura del negozio: emetterla, ruotarla, chiuderla.
 *
 * IL VALORE ESCE DA QUI E DA NESSUN ALTRO POSTO, ed e' tutta la differenza con
 * la chiave di lettura. Quella si rilegge da Impostazioni ogni volta che serve,
 * perche' e' cifrata in una colonna apposta per poterla rimostrare. Questa no:
 * sul database c'e' il segreto sigillato per poter VERIFICARE una firma, e
 * nessuna rotta lo riapre per rimandarlo indietro. Il valore intero esiste nella
 * risposta a questa chiamata e poi non lo sa piu' nessuno.
 *
 * Non e' rigore per il rigore. Una chiave rileggibile e' una chiave che chiunque
 * apra quella schermata puo' portarsi via mesi dopo, e le schermate dell'app le
 * apre chiunque abbia accesso all'admin del negozio. Una che si vede una volta
 * sola circola una volta sola.
 *
 * PERCHE' EMETTERE E RUOTARE SONO LO STESSO GESTO: la differenza fra i due e'
 * soltanto se prima c'era qualcosa, e tenerli separati vorrebbe dire due strade
 * che devono restare d'accordo su cosa succede alle credenziali di prima — ed e'
 * li' che si dimentica di farle scadere. Le vecchie non si revocano: ricevono
 * una finestra, il tempo che il merchant pubblichi il valore nuovo nel proprio
 * container. Chi invece sa di avere una chiave in mano a qualcun altro non
 * ruota: revoca, e quella non ha nessuna finestra.
 */
export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
  }

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    select: { id: true },
  });
  if (!shop) return json({ ok: false, error: 'shop_not_found' }, { status: 404 });

  const body = (await request.json().catch(() => null)) as {
    intent?: unknown;
    keyId?: unknown;
  } | null;

  const now = new Date();

  if (body?.intent === 'revoke') {
    // Una sola credenziale quando si sa quale, tutte quando non si sa — che e'
    // il caso del "l'ho persa": chi non sa dove sia finita non sa nemmeno quale
    // fosse, e chiedergli di sceglierla da un elenco sarebbe chiedergli proprio
    // la cosa che non ha.
    const revocate =
      typeof body.keyId === 'string' && body.keyId.trim()
        ? (await revokeIngestKey(shop.id, body.keyId.trim(), now))
          ? 1
          : 0
        : await revokeAllIngestKeys(shop.id, now);

    return json({ ok: true, revoked: revocate, keys: await elenco(shop.id) });
  }

  if (body?.intent !== 'issue') {
    return json({ ok: false, error: 'unknown_intent' }, { status: 400 });
  }

  const credenziale = await issueIngestKey(shop.id, { now });

  return json({
    ok: true,
    // L'unica volta in cui questo valore esiste fuori dal database.
    value: credenziale.value,
    keyId: credenziale.keyId,
    // Fino a quando le credenziali di prima continuano a funzionare: serve al
    // messaggio che il merchant legge subito dopo aver ruotato, ed e' la sola
    // cosa che gli dica quanto tempo ha per pubblicare il valore nuovo.
    previousValidUntil: new Date(now.getTime() + INGEST_ROTATION_OVERLAP_MS).toISOString(),
    keys: await elenco(shop.id),
  });
}

/** Le credenziali del negozio come si mostrano: mai il valore, mai il segreto. */
async function elenco(shopId: string) {
  return (await listIngestKeys(shopId)).map((chiave) => ({
    keyId: chiave.keyId,
    scopes: chiave.scopes,
    issuedAt: chiave.issuedAt.toISOString(),
    expiresAt: chiave.expiresAt?.toISOString() ?? null,
    revokedAt: chiave.revokedAt?.toISOString() ?? null,
    lastUsedAt: chiave.lastUsedAt?.toISOString() ?? null,
  }));
}
