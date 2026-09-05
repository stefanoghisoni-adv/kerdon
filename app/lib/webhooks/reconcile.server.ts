// app/lib/webhooks/reconcile.server.ts
//
// La rete sotto la posta in arrivo: andare a chiedere a Shopify come stanno
// davvero le cose.
//
// PERCHE' SERVE ANCHE ADESSO CHE LA RICEVUTA E' DUREVOLE. La ricevuta copre gli
// eventi che ci arrivano. Non copre quelli che non ci arrivano affatto: Shopify
// ritenta una consegna per una finestra limitata, e un'app rimasta irraggiungibile
// piu' a lungo di quella finestra non li rivede mai. Da quel momento non esiste
// nessun evento da lavorare — esiste solo un negozio che da noi risulta
// installato e su Shopify non lo e' piu', o un piano a pagamento senza un
// abbonamento che lo sostenga. L'unico modo di accorgersene e' guardare.
//
// COSA SI RIPARA, E COSA NO. Due cose sole, quelle che i due webhook di questa
// posta in arrivo avrebbero dovuto dire:
//
//   - il token non e' piu' valido → l'app e' stata disinstallata, e si applica
//     la stessa disinstallazione del webhook
//   - Shopify non ha nessun abbonamento attivo, ma da noi ne risulta uno →
//     retrocessione al piano gratuito
//   - Shopify ha un abbonamento attivo che da noi non risulta → si applica
//
// Non si ripara nient'altro, e in particolare non si disinstalla mai un negozio
// per un errore che non sia quello: un guasto di rete, un 5xx, una chiave che
// manca sono ragioni per riprovare al giro dopo, non per spegnere un negozio
// che sta lavorando.
//
// LA ROTAZIONE. Ogni negozio costa una chiamata a Shopify, e il cron passa ogni
// mezz'ora: guardarli tutti a ogni giro sarebbe un carico che nessuno ha
// chiesto. Si prendono i piu' vecchi per `shopifyStateCheckedAt`, un pugno per
// volta, e la colonna li rimanda in fondo alla fila.

import { prisma } from '~/db.server';
import { redactError } from '~/lib/queue/queue-model';
import {
  getActiveSubscriptions,
  parseGidId,
  type BillingAdmin,
} from '~/lib/billing/subscription.server';
import { samePlanName } from '~/lib/billing/plan-name';
import { markShopUninstalled } from './handle-uninstall.server';
import {
  applyActiveSubscription,
  downgradeToFreePlan,
} from './handle-subscription-update.server';

/** Quanti negozi si guardano in un solo giro. */
export const RECONCILE_BATCH = 20;

/** Ogni quanto si torna a guardare lo stesso negozio. */
export const RECONCILE_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface ReconcileResult {
  /** Negozi effettivamente interrogati. */
  checked: number;
  /** Disinstallazioni scoperte qui e non da un webhook. */
  uninstalled: number;
  /** Piani retrocessi perche' su Shopify non c'era piu' niente di attivo. */
  downgraded: number;
  /** Abbonamenti attivi che da noi non risultavano. */
  aligned: number;
  errors: string[];
}

/**
 * Come si ottiene un client Admin per un negozio.
 *
 * Iniettato e non importato, come per il drenaggio degli abbonamenti sostituiti:
 * `unauthenticated.admin` tira dentro mezza libreria di Shopify, e questa
 * funzione dev'essere provabile senza. Puo' sollevare — un negozio senza
 * sessione non ne ha uno — e quel lancio e' trattato come un errore qualunque.
 */
export type AdminFor = (shopDomain: string) => Promise<BillingAdmin>;

