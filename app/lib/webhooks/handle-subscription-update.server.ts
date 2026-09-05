// app/lib/webhooks/handle-subscription-update.server.ts
//
// La macchina a stati dell'abbonamento, adesso che gira dopo la ricevuta.
//
// La rotta billing/callback copre il caso "il merchant approva e torna
// sull'app". Questo webhook copre tutto il resto: la disdetta dal pannello del
// negozio, la carta rifiutata, la scadenza, il congelamento — cambiamenti che
// accadono senza che nessuno apra l'app. Senza, un negozio continuerebbe a
// usare un piano che non paga piu'.
//
// COS'E' CAMBIATO. Prima ogni ramo finiva con un 200, compreso quello in cui
// non si era fatto niente perche' qualcosa era andato storto. Il caso peggiore
// era il listino senza piano gratuito: si scriveva "impossibile retrocedere",
// si rispondeva riuscito, e da li' in poi non ci tornava sopra nessuno — il
// negozio restava su un piano a pagamento senza abbonamento che lo sostenesse.
// Adesso quel caso e' lettera morta con allarme: si smette di riprovare perche'
// riprovare non cambierebbe niente, ma non si dichiara fatto quel che non e'
// stato fatto.
//
// COSA SIGNIFICANO I TRE ESITI QUI DENTRO:
//   done         l'effetto e' applicato, oppure non c'era niente da applicare
//                (uno stato transitorio, un piano non nostro, un negozio mai
//                visto). Sono esiti definitivi, non rinunce.
//   retry        qualcosa non ha risposto. Il negozio resta com'e' e si riprova.
//   dead_letter  riprovare darebbe lo stesso risultato: un corpo che non si
//                riesce a leggere, un listino senza piano gratuito.

import { prisma } from '~/db.server';
import { applyPlanToShop } from '~/lib/billing/apply-plan.server';
import { parseGidId } from '~/lib/billing/subscription.server';
import { findFreePlan, findPlanByName } from '~/lib/billing/find-plan.server';
import { samePlanName } from '~/lib/billing/plan-name';
import { subscriptionOutcome } from '~/lib/billing/subscription-status';
import type { ClaimedWebhookEvent } from './inbox.server';
import type { WebhookOutcome } from './inbox-model';

interface AppSubscriptionPayload {
  app_subscription?: {
    admin_graphql_api_id?: string;
    name?: string;
    status?: string;
  };
}

export async function handleSubscriptionUpdate(
  event: ClaimedWebhookEvent,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  const payload = event.payload as AppSubscriptionPayload | null;
  const subscription = payload?.app_subscription;

  if (
    !subscription?.admin_graphql_api_id ||
    !subscription.name ||
    !subscription.status
  ) {
    // Lettera morta e non ritentativo: lo stesso corpo darebbe lo stesso esito
    // per cinque giri, e l'unica cosa che cambierebbe sarebbe il momento in cui
    // qualcuno se ne accorge.
    console.error(
      `[app_subscriptions/update] corpo senza i campi minimi per ${event.shopDomain}`,
    );
    return 'dead_letter';
  }

  const shop = await prisma.shop.findUnique({ where: { shopDomain: event.shopDomain } });

  // Negozio mai visto, o gia' cancellato: non c'e' niente da applicare, e non
  // e' un fallimento. La riga si chiude.
  if (!shop) return 'done';

  // Il riferimento interno sull'evento: da qui in poi l'evento si ritrova
  // partendo dal negozio, senza rimettere il dominio in altre query.
  await prisma.webhookEvent.updateMany({
    where: { id: event.id },
    data: { shopId: shop.id },
  });

  const subscriptionId = parseGidId(subscription.admin_graphql_api_id);
  const subscriptionIdStr = subscriptionId.toString();
  const esito = subscriptionOutcome(subscription.status);

  // PENDING, ACCEPTED, o stati sconosciuti: non si tocca niente, ed e' una
  // decisione definitiva su questa consegna. Quando quell'abbonamento diventera'
  // qualcos'altro arrivera' un'altra consegna.
  if (esito === 'ignore') return 'done';

  if (esito === 'active') {
    return applyActiveSubscription(shop, subscription.name, subscriptionId, now);
  }

  // PUNTO CRITICO: si agisce SOLO se questo abbonamento e' quello attivo dello
  // shop. Durante un cambio di piano la callback cancella di proposito
  // l'abbonamento precedente, e Shopify manda un CANCELLED per quello. Senza
  // questo controllo, il merchant che ha appena pagato un aggiornamento verrebbe
  // immediatamente retrocesso al piano gratuito.
  //
  // E' anche cio' che rende idempotente la retrocessione: la prima lavorazione
  // azzera `activeChargeId`, quindi la seconda consegna dello stesso
  // abbonamento non lo riconosce piu' come l'attivo e si ferma qui.
  if (shop.activeChargeId !== subscriptionIdStr) return 'done';

  return downgradeToFreePlan(shop, subscriptionId, now);
}

