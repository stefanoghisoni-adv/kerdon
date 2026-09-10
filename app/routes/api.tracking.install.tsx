import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import {
  isInstallPath,
  isTrackingInstallComplete,
  normalizeEndpoint,
  installStateData,
  readInstallState,
  withInstall,
} from '~/lib/tracking/install';

/**
 * La strada di installazione scelta dal merchant, e dove risponde il suo
 * endpoint.
 *
 * Due valori soli, e nessuno dei due e' un interruttore: dicono con che cosa il
 * negozio chiude il giro del tracciamento — un container server-side di Google
 * Tag Manager oppure un Worker di Cloudflare — e a quale indirizzo. Le
 * istruzioni che il merchant legge dipendono dal primo; la verifica chiama il
 * secondo.
 *
 * SALVARE NON VERIFICA NIENTE, ed e' apposta. Qui si registra un'intenzione:
 * "installero' cosi', li'". Che quel li' risponda, e risponda bene, lo dice
 * `/api/tracking/verify` chiamando davvero. Tenere separate le due cose e' cio'
 * che impedisce a una configurazione dichiarata di passare per una funzionante
 * — che e' il modo in cui un merchant arriva in fondo e non traccia niente.
 *
 * E CAMBIARE UNO DEI DUE ANNULLA LA VERIFICA PRECEDENTE. Non lo decide questa
 * rotta ma `withInstall`, cosi' non c'e' nessun percorso di codice da cui si
 * possa dimenticarsene.
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
    path?: unknown;
    endpoint?: unknown;
  } | null;

  const path = isInstallPath(body?.path) ? body.path : null;
  if (body?.path !== undefined && body?.path !== null && path === null) {
    return json({ ok: false, error: 'unknown_path' }, { status: 400 });
  }

  // L'indirizzo puo' mancare — si sceglie la strada prima di aver installato
  // qualcosa — ma se c'e' deve essere un https valido. Rifiutarlo adesso, con
  // il merchant che lo sta ancora scrivendo, e' piu' utile che farglielo
  // scoprire da una verifica che fallisce per un motivo che sembra un altro.
  const written = body?.endpoint;
  const endpoint = normalizeEndpoint(written);
  if (typeof written === 'string' && written.trim() !== '' && endpoint === null) {
    return json({ ok: false, error: 'invalid_endpoint' }, { status: 400 });
  }

  const existing = await prisma.trackingSetup.findUnique({
    where: { shopId: shop.id },
    select: { installPath: true, endpoint: true, verifiedAt: true },
  });

  const next = withInstall(readInstallState(existing), { path, endpoint });
  const data = installStateData(next);

  const saved = await prisma.trackingSetup.upsert({
    where: { shopId: shop.id },
    // `answer` non ha un valore neutro e la colonna e' obbligatoria: chi sceglie
    // come installare sta dichiarando di occuparsene da se', che e' esattamente
    // cio' che quella risposta significa. Se una risposta c'era gia', l'update
    // non la tocca.
    create: { shopId: shop.id, answer: 'has', platforms: [], ...data },
    update: data,
    select: { installPath: true, endpoint: true, verifiedAt: true },
  });

  const state = readInstallState(saved);

  return json({
    ok: true,
    path: state.path,
    endpoint: state.endpoint,
    verifiedAt: state.verifiedAt?.toISOString() ?? null,
    complete: isTrackingInstallComplete(state),
  });
}
