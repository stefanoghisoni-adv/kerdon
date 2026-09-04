import { prisma } from '~/db.server';
import { appSubscriptionGid, type PlanWriter } from './apply-plan.server';
import {
  cancelAppSubscription,
  getActiveSubscriptions,
  parseGidId,
  type BillingAdmin,
} from './subscription.server';

/**
 * Gli abbonamenti da chiudere, segnati prima di provare a chiuderli.
 *
 * Quando un merchant passa a un piano nuovo, quello vecchio va cancellato su
 * Shopify: Shopify li lascia convivere, e due abbonamenti attivi sono due
 * addebiti in fattura. Il guaio e' che quella cancellazione e' una chiamata di
 * rete in coda a una transazione gia' chiusa, e finora viveva in un try/catch
 * che scriveva una riga di log e andava avanti. Se la chiamata falliva — rete,
 * un 5xx, la funzione che finisce il tempo a disposizione — il lavoro spariva
 * li': nessuno ci tornava sopra, e il merchant continuava a pagare due volte
 * senza che da nessuna parte risultasse qualcosa da fare.
 *
 * L'intenzione ora si scrive PRIMA, e si scrive dove la transazione la
 * protegge: lo stato `superseded` sulla riga dell'addebito vuol dire "questo
 * abbonamento e' stato sostituito e va chiuso su Shopify". Da li' in poi
 * chiuderlo e' un lavoro che si puo' riprovare quante volte serve — cancellare
 * un abbonamento gia' cancellato non e' un errore — e che nessun guasto puo'
 * far dimenticare, perche' la riga resta com'e' finche' non riesce.
 *
 * Non e' una coda con un suo motore: e' una colonna di stato letta da chi
 * passa. La svuotano la callback (subito dopo aver attivato il piano nuovo) e
 * il giro del cron, che raccoglie quel che alla callback non era riuscito.
 */

/** Lo stato che vuol dire "sostituito, da chiudere su Shopify". */
export const SUPERSEDED = 'superseded';

/**
 * Segna come sostituiti gli addebiti di questo negozio diversi da quello
 * appena confermato.
 *
 * Va chiamata DENTRO la transazione che attiva il piano nuovo: o si attiva il
 * piano e resta scritto che i precedenti vanno chiusi, o non succede niente.
 * Un addebito ancora `pending` entra nel conto come uno attivo — e' un
 * tentativo che il merchant potrebbe ancora approvare da una scheda rimasta
 * aperta, e non deve poter diventare un secondo abbonamento vivo.
 */
export async function markSupersededCharges(
  tx: PlanWriter,
  shopId: string,
  keepChargeId: string,
): Promise<number> {
  const { count } = await tx.billingCharge.updateMany({
    where: {
      shopId,
      status: { in: ['active', 'pending'] },
      // Un addebito senza id su Shopify non e' chiudibile: metterlo in coda
      // vorrebbe dire lasciarcelo per sempre.
      shopifyChargeId: { not: null },
      NOT: { shopifyChargeId: BigInt(keepChargeId) },
    },
    data: { status: SUPERSEDED },
  });
  return count;
}

/**
 * Chiude su Shopify tutto quello che per questo negozio risulta sostituito.
 *
 * Ogni riga per conto suo: un abbonamento che non si riesce a cancellare non
 * impedisce di cancellare gli altri, e resta segnato per il giro dopo. Non
 * lancia mai — chi la chiama ha appena incassato un pagamento, e il merchant
 * non deve vedere un errore per un lavoro che lo riguarda solo di riflesso.
 *
 * Restituisce quante ne ha chiuse davvero: serve al cron per dirlo nel suo
 * riepilogo, ed e' il numero da cui ci si accorge che qualcosa non passa mai.
 */
