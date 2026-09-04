import type { LoaderFunctionArgs } from '@remix-run/node';
import { redirect } from '@remix-run/node';
import type { BillingCharge, Shop } from '@prisma/client';
import { unauthenticated } from '~/shopify.server';
import { prisma } from '~/db.server';
import {
  getSubscription,
  type AppSubscriptionSummary,
  type BillingAdmin,
} from '~/lib/billing/subscription.server';
import { appSubscriptionGid, applyPlanToShop } from '~/lib/billing/apply-plan.server';
import {
  drainSupersededCharges,
  enqueueUnknownActiveSubscriptions,
  markSupersededCharges,
} from '~/lib/billing/cancel-outbox.server';
import { adminAppUrl, embeddedContextParams } from '~/lib/billing/embedded-return.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { samePlanName } from '~/lib/billing/plan-name';
import { notAbove, sameAmount } from '~/lib/billing/amount';
import {
  verifyBillingState,
  type BillingAttemptState,
} from '~/lib/billing/callback-state.server';

// Ritorno da Shopify dopo che il merchant ha approvato (o rifiutato) l'addebito.
//
// Il `charge_id` in querystring lo scrive il browser e non prova niente: da solo
// basterebbe indovinarne uno per regalarsi un piano a pagamento. L'unica fonte
// che accettiamo e' Shopify, riletta qui sotto, e il piano si attiva solo se
// l'abbonamento risulta davvero ACTIVE.
//
// Ma "l'abbonamento e' attivo" non basta a rispondere alla domanda vera, che e':
// QUESTA callback sta chiudendo un tentativo, o sta ripetendo qualcosa di gia'
// fatto? Finche' bastava un abbonamento attivo, un semplice ricaricamento della
// pagina riapplicava il piano: `planStartedAt` e `trialEndsAt` ripartivano da
// capo — cioe' il periodo di prova si allungava di un giro a ogni F5 — e gli
// abbonamenti precedenti venivano ri-cancellati. La `updateMany` che avrebbe
// dovuto marcare il tentativo poteva aggiornare zero righe senza che nessuno se
// ne accorgesse, e il piano cambiava lo stesso.
//
// Da qui in avanti un'attivazione NUOVA ha tre condizioni, tutte e tre
// necessarie:
//
//  1. uno `state` firmato da noi, verificato prima di leggere o scrivere
//     qualunque cosa. E' l'unico modo di sapere quale tentativo sta chiudendo
//     questa callback: senza, al ritorno ci sono solo un id e un negozio;
//  2. i conti che tornano fra le tre fonti — lo state, la riga del tentativo e
//     l'abbonamento come lo dichiara Shopify: nonce, piano, valuta, importo e
//     cadenza. Una discordanza non e' piu' un'anomalia da annotare: e' un
//     tentativo che non riconosciamo, e non attiva niente;
//  3. il tentativo ancora da spendere, verificato e speso nello stesso gesto
//     dentro la transazione (`status = pending`, quel nonce, mai usato). Il
//     piano si applica solo se quella scrittura ha toccato ESATTAMENTE una
//     riga.
//
// Quando la terza non passa — ed e' il caso normale del ricaricamento — resta
// una sola risposta ammessa: il replay idempotente. Se il negozio risulta gia'
// su quell'addebito, su quel piano e con quella cadenza, si risponde che e'
// andata bene e non si scrive niente: nessun timestamp riscritto, nessun
// abbonamento ri-cancellato. In tutti gli altri casi non e' andata.
//
// Le callback vecchie, quelle senza state, ricadono per forza in questo secondo
// ramo: possono confermare un piano gia' applicato, non attivarne uno nuovo.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Esito riportato alla tab Piano in `?billing=`.
 * `ok` = piano attivato, `ko` = tutto invariato (rifiuto, approvazione non
 * completata o guasto). Sono due soli valori apposta: alla tab serve scegliere
 * fra un banner di conferma e uno di "non e' andata", non la diagnosi.
 */
type Outcome = 'ok' | 'ko';

