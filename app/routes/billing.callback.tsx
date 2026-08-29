import type { LoaderFunctionArgs } from '@remix-run/node';
import { redirect } from '@remix-run/node';
import type { BillingCharge, Shop } from '@prisma/client';
import { unauthenticated } from '~/shopify.server';
import { prisma } from '~/db.server';
import {
  cancelAppSubscription,
  getActiveSubscriptions,
  getSubscription,
  parseGidId,
  type AppSubscriptionSummary,
  type BillingAdmin,
} from '~/lib/billing/subscription.server';
import { appSubscriptionGid, applyPlanToShop } from '~/lib/billing/apply-plan.server';
import { adminAppUrl, embeddedContextParams } from '~/lib/billing/embedded-return.server';
import { findPlanByName } from '~/lib/billing/find-plan.server';
import { samePlanName } from '~/lib/billing/plan-name';
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
// Accanto a quella verifica ce ne sono altre due, che rispondono a domande
// diverse.
//
// La prima e' "quale tentativo sta chiudendo questa callback". La risposta e' il
// nonce firmato che `billing/subscribe` ha messo nella URL di ritorno e
// riscritto sulla riga dell'addebito: la riga si ritrova per id, il nonce dice
// che i due capi sono lo stesso gesto, e piano, cifra, valuta e cadenza si
// confrontano fra quello che avevamo chiesto e quello che Shopify dichiara.
//
// La seconda e' "questa callback e' gia' passata di qui". Il merchant ricarica
// la pagina, Shopify rimanda, una scheda resta aperta: la stessa conferma puo'
// arrivare piu' volte, e non deve applicare due volte lo stesso piano ne'
// rifar partire da capo un periodo di prova. Il tentativo si spende una volta
// sola, dentro la transazione, e le callback successive trovano la riga gia'
// consumata e si limitano a rispondere "e' andata".
//
// Nessuna di queste due, pero', ha diritto di veto. Se i conti non tornano ma
// Shopify conferma l'abbonamento attivo, l'anomalia si registra e il piano si
// applica lo stesso: negare un piano pagato e' un danno certo, accettarne uno
// con un parametro strano che Shopify conferma non lo e'.

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

/** Due importi uguali a meno dei centesimi: sono Decimal da due lati diversi. */
function sameAmount(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 0.005;
}

/** Due valute uguali a meno di maiuscole e spazi. */
function sameCurrency(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? '').trim().toUpperCase();
  if (!left) return false;
  return left === (b ?? '').trim().toUpperCase();
}

/**
 * Tutto quello che, in questa callback, non torna con il tentativo che
 * dovrebbe averla aperta.
 *
 * Restituisce una lista di frasi, non un verdetto: chi chiama le scrive nei log
 * e prosegue. Sono i dati su cui si guarda quando un merchant chiede conto di
 * un addebito, e una riga di log che dice "il piano confermato non e' quello
 * richiesto" vale piu' di un rifiuto che non spiega niente a nessuno.
 */
function attemptMismatches(args: {
  stateRaw: string | null;
  state: BillingAttemptState | null;
  attempt: BillingCharge | null;
  subscription: AppSubscriptionSummary;
  planName: string;
  shopDomain: string;
  chargeId: string;
}): string[] {
  const { stateRaw, state, attempt, subscription, planName, shopDomain } = args;
  const out: string[] = [];

  // Lo state manca del tutto sugli addebiti aperti prima che esistesse, e su
  // quelli approvati da un link vecchio rimasto in giro. Va detto, non punito.
  if (!stateRaw) out.push('nessuno state firmato nella URL di ritorno');
  else if (!state) out.push('state presente ma non verificabile (firma non nostra o scaduta)');

  if (state && state.shopDomain !== shopDomain) {
    out.push(`lo state e' di ${state.shopDomain}, la callback di ${shopDomain}`);
  }
  if (state && !samePlanName(state.planName, planName)) {
    out.push(`piano richiesto "${state.planName}", piano confermato "${planName}"`);
  }
  if (state && !sameCurrency(state.currency, subscription.currency)) {
    out.push(`valuta richiesta ${state.currency}, valuta confermata ${subscription.currency}`);
  }
  if (state && subscription.interval && state.interval !== subscription.interval) {
    out.push(`cadenza richiesta ${state.interval}, cadenza confermata ${subscription.interval}`);
  }
  // Il confronto e' sul prezzo di LISTINO: lo sconto riservato viaggia a parte
  // e Shopify rilegge il listino, mentre sulla riga dell'addebito e' scritta la
  // cifra che il merchant paga davvero. Confrontare quelle due farebbe suonare
  // l'allarme a ogni negozio con un prezzo concordato.
  if (state && !sameAmount(state.listPrice, subscription.priceAmount)) {
    out.push(
      `importo di listino richiesto ${state.listPrice}, importo confermato ${subscription.priceAmount}`,
    );
  }

  if (!attempt) {
    out.push('nessuna riga di tentativo per questo addebito');
    return out;
  }
  if (state && attempt.callbackNonce !== state.nonce) {
    out.push('il nonce dello state non e\' quello del tentativo');
  }
  if (attempt.status !== 'pending') {
    out.push(`il tentativo non e' piu' in attesa (stato "${attempt.status}")`);
  }
  if (attempt.callbackNonceUsedAt) {
    out.push('il nonce del tentativo era gia\' stato speso');
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
    out.push(
      `il tentativo era ${attempt.billingCycle}, confermato ${subscription.interval}`,
    );
  }

  return out;
}

