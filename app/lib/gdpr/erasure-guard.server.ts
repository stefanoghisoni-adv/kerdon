// app/lib/gdpr/erasure-guard.server.ts
//
// Il gesto che chiude un negozio alle scritture, e il gettone con cui chi era
// gia' partito se ne accorge.
//
// IL GUASTO CHE QUESTO FILE ESISTE PER ESCLUDERE. `shop/redact` cominciava a
// cancellare mentre il resto dell'app continuava a lavorare come se niente
// fosse: una sincronizzazione avviata un minuto prima proseguiva, il proxy di
// lettura rispondeva ancora — con la chiave di servizio tenuta in una cache da
// trenta secondi — e le notifiche di Shopify arrivate nel frattempo scrivevano
// clienti e ordini nel database di un merchant che aveva appena chiesto di
// essere dimenticato. Ognuna di quelle scritture, presa da sola, era corretta.
// Insieme facevano una cancellazione che non cancellava.
//
// DUE PEZZI, E SERVONO TUTTI E DUE.
//
//  - `lifecycle_status = 'erasing'` ferma chi deve ancora cominciare. Lo legge
//    la policy delle capacita' (`authz/capabilities`), che e' il posto da cui
//    passano gia' processori, proxy e notifiche in ingresso: un motivo di
//    rifiuto in piu' li nega tutti nello stesso istante, senza aggiungere un
//    controllo in venti file — che e' il modo in cui venti file finiscono per
//    dire cose diverse.
//  - `erasure_generation` ferma chi era gia' partito. Chi tiene il lucchetto
//    del negozio se la porta dietro e la riverifica un istante prima di ogni
//    scrittura distruttiva: se e' cambiata, la cancellazione e' cominciata dopo
//    di lui e la sua scrittura arriverebbe fuori tempo.
//
// PERCHE' LA MARCATURA HA UNA TRANSAZIONE SUA, e non sta in quella che
// cancella. Perche' fino al commit nessun altro la vede: tenerla dentro
// vorrebbe dire che per tutta la durata della cancellazione — la parte lunga —
// il negozio risulta ancora aperto a chiunque legga. E perche' se la
// transazione fallisce la marcatura deve RESTARE: il negozio e' in attesa di
// cancellazione, e riaprirlo al lavoro nel frattempo vorrebbe dire riscrivere
// esattamente quello che il ritentativo dovra' togliere.

import { prisma } from '~/db.server';
import { invalidateReadContextForDomain, invalidateReadContextForShop } from '~/lib/read-proxy/context.server';

/** I due stati del ciclo di vita. Elenco chiuso: non e' testo libero. */
export const SHOP_LIFECYCLE = {
  attivo: 'active',
  inCancellazione: 'erasing',
} as const;

export type ShopLifecycleStatus = (typeof SHOP_LIFECYCLE)[keyof typeof SHOP_LIFECYCLE];

/** Vero quando la cancellazione del negozio e' gia' cominciata. */
export function isErasing(status: string | null | undefined): boolean {
  return (status ?? '').trim() === SHOP_LIFECYCLE.inCancellazione;
}

/** Lo stato del ciclo di vita di un negozio, come lo leggono i controlli. */
export interface ErasureState {
  lifecycleStatus: string;
  erasureGeneration: number;
}

/**
 * L'errore che ferma una scrittura arrivata fuori tempo.
 *
 * Una classe sua e non un `Error` qualunque: chi la riceve deve poter
 * distinguere "il negozio sta sparendo, smetti e non ritentare all'infinito" da
 * un guasto di rete, e distinguerlo senza leggere il testo di un messaggio.
 */
export class ShopErasureInProgressError extends Error {
  readonly shopId: string;

  constructor(shopId: string, motivo: string) {
    super(`Negozio ${shopId} in cancellazione: ${motivo}`);
    this.name = 'ShopErasureInProgressError';
    this.shopId = shopId;
  }
}

/**
 * Lo stato di adesso, o null se il negozio non c'e' piu'.
 *
 * Null e' un'informazione, non un'assenza: vuol dire che la cancellazione e'
 * gia' arrivata in fondo.
 */