/** Ogni quanto si paga, quando lo si sa. */
type Interval = 'monthly' | 'yearly';

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
function backToPlan(
  requestUrl: URL,
  shopDomain: string,
  outcome: Outcome,
  firstPlan = false,
): Response {
  // Si rientra dall'admin, non dall'indirizzo dell'app: cosi' e' l'admin ad
  // aprire il riquadro con la sessione gia' buona, invece di chiedere all'app
  // di rientrare da sola — un giro che, inceppandosi, lasciava il merchant
  // davanti a una pagina bianca dopo aver pagato.
  const params = new URLSearchParams({ billing: outcome });
  if (firstPlan) params.set('first', '1');

  const adminUrl = adminAppUrl({ shopDomain, params });
  if (adminUrl) return redirect(adminUrl);

  // Senza la chiave dell'app quell'indirizzo non si compone: si ripiega sulla
  // rotta diretta, con shop/host/embedded in coda perche' possa rientrare.
  const fallback = embeddedContextParams({ requestUrl, shopDomain });
  fallback.set('billing', outcome);
  if (firstPlan) fallback.set('first', '1');
  return redirect(`/?${fallback.toString()}`);
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

/** Due valute uguali a meno di maiuscole e spazi. */
function sameCurrency(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? '').trim().toUpperCase();
  if (!left) return false;
  return left === (b ?? '').trim().toUpperCase();
}

/**
 * Tutto quello che, in questa callback, non torna con il tentativo che dovrebbe
 * averla aperta.
 *
 * Restituisce una lista di frasi, e la lista vuota e' l'unico esito che
 * autorizza un'attivazione nuova. Le frasi non servono solo a decidere: sono
 * quello che si legge nei log quando un merchant chiede conto di un addebito, e
 * "il piano confermato non e' quello richiesto" vale piu' di un rifiuto muto.
 *
 * La regola su cui si confrontano gli importi, che e' la parte in cui e' facile
 * sbagliarsi: lo state porta il prezzo di LISTINO, perche' e' quello che
 * comunichiamo a Shopify — lo sconto riservato viaggia a parte e Shopify
 * rilegge il listino. Sulla riga del tentativo invece e' scritta la cifra che
 * il merchant paga davvero. Quindi il listino si confronta con l'importo che
 * Shopify dichiara (devono essere lo stesso), mentre la cifra della riga si
 * confronta con il listino per il verso giusto: puo' stare sotto — e' cio' che
 * fa uno sconto — ma non sopra. Confrontare direttamente la riga con Shopify
 * farebbe suonare l'allarme a ogni negozio con un prezzo concordato.
 *
 * Cio' che Shopify non dichiara (valuta, importo o cadenza assenti dal blocco
 * del prezzo) non e' una discordanza: e' un silenzio, e non blocca. Si blocca
 * su cio' che due fonti dicono in modo diverso, non su cio' che una non dice.
 */
function attemptMismatches(args: {
  stateRaw: string | null;
  state: BillingAttemptState | null;
  attempt: BillingCharge | null;
  subscription: AppSubscriptionSummary;
  planName: string;
  shopDomain: string;
}): string[] {
  const { stateRaw, state, attempt, subscription, planName, shopDomain } = args;
  const out: string[] = [];

  // Lo state manca del tutto sugli addebiti aperti prima che esistesse, e su
  // quelli approvati da un link vecchio rimasto in giro. Non e' una colpa del
  // merchant, ma non e' nemmeno un'attivazione: da qui si puo' solo confermare
  // un piano gia' applicato.
  if (!stateRaw) out.push('nessuno state firmato nella URL di ritorno');
  else if (!state) out.push('state presente ma non verificabile (firma non nostra o scaduta)');

  if (!state) return out;

  if (state.shopDomain !== shopDomain) {
    out.push(`lo state e' di ${state.shopDomain}, la callback di ${shopDomain}`);
  }
  if (!samePlanName(state.planName, planName)) {
    out.push(`piano richiesto "${state.planName}", piano confermato "${planName}"`);
  }
  if (subscription.currency && !sameCurrency(state.currency, subscription.currency)) {
    out.push(`valuta richiesta ${state.currency}, valuta confermata ${subscription.currency}`);
  }
  if (subscription.interval && state.interval !== subscription.interval) {
    out.push(`cadenza richiesta ${state.interval}, cadenza confermata ${subscription.interval}`);
  }
  if (subscription.priceAmount != null && !sameAmount(state.listPrice, subscription.priceAmount)) {
    out.push(
      `importo di listino richiesto ${state.listPrice}, importo confermato ${subscription.priceAmount}`,
    );
  }

  if (!attempt) {
    out.push('nessuna riga di tentativo per questo addebito');
    return out;
  }
  if (attempt.callbackNonce !== state.nonce) {
    out.push("il nonce dello state non e' quello del tentativo");
  }
  if (!samePlanName(attempt.planType, planName)) {
    out.push(`il tentativo era per "${attempt.planType}", confermato "${planName}"`);
  }
  if (attempt.currency && !sameCurrency(attempt.currency, subscription.currency)) {
    out.push(`il tentativo era in ${attempt.currency}, confermato in ${subscription.currency}`);
  }
  if (
    attempt.billingCycle &&
    subscription.interval &&
    attempt.billingCycle !== subscription.interval
  ) {
    out.push(`il tentativo era ${attempt.billingCycle}, confermato ${subscription.interval}`);
  }
  if (attempt.price != null && !notAbove(attempt.price, state.listPrice)) {
    out.push(`il tentativo costava ${attempt.price}, oltre il listino ${state.listPrice}`);
  }

  return out;
}