/**
 * La forma minima di negozio che questa macchina a stati legge.
 *
 * Ristretta di proposito: cosi' la riconciliazione puo' passare la sua riga
 * senza rileggere il negozio per intero, e chi aggiunge un campo alla decisione
 * se ne accorge qui invece che a runtime.
 */
export interface SubscriptionShopRow {
  id: string;
  shopDomain: string;
  currentPlan: string;
  activeChargeId: string | null;
}

/**
 * Porta il negozio sull'abbonamento attivo che Shopify dichiara.
 *
 * Esportata perche' i chiamanti sono due: questo webhook e la riconciliazione
 * periodica, che trova su Shopify un abbonamento attivo di cui da noi non
 * risulta niente — cioe' proprio l'evento che si e' perso.
 */
export async function applyActiveSubscription(
  shop: SubscriptionShopRow,
  planName: string,
  subscriptionId: bigint,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  const subscriptionIdStr = subscriptionId.toString();
  const plan = await findPlanByName(planName);

  // Nome fuori dal listino: non e' un abbonamento gestito da questa app.
  // Definitivo, non un fallimento — ritentare non lo farebbe comparire.
  if (!plan) return 'done';

  // Gia' allineato: non riscrivere. Shopify puo' rimandare lo stesso ACTIVE piu'
  // volte, e riapplicare il piano farebbe ripartire da capo il periodo di prova
  // (`trialEndsAt` viene ricalcolato da adesso), regalando giorni gratis a ogni
  // consegna ripetuta.
  if (
    samePlanName(shop.currentPlan, plan.planName) &&
    shop.activeChargeId === subscriptionIdStr
  ) {
    return 'done';
  }

  await applyPlanToShop({
    shopId: shop.id,
    planName: plan.planName,
    chargeId: subscriptionIdStr,
    trialDays: plan.trialDays,
    now,
  });

  // Segna l'addebito come attivo, se esiste. updateMany filtrato sullo shop: un
  // charge_id che arriva da fuori non puo' toccare le righe di un altro negozio.
  await prisma.billingCharge.updateMany({
    where: { shopId: shop.id, shopifyChargeId: subscriptionId },
    data: { status: 'active', activatedAt: now },
  });

  return 'done';
}

/**
 * Riporta il negozio al piano gratuito, chiudendo l'addebito indicato.
 *
 * Non controlla che quell'abbonamento sia l'attivo: lo fa chi chiama, e i due
 * chiamanti lo sanno in due modi diversi — il webhook confrontando l'id che gli
 * arriva, la riconciliazione constatando che su Shopify non c'e' piu' niente di
 * attivo.
 */
export async function downgradeToFreePlan(
  shop: SubscriptionShopRow,
  subscriptionId: bigint,
  now: Date = new Date(),
): Promise<WebhookOutcome> {
  const freePlan = await findFreePlan();

  if (!freePlan) {
    // Il caso che prima si dichiarava riuscito. Non si inventa un nome — la
    // chiave esterna su `shops.current_plan` lo rifiuterebbe comunque — e non
    // si ritenta, perche' il listino non cambia da solo fra un giro e l'altro.
    // Si chiama qualcuno, e il negozio resta com'e' finche' non arriva.
    console.error(
      `[app_subscriptions/update] nessun piano gratuito nel listino: il negozio ` +
        `${shop.shopDomain} non puo' essere riportato al gratuito`,
    );
    return 'dead_letter';
  }

  // Riapplicare il piano ricalcolerebbe `trialEndsAt` da adesso: e' per questo
  // che chi chiama deve gia' aver stabilito che c'e' davvero qualcosa da
  // retrocedere. Una prova che riparte a ogni consegna ripetuta e' un regalo
  // che nessuno ha deciso di fare.
  await applyPlanToShop({
    shopId: shop.id,
    planName: freePlan.planName,
    chargeId: null,
    // Nessuna prova: la si concede quando un piano si attiva, non quando un
    // abbonamento finisce.
    trialDays: null,
    now,
  });

  await prisma.billingCharge.updateMany({
    where: { shopId: shop.id, shopifyChargeId: subscriptionId },
    data: { status: 'cancelled', cancelledAt: now },
  });

  return 'done';
}