export async function readErasureState(shopId: string): Promise<ErasureState | null> {
  return prisma.shop.findUnique({
    where: { id: shopId },
    select: { lifecycleStatus: true, erasureGeneration: true },
  });
}

/**
 * Chiude il negozio alle scritture e alza il gettone.
 *
 * Si chiama UNA VOLTA, prima della transazione che cancella, e in una scrittura
 * sua che va a buon fine per conto proprio. Restituisce la generazione nuova,
 * che finisce nella prova: chi rilegge la prova sa cosi' quale gettone le corse
 * in volo avrebbero dovuto verificare.
 *
 * Su un ritentativo il negozio e' gia' 'erasing': la generazione sale lo
 * stesso, e va bene — ogni tentativo e' un momento diverso da cui una corsa
 * potrebbe essere partita, e un gettone che non si muove non fermerebbe quella
 * partita fra il tentativo di prima e questo.
 *
 * Subito dopo si butta via quel che il proxy di lettura si ricordava di questo
 * negozio. La cache tiene una DECISIONE gia' presa — "puo' leggere" — e la
 * chiave di servizio in chiaro accanto: senza questa riga, per una finestra di
 * trenta secondi il proxy continuerebbe a servire i clienti di un negozio la
 * cui cancellazione e' gia' cominciata, con una chiave che stiamo per revocare.
 */
export async function beginShopErasure(
  shopId: string,
  shopDomain: string,
): Promise<number> {
  const aggiornato = await prisma.shop.update({
    where: { id: shopId },
    data: {
      lifecycleStatus: SHOP_LIFECYCLE.inCancellazione,
      erasureGeneration: { increment: 1 },
    },
    select: { erasureGeneration: true },
  });

  forgetShopEverywhere(shopId, shopDomain);

  return aggiornato.erasureGeneration;
}

/**
 * Toglie dalle cache di processo tutto quel che riguarda questo negozio.
 *
 * Esportata perche' si chiama due volte: quando la cancellazione comincia e
 * quando e' finita. La prima e' quella che conta per la sicurezza — da li' in
 * poi nessuno deve piu' poter usare la chiave di servizio — la seconda e' per
 * chi fosse entrato in cache nel frattempo.
 *
 * Non solleva mai: e' una pulizia in memoria, e un suo inciampo non deve poter
 * annullare una cancellazione riuscita.
 */
export function forgetShopEverywhere(shopId: string, shopDomain: string): void {
  try {
    invalidateReadContextForShop(shopId);
    invalidateReadContextForDomain(shopDomain);
  } catch {
    // Una cache che non si e' potuta svuotare scade comunque da sola entro
    // trenta secondi, e a quel punto il negozio non c'e' piu': la lettura
    // successiva non trova nessuno e nega. Sollevare qui coprirebbe l'esito
    // vero della cancellazione con un guasto che non lo riguarda.
  }
}

/**
 * Lancia se il negozio non e' piu' scrivibile.
 *
 * Da chiamare un istante prima di ogni scrittura sul database del merchant, con
 * la generazione letta quando il lavoro e' cominciato. I tre modi in cui la
 * risposta e' no, e sono tutti e tre lo stesso fatto visto in momenti diversi:
 * il negozio non c'e' piu', la sua cancellazione e' cominciata, oppure il
 * gettone e' cambiato — cioe' e' cominciata e finita mentre leggevamo.
 */
export async function assertShopWritable(
  shopId: string,
  generazioneAttesa: number | null | undefined,
): Promise<void> {
  const stato = await readErasureState(shopId);

  if (!stato) {
    throw new ShopErasureInProgressError(shopId, 'la riga del negozio non esiste piu');
  }
  if (isErasing(stato.lifecycleStatus)) {
    throw new ShopErasureInProgressError(shopId, 'cancellazione gia cominciata');
  }
  if (generazioneAttesa != null && stato.erasureGeneration !== generazioneAttesa) {
    throw new ShopErasureInProgressError(
      shopId,
      `gettone cambiato (atteso ${generazioneAttesa}, trovato ${stato.erasureGeneration})`,
    );
  }
}