/**
 * Questa callback sta ripetendo un'attivazione gia' avvenuta.
 *
 * E' l'unica risposta ammessa quando il tentativo non si e' potuto spendere: il
 * negozio dev'essere gia' esattamente dove questa callback lo porterebbe —
 * quell'addebito, quel piano, quella cadenza — e la riga dell'addebito dev'essere
 * gia' attiva. Se anche una sola di queste cose non torna, non e' una ripetizione
 * di qualcosa di riuscito: e' una callback che non sappiamo spiegare, e si
 * risponde che non e' andata invece di rassicurare a vuoto.
 */
function alreadyApplied(args: {
  shop: Pick<Shop, 'activeChargeId' | 'currentPlan' | 'billingCycle'>;
  attempt: BillingCharge | null;
  chargeId: string;
  planName: string;
  interval: Interval;
}): boolean {
  const { shop, attempt, chargeId, planName, interval } = args;
  return (
    shop.activeChargeId === chargeId &&
    samePlanName(shop.currentPlan, planName) &&
    // La colonna e' nata dopo i primi abbonamenti: vuota vale "mensile", che e'
    // quello che allora si scriveva sempre. Serve a non rispondere "non e'
    // andata" a un merchant il cui piano e' invece perfettamente attivo.
    (shop.billingCycle ?? 'monthly') === interval &&
    attempt?.status === 'active'
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  const requestUrl = new URL(request.url);

  // Lo state si verifica PRIMA di qualunque altra cosa: prima di aprire una
  // sessione, prima di leggere il negozio, prima di toccare una riga. Non e'
  // eleganza — e' che tutto quello che viene dopo si comporta in modo diverso a
  // seconda che questa callback stia chiudendo un tentativo nostro o no, e la
  // risposta non deve dipendere da quanto siamo arrivati lontano.
  const stateRaw = requestUrl.searchParams.get('state');
  const state = verifyBillingState(stateRaw);

  // Qui NON si chiede una sessione embedded, e non e' una dimenticanza.
  //
  // Shopify riporta il browser su questo indirizzo al PRIMO LIVELLO, fuori
  // dall'iframe e senza alcun token di sessione addosso. Chiedendone uno, la
  // libreria non trova niente e fa il suo rimbalzo: manda dentro l'admin su
  // /auth/session-token con questo indirizzo in coda, aspettandosi che una
  // pagina intermedia recuperi il token e ricarichi. Quel giro si inceppa e
  // lascia il riquadro vuoto — senza contenuto e senza menu — dopo che il
  // merchant ha appena pagato.
  //
  // Al posto suo si usa la sessione offline gia' salvata per quel negozio: e'
  // la stessa che usano i webhook, e non ha bisogno di nessuno davanti allo
  // schermo. Il negozio arriva dalla querystring, ma non e' una parola sulla
  // fiducia: se non ha una sessione salvata non c'e' nessun client da
  // costruire, e il solo effetto possibile e' rileggere da Shopify un
  // abbonamento che deve risultare ATTIVO e portare il nome di un piano del
  // listino. Un charge_id indovinato non attiva niente.
  const shopDomain = (requestUrl.searchParams.get('shop') ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopDomain)) {
    return backToPlan(requestUrl, shopDomain, 'ko');
  }

  let admin: BillingAdmin;
  try {
    ({ admin } = await unauthenticated.admin(shopDomain));
  } catch (error) {
    console.error(
      `[billing.callback] nessuna sessione per ${shopDomain}:`,
      error instanceof Error ? error.message : 'errore sconosciuto',
    );
    return backToPlan(requestUrl, shopDomain, 'ko');
  }

  const chargeIdRaw = (requestUrl.searchParams.get('charge_id') ?? '').trim();
  if (!/^\d+$/.test(chargeIdRaw)) {
    return backToPlan(requestUrl, shopDomain, 'ko');
  }

  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) {
    return backToPlan(requestUrl, shopDomain, 'ko');
  }

  const chargeId = BigInt(chargeIdRaw);
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
        // Non e' un'attivazione ma una riconciliazione: si prende atto di uno
        // stato che Shopify dichiara per conto suo, e nessun piano si muove.
        // updateMany filtrato sullo shop: un charge_id indovinato non puo'
        // toccare le righe di un altro negozio.
        await prisma.billingCharge.updateMany({
          where: { shopId: shop.id, shopifyChargeId: chargeId },
          data: { status, cancelledAt: new Date() },
        });
      }
      return backToPlan(requestUrl, shopDomain, 'ko');
    }

    // La riga ESATTA di questo tentativo: shop piu' addebito, non "quella che
    // sembra giusta". Serve anche quando i conti non tornano, per poter dire
    // nei log e nel replay di che tentativo si sta parlando.
    const attempt = await prisma.billingCharge.findFirst({
      where: { shopId: shop.id, shopifyChargeId: chargeId },
    });

    // La cadenza effettiva: quella che Shopify dichiara, e in mancanza quella
    // che il tentativo aveva chiesto. Non piu' 'monthly' scritto a mano: un
    // abbonamento annuale finiva registrato come mensile sul negozio.
    const interval: Interval =
      subscription.interval ?? state?.interval ?? intervalOf(attempt) ?? 'monthly';

    const problemi = attemptMismatches({
      stateRaw,
      state,
      attempt,
      subscription,
      planName: plan.planName,
      shopDomain,
    });

    if (problemi.length > 0 || !state) {
      console.warn(
        `[billing.callback] tentativo non riconosciuto per ${shopDomain} (addebito ${chargeIdRaw}): ${problemi.join('; ')}`,
      );
      return replyToReplay({
        requestUrl,
        shopDomain,
        shop,
        attempt,
        chargeId: chargeIdRaw,
        planName: plan.planName,
        interval,
      });
    }

    const now = new Date();
    // I giorni di prova buoni sono quelli che Shopify ha davvero concesso: il
    // listino puo' essere cambiato fra la richiesta e la conferma.
    const trialDays = subscription.trialDays ?? 0;

    // Le scritture insieme, o nessuna.
    //
    // Sono un gesto solo — il tentativo si spende, l'addebito diventa attivo, il
    // negozio passa al piano nuovo, il quarto passo della configurazione risulta
    // fatto e i vecchi abbonamenti risultano da chiudere — e una meta' che
    // riuscisse da sola lascerebbe il merchant in uno stato che non corrisponde
    // a niente: pagato ma sul piano vecchio, oppure sul piano nuovo con
    // l'addebito ancora segnato in attesa. Da fuori sarebbe indistinguibile da
    // un pagamento non andato a buon fine, e nessuno saprebbe da che parte
    // rimetterlo a posto.
    //
    // Le chiamate a Shopify restano fuori, piu' sotto: cio' che si e' gia'
    // fatto sui loro server una transazione nostra non lo disfa.
    const esito = await prisma.$transaction(async (tx) => {
      // Il tentativo si verifica e si spende nello stesso gesto.
      //
      // Non "leggo, controllo, poi scrivo": fra la lettura e la scrittura ci
      // stanno comodamente due callback ravvicinate — il merchant che ricarica,
      // la scheda rimasta aperta — e passerebbero tutte e due il controllo. Le
      // condizioni stanno nella WHERE, quindi a decidere chi passa e' il
      // database, una volta sola. Se la riga era gia' stata spesa, o non e' piu'
      // in attesa, o porta un nonce diverso, il conteggio e' zero e qui non si
      // scrive piu' niente.
      const preso = await tx.billingCharge.updateMany({
        where: {
          shopId: shop.id,
          shopifyChargeId: chargeId,
          status: 'pending',
          callbackNonce: state.nonce,
          callbackNonceUsedAt: null,
        },
        data: {
          status: 'active',
          activatedAt: now,
          billingCycle: interval,
          trialDays,
          trialEndsAt: trialDays > 0 ? new Date(now.getTime() + trialDays * DAY_MS) : null,
          callbackNonceUsedAt: now,
        },
      });

      // Uscita anticipata e non eccezione: prima di questa riga la transazione
      // non ha scritto niente, quindi non c'e' niente da annullare — e chi
      // chiama ha bisogno di distinguere "gia' fatto" da "guasto", che
      // un'eccezione confonderebbe.
      if (preso.count !== 1) return 'gia_speso' as const;

      await applyPlanToShop({
        shopId: shop.id,
        planName: plan.planName,
        chargeId: chargeIdRaw,
        trialDays,
        billingCycle: interval,
        now,
        // Approvare un piano a pagamento E' confermare il piano: e' il quarto
        // passo della configurazione, fatto nel modo piu' esplicito che esista
        // — pagando. Va nella stessa scrittura del piano e non in una update a
        // parte, perche' due update separate possono riuscire a meta' e
        // lascerebbero il negozio sul piano nuovo con la configurazione ancora
        // aperta.
        planConfirmedAt: now,
        tx,
      });

      // L'intenzione di chiudere i vecchi abbonamenti si scrive QUI, protetta
      // dalla transazione. Chiuderli davvero e' una chiamata a Shopify, e le
      // chiamate a Shopify falliscono: se il lavoro vivesse solo nel tentativo
      // che facciamo fra un istante, un errore di rete lo farebbe sparire e il
      // merchant continuerebbe a pagare due abbonamenti senza che da nessuna
      // parte risultasse qualcosa da fare.
      await markSupersededCharges(tx, shop.id, chargeIdRaw);

      return 'attivato' as const;
    });

    if (esito !== 'attivato') {
      return replyToReplay({
        requestUrl,
        shopDomain,
        shop,
        attempt,
        chargeId: chargeIdRaw,
        planName: plan.planName,
        interval,
      });
    }

    // Da qui in giu' il piano e' gia' applicato: quel che segue e' pulizia, e
    // non puo' piu' cambiare l'esito che il merchant vede.
    await enqueueUnknownActiveSubscriptions(admin, shop.id, gid);
    await drainSupersededCharges(admin, shop.id);

    // Se la configurazione non era ancora conclusa, questo e' il primo piano che
    // il merchant sceglie, non un passaggio da un piano a un altro. Se lo sa
    // solo qui — un istante dopo, la configurazione risultera' chiusa e quel
    // "prima" non sara' piu' ricostruibile — quindi glielo si dice adesso, e la
    // dashboard evita di annunciare un aggiornamento che non e' avvenuto.
    return backToPlan(requestUrl, shopDomain, 'ok', shop.setupCompletedAt == null);
  } catch (e) {
    console.error(
      '[billing.callback]',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return backToPlan(requestUrl, shopDomain, 'ko');
  }
}

