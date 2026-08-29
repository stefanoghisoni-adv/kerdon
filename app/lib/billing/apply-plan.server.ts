import type { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';

// Il passaggio "abbonamento confermato -> piano scritto sullo shop" ha due
// chiamanti diversi: la callback di ritorno da Shopify e il webhook
// app_subscriptions/update, che arriva anche quando il merchant approva su un
// altro dispositivo o quando Shopify cambia stato per conto suo. Tenerlo in un
// posto solo evita che le due strade scrivano campi diversi e lascino lo shop
// in stati che nessuno ha previsto.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ricompone il gid di un abbonamento dal solo id numerico.
 *
 * Serve perche' in giro conserviamo l'id nudo (`Shop.activeChargeId`,
 * `BillingCharge.shopifyChargeId`, il `charge_id` che Shopify mette in
 * querystring) mentre le GraphQL vogliono il gid completo.
 */
export function appSubscriptionGid(chargeId: string | bigint | number): string {
  return `gid://shopify/AppSubscription/${chargeId}`;
}

/**
 * Il client su cui scrivere: `prisma`, oppure il client di una transazione in
 * corso.
 *
 * Serve perche' l'attivazione di un piano non e' una scrittura sola — la riga
 * dell'addebito e il negozio cambiano insieme, o non deve cambiare niente — e
 * chi orchestra la transazione sta fuori di qui.
 */
export type PlanWriter = Prisma.TransactionClient | typeof prisma;

export interface ApplyPlanOptions {
  /** `Shop.id`, non il dominio. */
  shopId: string;
  /** Nome esatto dalla colonna `plan_name`: e' quello che i limiti leggono. */
  planName: string;
  /**
   * Id numerico dell'abbonamento che sostiene il piano, come stringa.
   * Null sui piani gratuiti, che non hanno nessun addebito dietro.
   */
  chargeId: string | null;
  /** Giorni di prova effettivi dell'abbonamento. Null o 0 = nessuna prova. */
  trialDays?: number | null;
  /** Istante di riferimento: iniettabile dai test. */
  now?: Date;
  /**
   * Quando il merchant ha confermato il piano, se questa attivazione vale anche
   * come conferma.
   *
   * Approvare un addebito E' confermare il piano — e' il quarto passo della
   * configurazione, fatto nel modo piu' esplicito che esista. Sta qui dentro e
   * non in una `shop.update` a parte perche' e' lo stesso negozio, nello stesso
   * istante: due update separate possono riuscire a meta', e il negozio
   * resterebbe sul piano nuovo con la configurazione ancora aperta. Omesso (o
   * null) dagli altri chiamanti, che attivano un piano senza che nessuno abbia
   * confermato niente.
   */
  planConfirmedAt?: Date | null;
  /**
   * Dove scrivere. Assente = direttamente su `prisma`, che e' il caso del
   * webhook: la sua e' una scrittura sola e non ha niente da tenere insieme.
   */
  tx?: PlanWriter;
}

/**
 * Porta lo shop sul piano indicato.
 *
 * Non tocca `lastSyncedPlan`: e' la differenza fra quello e `currentPlan` a
 * dire alla dashboard che c'e' un allineamento da fare e quale banner mostrare.
 * Azzerarlo qui spegnerebbe entrambe le cose.
 */
export async function applyPlanToShop(opts: ApplyPlanOptions): Promise<void> {
  const db = opts.tx ?? prisma;
  const now = opts.now ?? new Date();
  const trialDays = opts.trialDays ?? 0;
  const inTrial = trialDays > 0;

  const data: Prisma.ShopUpdateInput = {
    currentPlan: opts.planName,
    activeChargeId: opts.chargeId,
    planStartedAt: now,
    billingCycle: 'monthly',
    isInTrial: inTrial,
    trialEndsAt: inTrial ? new Date(now.getTime() + trialDays * DAY_MS) : null,
  };

  if (opts.planConfirmedAt) {
    data.planConfirmedAt = opts.planConfirmedAt;
  }

  // Un piano a pagamento appena attivato riapre l'app a chi era finito in
  // PENDING alla fine della prova: e' quello che gli promettiamo a schermo
  // ("Aggiorna il piano per riattivarle"), e senza questa riga il merchant
  // pagherebbe restando sospeso. DISABLED invece non si sblocca mai da solo:
  // e' una decisione dell'owner, non la scadenza di un periodo.
  if (opts.chargeId) {
    const current = await db.shop.findUnique({
      where: { id: opts.shopId },
      select: { authorization: true, trackingAuthorization: true },
    });
    if (current?.authorization === 'PENDING') data.authorization = 'ENABLED';
    if (current?.trackingAuthorization === 'PENDING') data.trackingAuthorization = 'ENABLED';
  }

  await db.shop.update({ where: { id: opts.shopId }, data });
}
