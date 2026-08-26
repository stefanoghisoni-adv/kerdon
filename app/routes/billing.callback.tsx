import type { LoaderFunctionArgs } from '@remix-run/node';
import { redirect } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import {
  cancelAppSubscription,
  getActiveSubscriptions,
  getSubscription,
  parseGidId,
  type BillingAdmin,
} from '~/lib/billing/subscription.server';
import { appSubscriptionGid, applyPlanToShop } from '~/lib/billing/apply-plan.server';
import { adminAppUrl, embeddedContextParams } from '~/lib/billing/embedded-return.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';

// Ritorno da Shopify dopo che il merchant ha approvato (o rifiutato) l'addebito.
//
// Il `charge_id` in querystring lo scrive il browser e non prova niente: da solo
// basterebbe indovinarne uno per regalarsi un piano a pagamento. L'unica fonte
// che accettiamo e' Shopify, riletta qui sotto, e il piano si attiva solo se
// l'abbonamento risulta davvero ACTIVE.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Esito riportato alla tab Piano in `?billing=`.
 * `ok` = piano attivato, `ko` = tutto invariato (rifiuto, approvazione non
 * completata o guasto). Sono due soli valori apposta: alla tab serve scegliere
 * fra un banner di conferma e uno di "non e' andata", non la diagnosi.
 */
type Outcome = 'ok' | 'ko';

/**
 * Dove torna il merchant dopo l'approvazione: sempre la dashboard.
 *
 * Prima chi era partito dalla tab Piano ci tornava, e l'indirizzo di rientro
 * portava un sotto-percorso dopo l'id dell'app
 * (`/store/<negozio>/apps/<id>/plan`). Quel giro finiva su un riquadro vuoto —
 * niente contenuto, nemmeno il menu — e l'unico modo di uscirne era ricaricare
 * la pagina intera o riaprire l'app dall'elenco. Dopo aver pagato.
 *
 * Senza sotto-percorso l'indirizzo e' quello canonico con cui l'admin apre
 * un'app, e il riquadro si carica come quando la si apre dal menu. La dashboard
 * e' anche la destinazione piu' utile: il piano nuovo si vede li', e chi ha
 * appena pagato non ha altro da fare sul listino.
 *
 * L'esito viaggia in `?billing=`, che la dashboard legge gia'.
 */
function backToPlan(requestUrl: URL, shopDomain: string, outcome: Outcome): Response {
  // Si rientra dall'admin, non dall'indirizzo dell'app: cosi' e' l'admin ad
  // aprire il riquadro con la sessione gia' buona, invece di chiedere all'app
  // di rientrare da sola — un giro che, inceppandosi, lasciava il merchant
  // davanti a una pagina bianca dopo aver pagato.
  const adminUrl = adminAppUrl({
    shopDomain,
    params: new URLSearchParams({ billing: outcome }),
  });
  if (adminUrl) return redirect(adminUrl);

  // Senza la chiave dell'app quell'indirizzo non si compone: si ripiega sulla
  // rotta diretta, con shop/host/embedded in coda perche' possa rientrare.
  const params = embeddedContextParams({ requestUrl, shopDomain });
  params.set('billing', outcome);
  return redirect(`/?${params.toString()}`);
}

/**
 * Come registrare l'addebito quando l'abbonamento non e' attivo.
 * Null = non toccarlo: PENDING e' un'approvazione ancora aperta, e un
 * abbonamento che Shopify non conosce non e' roba nostra da archiviare.
 */
function chargeStatusFor(status: string | undefined): string | null {
  if (status === 'DECLINED') return 'declined';
  if (status === 'CANCELLED' || status === 'EXPIRED' || status === 'FROZEN') return 'cancelled';
  return null;
}

/**
 * Chiude gli abbonamenti rimasti attivi oltre a quello appena confermato.
 *
 * Shopify li lascia convivere: senza questa pulizia il merchant si ritroverebbe
 * due addebiti in fattura. Best effort e in coda a tutto, perche' a questo punto
 * il piano e' gia' stato applicato e un errore qui non deve annullarlo.
 */
async function cancelPreviousSubscriptions(
  admin: BillingAdmin,
  shopId: string,
  keepGid: string,
): Promise<void> {
  try {
    const actives = await getActiveSubscriptions(admin);
    for (const sub of actives) {
      if (sub.gid === keepGid) continue;
      await cancelAppSubscription(admin, sub.gid);
      await prisma.billingCharge.updateMany({
        where: { shopId, shopifyChargeId: parseGidId(sub.gid) },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
    }
  } catch (e) {
    console.warn(
      '[billing.callback] chiusura degli abbonamenti precedenti fallita:',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const requestUrl = new URL(request.url);
  const shopDomain = session.shop;

  const chargeIdRaw = (requestUrl.searchParams.get('charge_id') ?? '').trim();
  if (!/^\d+$/.test(chargeIdRaw)) {
    return backToPlan(requestUrl, shopDomain, 'ko');
  }

  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) {
    return backToPlan(requestUrl, shopDomain, 'ko');
  }

  const gid = appSubscriptionGid(chargeIdRaw);

  try {
    const subscription = await getSubscription(admin, gid);

    // Il piano si riconosce dal nome dell'abbonamento, che e' quello che gli
    // abbiamo dato noi alla creazione: un abbonamento con un nome fuori dal
    // listino non e' uno dei nostri e non deve cambiare niente.
    const plan =
      subscription?.status === 'ACTIVE'
        ? await findPlanByName(subscription.name)
        : null;

    if (!subscription || subscription.status !== 'ACTIVE' || !plan) {
      const status = chargeStatusFor(subscription?.status);
      if (status) {
        // updateMany filtrato sullo shop: un charge_id indovinato non puo'
        // toccare le righe di un altro negozio.
        await prisma.billingCharge.updateMany({
          where: { shopId: shop.id, shopifyChargeId: BigInt(chargeIdRaw) },
          data: { status, cancelledAt: new Date() },
        });
      }
      return backToPlan(requestUrl, shopDomain, 'ko');
    }

    const now = new Date();
    // I giorni di prova buoni sono quelli che Shopify ha davvero concesso: il
    // listino puo' essere cambiato fra la richiesta e la conferma.
    const trialDays = subscription.trialDays ?? 0;

    await prisma.billingCharge.updateMany({
      where: { shopId: shop.id, shopifyChargeId: BigInt(chargeIdRaw) },
      data: {
        status: 'active',
        activatedAt: now,
        trialDays,
        trialEndsAt: trialDays > 0 ? new Date(now.getTime() + trialDays * DAY_MS) : null,
      },
    });

    await applyPlanToShop({
      shopId: shop.id,
      planName: plan.planName,
      chargeId: chargeIdRaw,
      trialDays,
      now,
    });

    await cancelPreviousSubscriptions(admin, shop.id, gid);

    return backToPlan(requestUrl, shopDomain, 'ok');
  } catch (e) {
    console.error(
      '[billing.callback]',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return backToPlan(requestUrl, shopDomain, 'ko');
  }
}