export async function drainSupersededCharges(
  admin: BillingAdmin,
  shopId: string,
): Promise<number> {
  let pendenti: Array<{ id: string; shopifyChargeId: bigint | null }>;
  try {
    pendenti = await prisma.billingCharge.findMany({
      where: { shopId, status: SUPERSEDED, shopifyChargeId: { not: null } },
      select: { id: true, shopifyChargeId: true },
      orderBy: { createdAt: 'asc' },
    });
  } catch (e) {
    // Nemmeno un guasto del database esce da qui: chi chiama viene dalla
    // callback, dove un'eccezione a questo punto direbbe "non e' andata" a un
    // merchant che ha appena pagato e il cui piano e' gia' attivo.
    console.warn(
      `[billing.outbox] coda non letta per ${shopId}:`,
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return 0;
  }

  let chiusi = 0;
  for (const riga of pendenti) {
    if (riga.shopifyChargeId == null) continue;
    try {
      await cancelAppSubscription(admin, appSubscriptionGid(riga.shopifyChargeId));
      // Lo stato passa a `cancelled` solo DOPO che Shopify ha confermato:
      // scriverlo prima vorrebbe dire perdere di nuovo il lavoro, che e'
      // esattamente cio' da cui si parte.
      await prisma.billingCharge.update({
        where: { id: riga.id },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
      chiusi++;
    } catch (e) {
      console.warn(
        `[billing.outbox] chiusura dell'abbonamento ${riga.shopifyChargeId} fallita per ${shopId}:`,
        e instanceof Error ? e.message : 'errore sconosciuto',
      );
    }
  }

  return chiusi;
}

/**
 * Il giro di recupero: tutti i negozi che hanno ancora qualcosa da chiudere.
 *
 * La callback drena la sua coda subito dopo aver attivato il piano, ma proprio
 * il caso che conta — la chiamata a Shopify che fallisce — e' quello in cui li'
 * non si conclude niente. Senza qualcuno che ci ritorni sopra, il merchant
 * continuerebbe a pagare due abbonamenti finche' non se ne accorge da solo
 * guardando la fattura.
 *
 * Il client di Shopify lo passa chi chiama: qui dentro non si sa (e non si deve
 * sapere) come si apre una sessione offline. Un negozio per cui non se ne
 * riesce ad aprire una non ferma gli altri: la sua coda resta dov'e'.
 *
 * Di norma non trova niente e costa una query.
 */
export async function drainPendingCancellations(
  adminFor: (shopDomain: string) => Promise<BillingAdmin>,
): Promise<number> {
  const daChiudere = await prisma.billingCharge.findMany({
    where: { status: SUPERSEDED, shopifyChargeId: { not: null } },
    select: { shopId: true, shop: { select: { shopDomain: true } } },
    distinct: ['shopId'],
  });

  let chiusi = 0;
  for (const riga of daChiudere) {
    try {
      chiusi += await drainSupersededCharges(await adminFor(riga.shop.shopDomain), riga.shopId);
    } catch (e) {
      console.warn(
        `[billing.outbox] nessuna sessione per ${riga.shop.shopDomain}:`,
        e instanceof Error ? e.message : 'errore sconosciuto',
      );
    }
  }

  return chiusi;
}

/**
 * Gli abbonamenti che Shopify dice ancora attivi e che noi non aspettavamo,
 * messi in coda insieme agli altri.
 *
 * Copre il caso in cui l'addebito precedente non abbia una riga da queste
 * parti: un tentativo di cui si e' persa traccia, o un abbonamento creato
 * quando l'app era un'altra versione. Best effort per forza — dipende da una
 * lettura verso Shopify — ma non e' l'unica difesa: quel che si sa da qui sta
 * gia' scritto nelle righe locali, ed e' quello a non potersi perdere.
 */
export async function enqueueUnknownActiveSubscriptions(
  admin: BillingAdmin,
  shopId: string,
  keepGid: string,
): Promise<void> {
  try {
    const attivi = await getActiveSubscriptions(admin);
    for (const sub of attivi) {
      if (sub.gid === keepGid) continue;
      const chargeId = parseGidId(sub.gid);
      // upsert e non update: se la riga non c'e' la si crea gia' nello stato in
      // cui serve, cosi' il drenaggio la trova come tutte le altre.
      await prisma.billingCharge.upsert({
        where: { shopifyChargeId: chargeId },
        create: {
          shopId,
          shopifyChargeId: chargeId,
          planType: sub.name || 'sconosciuto',
          status: SUPERSEDED,
        },
        update: {},
      });
      // L'upsert non tocca le righe che esistono gia' (potrebbero essere in
      // qualunque stato): il passaggio a `superseded` si fa a parte e solo se
      // la riga e' di questo negozio, cosi' un id che arriva da fuori non puo'
      // spostare le righe di un altro.
      await prisma.billingCharge.updateMany({
        where: { shopId, shopifyChargeId: chargeId, status: { in: ['active', 'pending'] } },
        data: { status: SUPERSEDED },
      });
    }
  } catch (e) {
    console.warn(
      `[billing.outbox] elenco degli abbonamenti attivi non letto per ${shopId}:`,
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
  }
}
