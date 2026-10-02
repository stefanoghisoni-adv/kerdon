// app/lib/billing/cap-catch-up.server.ts
//
// Il recupero quando il tetto del piano sale.
//
// Le sync periodiche sono incrementali: dopo un upgrade, i prodotti e i clienti
// rimasti fuori dal tetto vecchio non cambiano su Shopify, quindi nessun delta
// li porta. Il recupero c'era gia' — il cron confronta `currentPlan` con
// `lastSyncedPlan` e accoda una corsa completa — ma solo al suo giro, fino a
// mezz'ora dopo, o quando il merchant riapre la dashboard. Qui lo si accoda nel
// momento in cui il piano cambia, e solo se un tetto e' davvero salito.
//
// Lo chiama `applyPlanToShop`, cioe' il punto unico da cui passa ogni cambio di
// piano: callback dell'addebito, webhook app_subscriptions/update,
// riconciliazione, scelta del piano gratuito. Chi aggiunge una strada nuova
// passa di li' e il recupero lo eredita.
//
// TUTTO CON IL CLIENT DEL CHIAMANTE. Listino, negozio e coda si leggono e si
// scrivono con `db`, che dentro la callback dell'addebito e' la transazione.
// Due ragioni. Con una connessione sola nel pool (il caso serverless) una query
// sul client principale aspetterebbe che la transazione liberi la connessione,
// cioe' il suo scadere: la callback fallirebbe a pagamento riuscito. E cosi' la
// riga in coda entra insieme al piano o non entra: niente recuperi accodati
// per un cambio di piano poi annullato.
//
// NON SOLLEVA. Far fallire il cambio di piano per un guasto della coda sarebbe
// molto peggio che aspettare il giro del cron, che il recupero lo accoda
// comunque. (Dentro una transazione un errore del database la invalida
// comunque — ma l'unico errore realistico qui e' la connessione persa, che
// farebbe fallire anche la scrittura del piano.)

import { findPlanByName } from '~/lib/billing/find-plan.server';
import { can } from '~/lib/authz/capabilities';
import {
  CAPABILITY_SHOP_SELECT,
  shopCapabilitiesWithPlan,
} from '~/lib/authz/shop-capabilities.server';
import { raisedCaps } from '~/lib/limits/cap-raise';
import { dedupKeyFor, redactError } from '~/lib/queue/queue-model';
import { enqueueSyncRequest } from '~/lib/queue/queue-store.server';
import { triggerSyncDrain } from '~/lib/queue/trigger.server';
import type { PlanWriter } from './apply-plan.server';

export type CapCatchUpStatus =
  /** Accodata una corsa completa. */
  | 'queued'
  /** C'era gia' la stessa corsa in coda: nessuna seconda riga. */
  | 'already_queued'
  /** Nessun tetto e' salito: discesa, stesso piano, notifica ripetuta. */
  | 'not_raised'
  /** Il negozio non ha mai completato una sync: la prima resta del merchant. */
  | 'never_synced'
  /** Database non collegato, negozio sospeso o disinstallato. */
  | 'not_ready'
  /** Qualcosa non ha risposto: ci pensera' il giro del cron. */
  | 'failed';

export interface CapCatchUpOutcome {
  status: CapCatchUpStatus;
  /** Il tetto prodotti e' salito. */
  products: boolean;
  /** Il tetto clienti e' salito (anche da "non inclusi" a "inclusi"). */
  customers: boolean;
}

export interface CapCatchUpOptions {
  shopId: string;
  /** `currentPlan` prima della scrittura. Null se il negozio non c'era. */
  previousPlanName: string | null;
  /** Il piano appena scritto. */
  nextPlanName: string;
  /** Lo stesso client della scrittura del piano: legge lo stato appena scritto. */
  db: PlanWriter;
  now: Date;
}

/**
 * Accoda una sync completa se il cambio di piano ha alzato il tetto prodotti
 * o clienti. Da chiamare DOPO aver scritto il piano nuovo.
 *
 * Una sola corsa anche quando salgono entrambi: la sincronizzazione completa
 * rilegge prodotti e clienti insieme, e i clienti per intero (senza confine di
 * data). Separarle chiederebbe una modalita' della corsa completa che oggi non
 * esiste, per risparmiare la parte che comunque si ferma al tetto.
 *
 * Idempotente in due modi. Una notifica ripetuta trova il piano gia' scritto,
 * quindi prima e dopo coincidono e nessun tetto sale. Due notifiche arrivate
 * insieme (webhook e callback che leggono entrambe il piano vecchio) producono
 * la stessa chiave di deduplica della coda, e sull'indice unico ne entra una.
 * La chiave e' quella del recupero del cron, cosi' anche lui, se passa nello
 * stesso minuto, si fonde in questa.
 */
export async function queueCapCatchUp(opts: CapCatchUpOptions): Promise<CapCatchUpOutcome> {
  let products = false;
  let customers = false;

  try {
    // Una dopo l'altra e non in parallelo: sul client di una transazione le
    // query passano comunque da una connessione sola.
    const previous = await findPlanByName(opts.previousPlanName, opts.db);
    const next = await findPlanByName(opts.nextPlanName, opts.db);

    ({ products, customers } = raisedCaps(previous, next));
    if (!products && !customers) return { status: 'not_raised', products, customers };

    // Riletto dopo la scrittura e con lo stesso client: le capacita' vanno
    // decise sul negozio come sara' adesso (un pagamento puo' aver appena
    // riattivato un negozio sospeso), non su com'era un istante fa.
    const shop = await opts.db.shop.findUnique({
      where: { id: opts.shopId },
      select: { ...CAPABILITY_SHOP_SELECT, lastSyncedPlan: true },
    });

    // Collegato, verificato, autorizzato, installato: le stesse condizioni con
    // cui il processor accetta di partire. Accodare un lavoro che rifiuterebbe
    // vorrebbe dire cinque tentativi e una lettera morta.
    const caps = shopCapabilitiesWithPlan(shop, next, opts.now);
    if (!shop || !can(caps, 'sync_products')) {
      return { status: 'not_ready', products, customers };
    }

    // Mai completata una sync: non c'e' niente rimasto fuori, e la prima
    // partenza e' un gesto del merchant (vedi syncCtaState). Quando la fara',
    // girera' gia' con il tetto nuovo.
    if (!shop.lastSyncedPlan) return { status: 'never_synced', products, customers };

    const esito = await enqueueSyncRequest({
      type: 'initial-bulk-sync',
      shopId: opts.shopId,
      dedupKey: dedupKeyFor('initial-bulk-sync', opts.shopId, opts.now),
      db: opts.db,
    });
    if (esito.duplicate) return { status: 'already_queued', products, customers };

    // Si accoda e basta: la corsa la fa un'invocazione sua, con il suo budget.
    // Dentro una transazione l'innesco puo' arrivare prima del commit e non
    // trovare la riga: resta in coda, e la prende il ritorno in dashboard o il
    // giro del cron.
    triggerSyncDrain(opts.shopId);
    console.log(
      `[piano] tetto salito per il negozio ${opts.shopId} ` +
        `(prodotti: ${products}, clienti: ${customers}): sync completa accodata`,
    );
    return { status: 'queued', products, customers };
  } catch (error) {
    console.error(
      `[piano] ALLARME recupero dopo l'aumento del tetto non accodato per il negozio ` +
        `${opts.shopId}: ${redactError(error)}`,
    );
    return { status: 'failed', products, customers };
  }
}
