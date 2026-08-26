import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { authenticate } from '~/shopify.server';
import { prisma } from '~/db.server';
import { authorizationMessage, normalizeAuthorization } from '~/utils/authorization.server';
import { canAccessPlanTab, isSelectablePlan } from '~/components/Billing/plan-access';
import {
  cancelAppSubscription,
  createAppSubscription,
  isDevelopmentStore,
} from '~/lib/billing/subscription.server';
import { appSubscriptionGid, applyPlanToShop } from '~/lib/billing/apply-plan.server';
import { embeddedContextParams } from '~/lib/billing/embedded-return.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { forcedTestCharge } from '~/lib/billing/test-charge';
import {
  effectivePrice,
  priceForInterval,
  remainingDiscountIntervals,
  type BillingInterval,
} from '~/lib/billing/partner-pricing';
import { samePlanName } from '~/lib/billing/plan-name';
import { resolveShopPricing } from '~/lib/billing/shop-pricing.server';
import { dictionaryForShop } from '~/lib/i18n/server';
import { wantedCurrency } from '~/lib/i18n/preferences';

// Avvio del cambio di piano. Qui NON si attiva niente: l'abbonamento nasce in
// attesa di conferma e diventa effettivo solo in /billing/callback, dopo che
// Shopify ci ha detto che il merchant ha davvero approvato l'addebito.

/**
 * Risposta letta dalla tab Piano.
 *
 * `confirmationUrl` = c'e' un addebito da confermare, il client deve uscire dal
 * riquadro verso quell'indirizzo. `ok` = piano applicato subito (caso gratuito).
 * `error` = testo gia' pronto per un banner.
 */
export type SubscribeResponse =
  | { confirmationUrl: string }
  | { ok: true }
  | { error: string };

// Nessun errore mostrato al merchant racconta cosa e' andato storto dietro le
// quinte: non gli serve e non deve finire in uno screenshot al supporto.

/** Solo un id numerico puo' essere ricomposto in un gid: il resto si ignora. */
function numericChargeId(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return /^\d+$/.test(v) ? v : null;
}