export async function reconcileShopStates(
  adminFor: AdminFor,
  now: Date = new Date(),
  limit: number = RECONCILE_BATCH,
): Promise<ReconcileResult> {
  const esito: ReconcileResult = {
    checked: 0,
    uninstalled: 0,
    downgraded: 0,
    aligned: 0,
    errors: [],
  };

  const scaduti = new Date(now.getTime() - RECONCILE_INTERVAL_MS);

  const negozi = await prisma.shop.findMany({
    where: {
      uninstalledAt: null,
      OR: [{ shopifyStateCheckedAt: null }, { shopifyStateCheckedAt: { lt: scaduti } }],
    },
    // I mai controllati per primi, poi i piu' vecchi. `nulls: 'first'` e' quello
    // che fa entrare i negozi nuovi nella rotazione invece di lasciarli in fondo
    // per sempre.
    orderBy: { shopifyStateCheckedAt: { sort: 'asc', nulls: 'first' } },
    take: limit,
    select: { id: true, shopDomain: true, currentPlan: true, activeChargeId: true },
  });

  for (const shop of negozi) {
    try {
      await riconcilia(shop, adminFor, now, esito);
      esito.checked++;
      // Il timbro si scrive solo quando il giro e' andato a buon fine: un
      // negozio che non ha risposto non e' stato controllato, e rimandarlo in
      // fondo alla fila vorrebbe dire non guardarlo per altre dodici ore
      // proprio perche' qualcosa non andava.
      await prisma.shop.updateMany({
        where: { id: shop.id },
        data: { shopifyStateCheckedAt: now },
      });
    } catch (error) {
      const motivo = redactError(error);
      // Nessun dato personale: il dominio del negozio e il motivo, redatto.
      console.error(`[riconciliazione] ${shop.shopDomain}: ${motivo}`);
      esito.errors.push(`${shop.shopDomain}: ${motivo}`);
    }
  }

  return esito;
}

type ShopRow = {
  id: string;
  shopDomain: string;
  currentPlan: string;
  activeChargeId: string | null;
};

async function riconcilia(
  shop: ShopRow,
  adminFor: AdminFor,
  now: Date,
  esito: ReconcileResult,
): Promise<void> {
  let attivi;

  try {
    attivi = await getActiveSubscriptions(await adminFor(shop.shopDomain));
  } catch (error) {
    // Il solo errore che vuol dire "l'app non c'e' piu'". Tutti gli altri
    // risalgono a chi chiama e diventano un tentativo per il giro dopo: mai una
    // disinstallazione.
    if (!isRevokedToken(error)) throw error;

    await markShopUninstalled(shop.shopDomain, now);
    esito.uninstalled++;
    console.warn(
      `[riconciliazione] ${shop.shopDomain} risulta disinstallato su Shopify: ` +
        'evento perso, stato allineato adesso',
    );
    return;
  }

  const attivo = attivi.find((s) => s.status.toUpperCase().trim() === 'ACTIVE');

  if (!attivo) {
    // Niente di attivo su Shopify. Se da noi ne risulta uno, quello e' il
    // webhook di fine abbonamento che non e' mai arrivato.
    if (!shop.activeChargeId) return;

    const risultato = await downgradeToFreePlan(shop, BigInt(shop.activeChargeId), now);
    if (risultato === 'dead_letter') {
      throw new Error('nessun piano gratuito nel listino: retrocessione impossibile');
    }
    esito.downgraded++;
    console.warn(
      `[riconciliazione] ${shop.shopDomain}: nessun abbonamento attivo su Shopify, ` +
        'riportato al piano gratuito',
    );
    return;
  }

  const id = parseGidId(attivo.gid);

  // Gia' allineato: e' il caso normale, ed e' anche il motivo per cui questo
  // giro di norma non scrive niente.
  if (shop.activeChargeId === id.toString() && samePlanName(shop.currentPlan, attivo.name)) {
    return;
  }

  const risultato = await applyActiveSubscription(shop, attivo.name, id, now);
  // `done` copre anche "il nome non e' nel listino", che qui non e' un
  // allineamento: si conta solo quando il negozio e' davvero cambiato.
  if (risultato === 'done' && shop.activeChargeId !== id.toString()) {
    esito.aligned++;
    console.warn(
      `[riconciliazione] ${shop.shopDomain}: abbonamento attivo su Shopify di cui non ` +
        'risultava niente, allineato adesso',
    );
  }
}

/**
 * Se questo errore significa "il token non vale piu'", cioe' l'app disinstallata.
 *
 * Shopify lo dice in modo riconoscibile — un 401 con "Invalid API key or access
 * token" — e riconoscerlo dal messaggio e' fragile, ma l'alternativa e' peggio:
 * senza distinguere, o non si scopre mai una disinstallazione perduta, oppure un
 * guasto di rete spegne un negozio che sta lavorando. Nel dubbio si sbaglia
 * dalla parte del negozio che resta acceso — un negozio spento per errore non
 * sincronizza piu' niente e se ne accorge il merchant, non noi.
 */
export function isRevokedToken(error: unknown): boolean {
  const messaggio = error instanceof Error ? error.message : String(error ?? '');
  const testo = messaggio.toLowerCase();
  return (
    testo.includes('invalid api key or access token') ||
    testo.includes('unrecognized login') ||
    testo.includes('app is not installed')
  );
}