/** La cadenza scritta sulla riga del tentativo, se e' una delle due che usiamo. */
function intervalOf(attempt: BillingCharge | null): Interval | null {
  if (attempt?.billingCycle === 'monthly' || attempt?.billingCycle === 'yearly') {
    return attempt.billingCycle;
  }
  return null;
}

/**
 * La risposta quando non si e' attivato niente.
 *
 * Un solo posto per i due casi che ci arrivano — il tentativo non riconosciuto e
 * quello gia' speso — perche' la regola e' la stessa e deve restare una: si
 * risponde "e' andata" solo se il negozio E' gia' dove questa callback lo
 * porterebbe, e in quel caso non si scrive niente. Nessun timestamp riscritto
 * (era cosi' che una ricarica allungava la prova), nessun abbonamento
 * ri-cancellato.
 */
function replyToReplay(args: {
  requestUrl: URL;
  shopDomain: string;
  shop: Shop;
  attempt: BillingCharge | null;
  chargeId: string;
  planName: string;
  interval: Interval;
}): Response {
  const { requestUrl, shopDomain, shop, attempt, chargeId, planName, interval } = args;

  if (alreadyApplied({ shop, attempt, chargeId, planName, interval })) {
    return backToPlan(requestUrl, shopDomain, 'ok', shop.setupCompletedAt == null);
  }

  console.warn(
    `[billing.callback] nessuna attivazione per ${shopDomain}: l'addebito ${chargeId} non e' quello attivo del negozio`,
  );
  return backToPlan(requestUrl, shopDomain, 'ko');
}