export async function action({ request }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);

  // La lingua del merchant: questi messaggi finiscono tutti in un banner
  // davanti a lui.
  const t = await dictionaryForShop(session.shop);
  const GENERIC_ERROR = t.errors.planChangeFailed;

  if (request.method !== 'POST') {
    return json<SubscribeResponse>({ error: GENERIC_ERROR }, { status: 405 });
  }

  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) {
    return json<SubscribeResponse>({ error: GENERIC_ERROR }, { status: 404 });
  }

  // Il negozio bloccato dall'owner non compra nulla. La sospensione per prova
  // scaduta (PENDING) invece deve poter comprare: e' l'unica strada che gli
  // indichiamo per tornare operativo, sbarrarla lo chiuderebbe fuori per sempre.
  const authorization = normalizeAuthorization(shop.authorization);
  if (authorization === 'DISABLED') {
    return json<SubscribeResponse>(
      { error: authorizationMessage(authorization, t) },
      { status: 403 },
    );
  }

  // Piani interni assegnati dall'owner: non hanno limiti e non si acquistano.
  if (!canAccessPlanTab(shop.currentPlan)) {
    return json<SubscribeResponse>(
      { error: t.errors.planNoPurchases },
      { status: 403 },
    );
  }

  const form = await request.formData();
  const requestedName = String(form.get('plan') ?? '').trim();
  if (!requestedName) {
    return json<SubscribeResponse>({ error: t.errors.planPickOne }, { status: 400 });
  }

  const plan = await findPlanByName(requestedName);
  if (!plan || !isSelectablePlan(plan.planName)) {
    return json<SubscribeResponse>(
      { error: t.errors.planUnavailable },
      { status: 400 },
    );
  }
  if (samePlanName(plan.planName, shop.currentPlan)) {
    return json<SubscribeResponse>({ error: t.errors.planAlreadyActive }, { status: 400 });
  }

  // Ciclo di fatturazione scelto dal merchant. Qualunque valore diverso da
  // "yearly" vale mensile: e' il caso di gran lunga piu' comune e non deve
  // dipendere da come il client scrive il campo.
  const interval: BillingInterval =
    String(form.get('interval') ?? '').trim().toLowerCase() === 'yearly' ? 'yearly' : 'monthly';

  // Listino riservato del partner a cui il negozio appartiene, se ce n'e' uno.
  // Il prezzo lo si risolve QUI e non nel browser: e' quello che finisce in
  // fattura, e non puo' dipendere da cosa il client dichiara di aver visto.
  const partnerPrice = shop.partnerName
    ? await prisma.partnerPlanPrice.findUnique({
        where: {
          partnerName_planName: { partnerName: shop.partnerName, planName: plan.planName },
        },
      })
    : null;

  // Da quando lo sconto e' in corso: il primo addebito che si e' attivato su
  // questo negozio. Serve a contare i cicli gia' consumati, che non vanno
  // regalati una seconda volta su un piano nuovo. Si legge solo se c'e' davvero
  // uno sconto con una durata, altrimenti e' una query per niente.
  const firstActivatedAt =
    partnerPrice && shop.discountIntervals != null
      ? (
          await prisma.billingCharge.findFirst({
            where: { shopId: shop.id, activatedAt: { not: null } },
            orderBy: { activatedAt: 'asc' },
            select: { activatedAt: true },
          })
        )?.activatedAt ?? null
      : null;

  // In che valuta si addebita, e a che prezzo in quella valuta. E' la stessa
  // risposta che ha prodotto le card: un prezzo mostrato in una valuta e
  // addebitato in un'altra non e' un dettaglio, e' una cifra che il merchant
  // non ha mai accettato.

  const allPlans = await prisma.plan.findMany({ select: { planName: true } });
  const pricing = await resolveShopPricing(allPlans, {
    preferredCurrency: wantedCurrency(shop),
    hasReservedPrice: partnerPrice != null,
  });

  const pricedPlan = pricing.plans.find((p) => samePlanName(p.planName, plan.planName));

  // Nessun prezzo per questo piano: non si addebita. Prima qui c'era un
  // ripiego sulle colonne del piano, che ora non esistono piu' — e comunque un
  // ripiego non e' quello che serve quando si sta per far pagare qualcuno.
  // Meglio un errore che una cifra scelta dal codice.
  if (!pricedPlan) {
    console.error(`[billing] nessun prezzo a listino per "${plan.planName}"`);
    return json({ error: 'plan_not_priced' }, { status: 409 });
  }

  const listPrice = priceForInterval(
    { priceMonthly: pricedPlan.priceMonthly, priceYearly: pricedPlan.priceYearly },
    interval,
  );

  const effective = effectivePrice(
    listPrice,
    partnerPrice ? priceForInterval(
      { priceMonthly: Number(partnerPrice.priceMonthly), priceYearly: Number(partnerPrice.priceYearly) },
      interval,
    ) : null,
    // I cicli che restano, non quelli concordati: chi ha gia' fatto tre mesi di
    // sconto sul piano precedente non ne ricomincia altri tre su quello nuovo.
    // Lo sconto e' uno solo, e cambiare piano non lo rinnova.
    remainingDiscountIntervals(shop.discountIntervals, firstActivatedAt, interval),
  );

  const price = effective.payablePrice;

  try {
    // Piano gratuito: non c'e' niente da far confermare, quindi si chiude subito
    // l'abbonamento in corso (altrimenti Shopify continuerebbe ad addebitarlo) e
    // si applica il piano senza uscire dal riquadro.
    if (!(price > 0)) {
      const activeChargeId = numericChargeId(shop.activeChargeId);
      if (activeChargeId) {
        await cancelAppSubscription(admin, appSubscriptionGid(activeChargeId));
        await prisma.billingCharge.updateMany({
          where: { shopId: shop.id, shopifyChargeId: BigInt(activeChargeId) },
          data: { status: 'cancelled', cancelledAt: new Date() },
        });
      }
      await applyPlanToShop({
        shopId: shop.id,
        planName: plan.planName,
        chargeId: null,
        trialDays: null,
      });
      return json<SubscribeResponse>({ ok: true });
    }

    // Sui negozi di sviluppo Shopify rifiuta gli addebiti reali: l'abbonamento
    // va creato di prova, altrimenti la mutation fallisce e il merchant resta
    // fermo sulla tab senza capire perche'.
    //
    // SHOPIFY_BILLING_TEST=true forza l'addebito di prova anche su un negozio
    // normale: serve a provare l'attivazione dei piani end-to-end senza pagare.
    // Se e' acceso non c'e' bisogno di chiedere niente a Shopify.
    const test =
      forcedTestCharge(process.env.SHOPIFY_BILLING_TEST) ||
      (await isDevelopmentStore(admin));

    const requestUrl = new URL(request.url);
    const params = embeddedContextParams({
      requestUrl,
      shopDomain: shop.shopDomain,
      host: typeof form.get('host') === 'string' ? String(form.get('host')) : null,
    });
    // Chi ha scelto il piano dal terzo passo della dashboard ci torna: la
    // configurazione si chiude li'. Si accetta la sola parola 'dashboard', e a
    // che indirizzo corrisponda lo decide la callback.
    if (String(form.get('returnTo') ?? '') === 'dashboard') {
      params.set('return_to', 'dashboard');
    }
    const returnUrl = new URL(
      `/billing/callback?${params.toString()}`,
      process.env.SHOPIFY_APP_URL || requestUrl.origin,
    ).toString();

    const created = await createAppSubscription(admin, {
      planName: plan.planName,
      // A Shopify va il prezzo di LISTINO, con lo sconto a parte: e' l'unico
      // modo perche' allo scadere dei cicli concordati il prezzo pieno riparta
      // da solo.
      price: effective.listPrice,
      currency: pricing.currency,
      interval,
      trialDays: plan.trialDays,
      returnUrl,
      test,
      discount: effective.discountAmount > 0
        ? { amount: effective.discountAmount, intervals: effective.discountIntervals }
        : null,
    });

    // La riga nasce "pending" apposta: e' la traccia che ci permette, al
    // ritorno, di riconoscere un addebito che abbiamo avviato noi.
    await prisma.billingCharge.create({
      data: {
        shopId: shop.id,
        shopifyChargeId: created.chargeId,
        planType: plan.planName,
        // Cio' che il merchant paga davvero, e con quale cadenza. Prima era
        // fisso su plan.priceMonthly e 'monthly': su un abbonamento annuale
        // avrebbe registrato il prezzo di un mese, e a un negozio con prezzo
        // riservato il listino invece della cifra concordata. E' la riga su cui
        // si guarda quando un merchant chiede conto di un addebito.
        price: effective.payablePrice,
        currency: pricing.currency,
        billingCycle: interval,
        status: 'pending',
        trialDays: plan.trialDays ?? 0,
        confirmationUrl: created.confirmationUrl,
      },
    });

    return json<SubscribeResponse>({ confirmationUrl: created.confirmationUrl });
  } catch (e) {
    console.error(
      '[billing.subscribe]',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return json<SubscribeResponse>({ error: GENERIC_ERROR }, { status: 500 });
  }
}