/**
 * Il negozio e' gia' su questo addebito e su questo piano.
 *
 * Serve per le callback che tornano quando non c'e' nessuna riga di tentativo
 * da spendere: senza un tentativo, l'unica traccia del fatto che il piano sia
 * gia' stato applicato e' il negozio stesso.
 */
function alreadyOnThisCharge(
  shop: Pick<Shop, 'activeChargeId' | 'currentPlan'>,
  chargeId: string,
  planName: string,
): boolean {
  return shop.activeChargeId === chargeId && samePlanName(shop.currentPlan, planName);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const requestUrl = new URL(request.url);

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

    // Le tre scritture insieme, o nessuna.
    //
    // Sono un gesto solo — l'addebito diventa attivo, il negozio passa al piano
    // nuovo, e il quarto passo della configurazione risulta fatto — e una meta'
    // che riuscisse da sola lascerebbe il merchant in uno stato che non
    // corrisponde a niente: pagato ma sul piano vecchio, oppure sul piano nuovo
    // con l'addebito ancora segnato in attesa. Da fuori sarebbe indistinguibile
    // da un pagamento non andato a buon fine, e nessuno saprebbe da che parte
    // rimetterlo a posto.
    //
    // La cancellazione dei vecchi abbonamenti resta fuori, piu' sotto: e' una
    // chiamata a Shopify, e cio' che si e' gia' fatto sui loro server una
    // transazione nostra non lo disfa.
    await prisma.$transaction(async (tx) => {
      await tx.billingCharge.updateMany({
        where: { shopId: shop.id, shopifyChargeId: BigInt(chargeIdRaw) },
        data: {
          status: 'active',
          activatedAt: now,
          trialDays,
          trialEndsAt: trialDays > 0 ? new Date(now.getTime() + trialDays * DAY_MS) : null,
          // Il nonce si spende QUI, dentro la transazione.
          //
          // Fuori non servirebbe: se le scritture fallissero dopo averlo
          // marcato speso, la stessa callback ripetuta — quella che Shopify
          // rimanda, o che il merchant provoca ricaricando — verrebbe rifiutata
          // proprio quando sarebbe l'occasione buona per rimediare. Segnandolo
          // insieme al resto, o e' andato tutto o non e' andato niente, e
          // riprovare resta possibile.
          callbackNonceUsedAt: now,
        },
      });

      await applyPlanToShop({
        shopId: shop.id,
        planName: plan.planName,
        chargeId: chargeIdRaw,
        trialDays,
        now,
        tx,
      });

    // Approvare un piano a pagamento E' confermare il piano: e' il quarto passo
    // della configurazione, fatto nel modo piu' esplicito che esista — pagando.
    //
    // Si segna qui e non al rientro nel browser perche' li' non e' garantito
    // che succeda: l'effetto che lo faceva partiva solo se non risultava gia'
    // una sincronizzazione completata, quindi chi cambiava piano avendone gia'
    // fatta una tornava su una configurazione che non si chiudeva piu'. E un
    // segno che dipende dal fatto che il browser resti aperto sul percorso
    // giusto non e' un segno, e' una speranza.
      await tx.shop.update({
        where: { id: shop.id },
        data: { planConfirmedAt: now },
      });
    });

    await cancelPreviousSubscriptions(admin, shop.id, gid);

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
