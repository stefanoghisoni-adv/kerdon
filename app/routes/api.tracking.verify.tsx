import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { prisma } from '~/db.server';
import {
  isTrackingInstallComplete,
  installStateData,
  readInstallState,
} from '~/lib/tracking/install';
import { verifyTrackingEndpoint } from '~/lib/tracking/verify-endpoint.server';
import { requireShopCapability } from '~/lib/authz/require-capability.server';

/**
 * La verifica del giro, dietro sessione amministratore.
 *
 * PERCHE' AUTENTICATA, visto che quello che fa e' chiamare un indirizzo
 * pubblico: perche' a chiamarlo e' il nostro server, e un endpoint aperto che
 * chiama indirizzi scelti da chi passa e' un modo cortese di prestare la nostra
 * rete a chiunque. Qui l'indirizzo lo puo' scegliere solo chi amministra quel
 * negozio, e viene comunque filtrato in `verifyTrackingEndpoint`.
 *
 * L'ESITO SI SCRIVE, in tutti e due i sensi. Se passa, resta il momento in cui
 * e' passato — ed e' quello, e non la scelta della strada, a rendere completa la
 * configurazione del tracciamento. Se non passa, un'eventuale verifica
 * precedente viene tolta: dire "verificato il mese scorso" di un giro che oggi
 * non si chiude e' peggio che non dire niente.
 */
export async function action({ request }: ActionFunctionArgs) {
  // La verifica chiama davvero l'indirizzo del merchant e scrive l'esito nella
  // sua configurazione: il permesso viene prima della chiamata.
  const { shop } = await requireShopCapability(request, 'use_app');

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, { status: 405 });
  }

  const setup = await prisma.trackingSetup.findUnique({
    where: { shopId: shop.id },
    select: { installPath: true, endpoint: true, verifiedAt: true },
  });
  const state = readInstallState(setup);

  // Senza indirizzo non c'e' niente da chiamare. Non e' una verifica fallita —
  // e' una verifica che non e' stata fatta, e le due cose vanno dette in modo
  // diverso a chi legge.
  if (!state.endpoint) {
    return json({ ok: false, error: 'no_endpoint' }, { status: 400 });
  }

  const appHost = hostOf(process.env.SHOPIFY_APP_URL);
  const result = await verifyTrackingEndpoint({
    endpoint: state.endpoint,
    appHost,
    // Il dominio della vetrina, non quello `myshopify.com`: e' li' che il cookie
    // deve risultare first-party, ed e' l'unico confronto che dica qualcosa.
    storefrontDomain: shop.primaryDomain,
  });

  const next = { ...state, verifiedAt: result.passed ? new Date() : null };
  await prisma.trackingSetup.update({
    where: { shopId: shop.id },
    data: installStateData(next),
  });

  return json({
    ok: true,
    passed: result.passed,
    checks: result.checks,
    verifiedAt: next.verifiedAt?.toISOString() ?? null,
    complete: isTrackingInstallComplete(next),
  });
}

/**
 * Il nostro host, dall'indirizzo dell'app.
 *
 * Una stringa vuota se non si riesce a leggerlo: il controllo "l'endpoint non
 * sei tu" salta, ma tutti gli altri restano. Meglio una verifica un po' meno
 * severa di una che non parte perche' una variabile d'ambiente e' scritta male.
 */
function hostOf(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}
