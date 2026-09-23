// app/lib/shipping/weight-alert.server.ts
//
// Avviso "ordini senza peso" nella dashboard.
//
// Il costo di spedizione dipende dal peso dell'ordine. Se il peso manca e non
// c'e' un default configurato, il costo resta a zero — cioe' il profitto
// calcolato risulta piu' alto del vero. L'avviso dice quanti ordini sono in
// quella condizione e che basta indicare un peso medio per articolo.

import { Prisma } from '@prisma/client';
import { prisma } from '~/db.server';
import { runQueryRows } from '~/lib/supabase-management.server';
import { getValidAccessToken } from '~/lib/supabase-oauth.server';

/**
 * La tabella non c'e' ancora.
 *
 * Le migrazioni di questo progetto le lancia una persona, a mano, su Live e su
 * Test, e fra il rilascio del codice e quel momento la tabella non esiste. Non
 * e' un guasto: e' una finestra prevista, e si attraversa senza rumore.
 */
function tabellaAssente(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return e.code === 'P2021' || e.code === 'P2022';
  }
  return e instanceof Error && /does not exist|relation .* does not exist/i.test(e.message);
}

interface WeightAlertResult {
  show: boolean;
  count: number;
}

/**
 * Controlla se mostrare l'avviso degli ordini senza peso.
 *
 * L'avviso non compare quando:
 * - Il peso di default per articolo e' configurato (quei costi sono gia' coperti)
 * - E' stato chiuso dal merchant
 * - Non ci sono ordini senza peso
 * - La query fallisce (DB in pausa, colonne mancanti, ecc.)
 *
 * @returns {show: true, count: N} se l'avviso va mostrato, altrimenti {show: false, count: 0}
 */
export async function shouldShowWeightAlert(
  shopId: string,
  shopDomain: string,
): Promise<WeightAlertResult> {
  try {
    // Se c'e' un peso di default configurato, il costo di spedizione e' gia'
    // coperto: l'avviso non ha ragione di comparire.
    const packaging = await prisma.packagingConfig.findUnique({
      where: { shopId },
      select: { defaultWeightPerItem: true },
    });

    if (packaging?.defaultWeightPerItem != null && Number(packaging.defaultWeightPerItem) > 0) {
      return { show: false, count: 0 };
    }

    // Gia' chiuso: non si riapre.
    //
    // Tabella assente → risposta "chiuso", per la ragione spiegata in
    // `birthdate-dismissal.server.ts`: un avviso che il merchant non puo'
    // chiudere e' peggio di un avviso che non si vede.
    try {
      const dismissal = await prisma.shippingAlertDismissal.findUnique({
        where: { shopId },
        select: { dismissedAt: true },
      });

      if (dismissal) {
        return { show: false, count: 0 };
      }
    } catch (e) {
      if (tabellaAssente(e)) {
        return { show: false, count: 0 };
      }
      // Un guasto diverso si registra e si prosegue: non e' una ragione per
      // nascondere l'avviso se c'e' qualcosa da dire.
      console.warn(
        '[weight-alert] lettura dismissal non riuscita:',
        e instanceof Error ? e.message : 'errore sconosciuto',
      );
    }

    // Serve il token e il ref per interrogare il database del merchant.
    const shop = await prisma.shop.findUnique({
      where: { shopDomain },
      select: {
        id: true,
        supabaseConfig: {
          select: {
            connectionVerifiedAt: true,
            supabaseProjectRef: true,
          },
        },
      },
    });

    if (!shop?.supabaseConfig?.connectionVerifiedAt || !shop.supabaseConfig.supabaseProjectRef) {
      // Database non collegato: nessun avviso.
      return { show: false, count: 0 };
    }

    const token = await getValidAccessToken(shop.id);
    const ref = shop.supabaseConfig.supabaseProjectRef;

    // Conta ordini spediti e non annullati con peso mancante o zero.
    //
    // La query puo' fallire per varie ragioni: DB in pausa, colonne non ancora
    // presenti (schema update in corso), errori di rete. In ogni caso: conteggio
    // zero, nessun avviso. Non si blocca la dashboard per questo.
    //
    // isShipped() controlla fulfillment_status in ['FULFILLED', 'PARTIALLY_FULFILLED']
    // case-insensitive, come in logistics-cost.ts.
    const sql = `
      SELECT COUNT(*) as count
      FROM orders
      WHERE
        cancelled_at IS NULL
        AND UPPER(fulfillment_status) IN ('FULFILLED', 'PARTIALLY_FULFILLED')
        AND (total_weight_grams IS NULL OR total_weight_grams = 0)
    `;

    const result = await runQueryRows<{ count: string }>(token, ref, sql);
    const count = Number(result[0]?.count ?? 0);

    return count > 0 ? { show: true, count } : { show: false, count: 0 };
  } catch (e) {
    // Qualunque errore nel flusso sopra: non si mostra l'avviso.
    //
    // E si registra, perche' un errore che porta via silenziosamente una
    // funzione non si diagnostica.
    console.warn(
      '[weight-alert] controllo non riuscito:',
      e instanceof Error ? e.message : 'errore sconosciuto',
    );
    return { show: false, count: 0 };
  }
}

/**
 * Segna che l'avviso e' stato chiuso.
 *
 * Risponde se ha potuto scrivere. Chi chiama lo dice al merchant: far credere
 * che un "non mostrarmelo piu'" sia stato registrato quando non lo e' sarebbe
 * il peggiore degli esiti.
 */
export async function dismissWeightAlert(shopId: string): Promise<boolean> {
  try {
    await prisma.shippingAlertDismissal.upsert({
      where: { shopId },
      create: { shopId },
      update: { dismissedAt: new Date() },
    });
    return true;
  } catch (e) {
    if (!tabellaAssente(e)) {
      console.error(
        '[weight-alert] scrittura dismissal non riuscita:',
        e instanceof Error ? e.message : 'errore sconosciuto',
      );
    }
    return false;
  }
}
